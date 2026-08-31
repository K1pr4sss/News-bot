process.env.DB_PATH = ':memory:';
process.env.PAPER_STARTING_BALANCE_SOL = '1.0';
process.env.REQUIRE_SOCIALS = 'false';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../lib/db');
const executor = require('../lib/executor');
const positions = require('../lib/positions');

function insertOpenPosition(overrides = {}) {
  const base = {
    mint: 'TESTMINT', name: 'Test', symbol: 'TEST',
    entry_price_usd: 1.0, original_amount_sol: 0.1, remaining_amount_sol: 0.1,
    entry_score: 50, opened_at: Date.now(), max_hold_minutes: 999999,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO positions (mint, name, symbol, entry_price_usd, original_amount_sol, remaining_amount_sol, entry_score, opened_at, max_hold_minutes)
    VALUES (@mint, @name, @symbol, @entry_price_usd, @original_amount_sol, @remaining_amount_sol, @entry_score, @opened_at, @max_hold_minutes)
  `).run(base);
  return db.prepare('SELECT * FROM positions WHERE mint = ?').get(base.mint);
}

const flatScore = { score: 50, volumeRatio: 3 };

test('take-profit tier 1 sells 50% of original at +30%', async () => {
  const pos = insertOpenPosition({ mint: 'TP1' });
  await positions.evaluateExit(pos, { priceUsd: 1.30 }, flatScore);
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('TP1');
  assert.ok(Math.abs(row.remaining_amount_sol - 0.05) < 1e-9);
  assert.strictEqual(row.tp1_fired, 1);
  assert.strictEqual(row.status, 'open');
});

test('stop-loss at -20% closes the full remaining position', async () => {
  const pos = insertOpenPosition({ mint: 'SL' });
  await positions.evaluateExit(pos, { priceUsd: 0.79 }, flatScore); // -21%, clear of the -20% boundary to avoid float-precision flakiness at the exact threshold
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('SL');
  assert.strictEqual(row.remaining_amount_sol, 0);
  assert.strictEqual(row.status, 'closed');
});

test('take-profit ladder walks tier1 -> tier2 -> tier3 to fully closed', async () => {
  const pos1 = insertOpenPosition({ mint: 'LADDER' });
  await positions.evaluateExit(pos1, { priceUsd: 1.30 }, flatScore); // tier1: -50%
  const pos2 = db.prepare('SELECT * FROM positions WHERE mint = ?').get('LADDER');
  await positions.evaluateExit(pos2, { priceUsd: 1.60 }, flatScore); // tier2: -30% of original
  const pos3 = db.prepare('SELECT * FROM positions WHERE mint = ?').get('LADDER');
  assert.ok(Math.abs(pos3.remaining_amount_sol - 0.02) < 1e-9); // 0.1 - 0.05 - 0.03
  await positions.evaluateExit(pos3, { priceUsd: 2.00 }, flatScore); // tier3: remainder
  const pos4 = db.prepare('SELECT * FROM positions WHERE mint = ?').get('LADDER');
  assert.strictEqual(pos4.remaining_amount_sol, 0);
  assert.strictEqual(pos4.status, 'closed');
});

test('entry sizing matches the score-band table against live paper balance', async () => {
  const balanceBefore = executor.getBalanceSol();
  const entry = await positions.attemptEntry(
    { mint: 'ENTRY1', name: 'Entry', symbol: 'ENT', priceUsd: 1, liquidityUsd: 10000 },
    { score: 60 }, // 55-70 band -> 10%
  );
  assert.strictEqual(entry.tier.label, '55-70');
  assert.ok(Math.abs(entry.amountSol - balanceBefore * 0.10) < 1e-9);
});
