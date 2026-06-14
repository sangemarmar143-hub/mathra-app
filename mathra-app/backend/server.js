import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import db from './db.js';
import { signToken, requireAuth } from './auth.js';

const app = express();
const PORT = process.env.PORT || 4000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

const FREE_DAILY_LIMIT = 5; // free-tier messages per day

// Stripe webhook needs the raw body, so register it BEFORE express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const customerId = session.customer;
      const subscriptionId = session.subscription;
      db.prepare(
        `UPDATE users SET stripe_customer_id = ?, subscription_id = ?, subscription_status = 'active', plan = 'pro' WHERE id = ?`
      ).run(customerId, subscriptionId, userId);
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const status = sub.status; // active, canceled, past_due, etc.
      const plan = (status === 'active' || status === 'trialing') ? 'pro' : 'free';
      db.prepare(
        `UPDATE users SET subscription_status = ?, plan = ? WHERE subscription_id = ?`
      ).run(status, plan, sub.id);
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
});

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

app.post('/api/auth/signup', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email and password (6+ chars) required' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Account already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
  const user = { id: result.lastInsertRowid, email };

  res.json({ token: signToken(user), user: { email, plan: 'free' } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json({ token: signToken(user), user: { email: user.email, plan: user.plan } });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT email, plan, subscription_status FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// ---------------------------------------------------------------------------
// STRIPE CHECKOUT
// ---------------------------------------------------------------------------

// Creates a Checkout Session for the Pro subscription
app.post('/api/stripe/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // price ID for your Pro monthly plan
          quantity: 1,
        },
      ],
      customer_email: user.email,
      client_reference_id: String(user.id),
      success_url: `${process.env.FRONTEND_URL}/?checkout=success`,
      cancel_url: `${process.env.FRONTEND_URL}/?checkout=cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// Lets a user manage/cancel their subscription via Stripe's billing portal
app.post('/api/stripe/create-portal-session', requireAuth, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'No subscription on file' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create portal session' });
  }
});

// ---------------------------------------------------------------------------
// USAGE LIMITING
// ---------------------------------------------------------------------------

function checkAndIncrementUsage(userId, plan) {
  if (plan === 'pro') return { allowed: true };

  const today = new Date().toISOString().slice(0, 10);
  let row = db.prepare('SELECT * FROM usage WHERE user_id = ? AND day = ?').get(userId, today);

  if (!row) {
    db.prepare('INSERT INTO usage (user_id, day, message_count) VALUES (?, ?, 0)').run(userId, today);
    row = { message_count: 0 };
  }

  if (row.message_count >= FREE_DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  db.prepare('UPDATE usage SET message_count = message_count + 1 WHERE user_id = ? AND day = ?').run(userId, today);
  return { allowed: true, remaining: FREE_DAILY_LIMIT - row.message_count - 1 };
}

// ---------------------------------------------------------------------------
// CLAUDE PROXY (the gated AI tutor endpoint)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Mathra, an AI tutor specialized in Engineering Mathematics, helping undergraduate engineering students prepare for exams.

Your behavior rules:
1. Be precise and exam-focused. Students are revising under time pressure — prioritize clarity and exam-relevance over exhaustive theory.
2. When solving a problem, ALWAYS break it into clearly numbered steps. Format each major step using this exact pattern on its own lines:
   [STEP n: Short title]
   ... explanation/work for that step ...
3. When relevant, call out a common mistake students make using this exact pattern:
   [MISTAKE: short label]
   ... description of the mistake and how to avoid it ...
4. Explain WHY a method works, not just the mechanical steps — build intuition, especially for definitions and theorems.
5. Use LaTeX-free plain math notation that renders in plain text/markdown.
6. Keep responses focused — do not pad with unnecessary intros or conclusions.
7. If asked to generate practice questions, produce exam-style questions appropriate for the requested topic, with realistic difficulty for a B.Tech exam.
8. Be encouraging but not patronizing.
9. Stay strictly within Engineering Mathematics topics: Linear Algebra, Calculus, Differential Equations, Vector Calculus, Complex Analysis, Probability & Statistics, and Numerical Methods.`;

app.post('/api/tutor/chat', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const { messages, topic } = req.body;

  const usage = checkAndIncrementUsage(user.id, user.plan);
  if (!usage.allowed) {
    return res.status(402).json({
      error: 'Daily free limit reached',
      upgrade_required: true,
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT + (topic ? `\n\nThe student is currently focused on the topic: ${topic}.` : ''),
        messages,
      }),
    });

    const data = await response.json();
    const text = (data.content || []).map((b) => b.text || '').join('\n');

    res.json({
      reply: text,
      remaining: user.plan === 'pro' ? null : usage.remaining,
      plan: user.plan,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Tutor request failed' });
  }
});

app.post('/api/tutor/practice', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const { topic } = req.body;

  const usage = checkAndIncrementUsage(user.id, user.plan);
  if (!usage.allowed) {
    return res.status(402).json({ error: 'Daily free limit reached', upgrade_required: true });
  }

  const prompt = `Generate ONE exam-style practice question for the topic "${topic}" in Engineering Mathematics, appropriate difficulty for a B.Tech exam. Respond ONLY in JSON, no preamble, no markdown fences, in this exact format:
{"difficulty": "Easy|Medium|Hard", "question": "the question text", "hint": "a one-sentence hint"}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const raw = (data.content || []).map((b) => b.text || '').join('\n');
    const clean = raw.replace(/```json|```/g, '').trim();
    const question = JSON.parse(clean);

    res.json({ question, remaining: user.plan === 'pro' ? null : usage.remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Practice generation failed' });
  }
});

app.listen(PORT, () => console.log(`Mathra backend running on port ${PORT}`));
