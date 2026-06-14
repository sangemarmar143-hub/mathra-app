# Mathra — Paid AI Tutor Setup Guide

This package has two parts:
- `backend/` — Node.js/Express server (auth, Stripe, Claude proxy, usage limits)
- `frontend/` — the student-facing app (login + chat + practice)

## 1. Get your accounts ready

You'll need free accounts on:

1. **Anthropic Console** (https://console.anthropic.com) → create an API key
2. **Stripe** (https://stripe.com) → for payments
3. A hosting platform for the backend, e.g. **Render** (https://render.com) or **Railway** (https://railway.app)
4. A hosting platform for the frontend, e.g. **Vercel** (https://vercel.com) or **Netlify**

## 2. Set up Stripe

1. In the Stripe Dashboard, go to **Product Catalog → Add Product**
   - Name: "Mathra Pro"
   - Pricing: Recurring, e.g. ₹199/month
   - Copy the **Price ID** (starts with `price_...`)
2. Go to **Developers → API keys** → copy your **Secret key** (`sk_test_...` for testing, `sk_live_...` for production)
3. Go to **Developers → Webhooks → Add endpoint**
   - URL: `https://YOUR-BACKEND-URL/api/stripe/webhook`
   - Events to send: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** (`whsec_...`)

## 3. Configure the backend

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env` and fill in:
- `JWT_SECRET` — any long random string (e.g. generate with `openssl rand -hex 32`)
- `ANTHROPIC_API_KEY` — your Claude API key
- `STRIPE_SECRET_KEY` — from step 2
- `STRIPE_PRICE_ID` — from step 2
- `STRIPE_WEBHOOK_SECRET` — from step 2
- `FRONTEND_URL` — where your frontend will be hosted (e.g. `https://mathra.vercel.app`)

Run locally to test:
```bash
npm start
```
Server runs on `http://localhost:4000`.

## 4. Configure the frontend

Open `frontend/index.html` and update this line near the top of the `<script>`:

```js
const API_BASE = 'http://localhost:4000'; // change to your deployed backend URL
```

For local testing this is fine. For production, set it to your deployed backend's URL (e.g. `https://mathra-backend.onrender.com`).

## 5. Deploy the backend (Render example)

1. Push the `backend/` folder to a GitHub repo
2. In Render: **New → Web Service** → connect the repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add all the environment variables from your `.env` file in Render's dashboard
6. Once deployed, copy the live URL (e.g. `https://mathra-backend.onrender.com`)
7. Go back to Stripe webhook settings and update the endpoint URL to this live URL
8. Update `FRONTEND_URL` env var once your frontend is deployed too

## 6. Deploy the frontend (Vercel example)

1. Update `API_BASE` in `frontend/index.html` to your live backend URL
2. Push `frontend/` to a GitHub repo (or drag-and-drop the folder into Vercel/Netlify)
3. Deploy — you'll get a live URL like `https://mathra.vercel.app`
4. Update the backend's `FRONTEND_URL` env var to this URL and redeploy the backend

## 7. Test the full flow

1. Open your frontend URL → sign up with an email/password
2. Ask a few questions — after 5 per day, you should see the upgrade prompt
3. Click "Upgrade to Pro" → completes Stripe Checkout (use Stripe test card `4242 4242 4242 4242`)
4. After payment, refresh — your plan badge should switch to "pro" and usage limit disappears

## How the gating works

- **Free plan**: 5 tutor messages / practice generations per day (tracked in `usage` table by date)
- **Pro plan**: unlimited, set automatically via Stripe webhook when subscription becomes `active`
- The Claude API key never leaves your server — the frontend only talks to your backend

## Notes

- The database is SQLite (`mathra.db`), created automatically on first run. Fine for getting started; migrate to Postgres for production scale.
- To change the free daily limit, edit `FREE_DAILY_LIMIT` in `backend/server.js`.
- To change pricing, update the Stripe Product/Price — no code change needed, just update `STRIPE_PRICE_ID`.
