import Database from 'better-sqlite3';

const db = new Database('mathra.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    stripe_customer_id TEXT,
    subscription_status TEXT DEFAULT 'free',   -- 'free' | 'active' | 'canceled' | 'past_due'
    subscription_id TEXT,
    plan TEXT DEFAULT 'free',                  -- 'free' | 'pro'
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    day TEXT NOT NULL,            -- YYYY-MM-DD
    message_count INTEGER DEFAULT 0,
    UNIQUE(user_id, day),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

export default db;
