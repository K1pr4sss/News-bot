const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const logger = require('./logger');

const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    name TEXT,
    symbol TEXT,
    side TEXT NOT NULL,
    fraction REAL,
    amount_sol REAL NOT NULL,
    price_usd REAL,
    score INTEGER,
    reason TEXT,
    realized_pnl_sol REAL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS positions (
    mint TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    entry_price_usd REAL NOT NULL,
    original_amount_sol REAL NOT NULL,
    remaining_amount_sol REAL NOT NULL,
    entry_score INTEGER NOT NULL,
    tier_index INTEGER NOT NULL DEFAULT 0,
    peak_change_pct REAL NOT NULL DEFAULT 0,
    opened_at INTEGER NOT NULL,
    max_hold_minutes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    score_exit_fired INTEGER NOT NULL DEFAULT 0,
    volume_exit_fired INTEGER NOT NULL DEFAULT 0,
    tp1_fired INTEGER NOT NULL DEFAULT 0,
    tp2_fired INTEGER NOT NULL DEFAULT 0,
    tp3_fired INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS paper_wallet (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance_sol REAL NOT NULL
  );
`);

// Seed the paper wallet balance exactly once - re-running the app must not reset it.
const existingWallet = db.prepare('SELECT balance_sol FROM paper_wallet WHERE id = 1').get();
if (!existingWallet) {
  db.prepare('INSERT INTO paper_wallet (id, balance_sol) VALUES (1, ?)').run(config.paperStartingBalanceSol);
  logger.info('Paper wallet initialized', { balanceSol: config.paperStartingBalanceSol });
}

module.exports = db;
