const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const logger = require('./logger');

const dbDir = path.dirname(config.dbPath);
try {
  fs.mkdirSync(dbDir, { recursive: true });
} catch (err) {
  logger.error('Failed to create/access DB directory', { dbDir, error: err.message });
}

let db;
try {
  db = new DatabaseSync(config.dbPath);
} catch (err) {
  // Diagnostic dump before crashing for real - "unable to open database file"
  // can mean the mount isn't attached yet, a permissions mismatch on a fresh
  // volume, or the path just being wrong; logging what's ACTUALLY on disk
  // beats guessing at the fix blind.
  let dirListing = null;
  let dirStat = null;
  try { dirListing = fs.readdirSync(dbDir); } catch (e) { dirListing = `readdir failed: ${e.message}`; }
  try { dirStat = fs.statSync(dbDir); } catch (e) { dirStat = `stat failed: ${e.message}`; }
  logger.error('Failed to open SQLite database', {
    dbPath: config.dbPath, dbDir, dirListing, dirStat, error: err.message,
  });
  throw err;
}

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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    name TEXT,
    symbol TEXT,
    entry_price_usd REAL NOT NULL,
    original_amount_sol REAL NOT NULL,
    remaining_amount_sol REAL NOT NULL,
    entry_score INTEGER,
    tier_index INTEGER NOT NULL DEFAULT 0,
    peak_change_pct REAL NOT NULL DEFAULT 0,
    opened_at INTEGER NOT NULL,
    max_hold_minutes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    score_exit_fired INTEGER NOT NULL DEFAULT 0,
    volume_exit_fired INTEGER NOT NULL DEFAULT 0,
    tp1_fired INTEGER NOT NULL DEFAULT 0,
    tp2_fired INTEGER NOT NULL DEFAULT 0,
    tp3_fired INTEGER NOT NULL DEFAULT 0,
    entry_socials_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS paper_wallet (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance_sol REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// CREATE TABLE IF NOT EXISTS only handles a brand-new DB - an already-existing
// positions table (e.g. the live Railway volume) needs an explicit migration
// to pick up a column added after it was first created.
const positionsColumns = db.prepare('PRAGMA table_info(positions)').all().map((c) => c.name);
if (!positionsColumns.includes('entry_socials_count')) {
  db.exec('ALTER TABLE positions ADD COLUMN entry_socials_count INTEGER NOT NULL DEFAULT 0');
  logger.info('Migrated positions table: added entry_socials_count column');
}

function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Seed the paper wallet balance exactly once - re-running the app must not reset it.
const existingWallet = db.prepare('SELECT balance_sol FROM paper_wallet WHERE id = 1').get();
if (!existingWallet) {
  db.prepare('INSERT INTO paper_wallet (id, balance_sol) VALUES (1, ?)').run(config.paperStartingBalanceSol);
  logger.info('Paper wallet initialized', { balanceSol: config.paperStartingBalanceSol });
}

module.exports = db;
module.exports.getMeta = getMeta;
module.exports.setMeta = setMeta;
