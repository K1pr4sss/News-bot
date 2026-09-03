process.env.DB_PATH = ':memory:';
process.env.PAPER_STARTING_BALANCE_SOL = '1.0';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../lib/db');
const executor = require('../lib/executor');
const dexscreener = require('../lib/dexscreener');
const positions = require('../lib/positions');

dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 2, liquidityUsd: 5000 });

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

test('stop-loss still fires immediately within the bearish-exit grace period (grace only shields the score/volume ladder, never real risk protection)', async () => {
  const pos = insertOpenPosition({ mint: 'SLGRACE', opened_at: Date.now() }); // brand new, well inside the 90s grace window
  await positions.evaluateExit(pos, { priceUsd: 0.79 }, flatScore); // -21%
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('SLGRACE');
  assert.strictEqual(row.status, 'closed', 'stop-loss must not be delayed by the bearish-exit grace period');
});

test('bearish score-exit ladder is held off within the grace period (regression: real live data showed 10/12 losing trades held only 19-35s - a near-threshold entry earns most of its score from a volume spike that fades by the very next exit-tick poll, killing the position before price has any chance to move) then fires once the grace period passes', async () => {
  const dyingScore = { score: 10, volumeRatio: 3 }; // clearly below the 40 exit threshold
  const freshPos = insertOpenPosition({ mint: 'GRACE1', opened_at: Date.now() }); // 0s old
  await positions.evaluateExit(freshPos, { priceUsd: 1.0 }, dyingScore); // flat price - isolates the score-exit branch
  const stillOpen = db.prepare('SELECT * FROM positions WHERE mint = ?').get('GRACE1');
  assert.strictEqual(stillOpen.status, 'open', 'should not have sold yet - still inside the grace period');
  assert.strictEqual(stillOpen.score_exit_fired, 0);

  const agedPos = { ...stillOpen, opened_at: Date.now() - 100 * 1000 }; // 100s old - past the 90s default grace
  await positions.evaluateExit(agedPos, { priceUsd: 1.0 }, dyingScore);
  const nowSold = db.prepare('SELECT * FROM positions WHERE mint = ?').get('GRACE1');
  assert.strictEqual(nowSold.score_exit_fired, 1, 'should have sold once the grace period passed');
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
  assert.strictEqual(entry.ok, true);
  assert.strictEqual(entry.tier.label, '55-70');
  assert.ok(Math.abs(entry.amountSol - balanceBefore * 0.10) < 1e-9);
});

test('attemptEntry buys at a FRESH price, not the stale one carried on the token object (regression: real P&L verification against a live trade - "pippo" - found the recorded entry price matched no point in the coin\'s real price history, off by ~3.8x. Root cause: discoveryTick evaluates a whole getNewPools() batch sequentially, so a candidate late in a large batch can be bought minutes after its price snapshot was taken. attemptEntry used to trust that stale token.priceUsd directly instead of re-fetching)', async () => {
  // Earlier tests in this file leave several positions open by design (see
  // the AUTOREBUY test's identical comment) - force a clean slate so this
  // test's own maxOpenPositions budget isn't consumed by unrelated tests.
  db.prepare("UPDATE positions SET status = 'closed' WHERE status = 'open'").run();

  const staleToken = {
    mint: 'STALEPRICE', name: 'Stale', symbol: 'STL', liquidityUsd: 10000, priceUsd: 999, // obviously wrong/stale - the real fetch (mocked to 2 for this file) must win
  };
  const entry = await positions.attemptEntry(staleToken, { score: 60 });
  assert.strictEqual(entry.ok, true, `entry should succeed, got: ${entry.reason}`);
  const row = db.prepare("SELECT * FROM positions WHERE mint = 'STALEPRICE'").get();
  // 2 (the mocked fresh price) plus the paper slippage haircut - nowhere
  // near 999 (the stale token.priceUsd), which is the actual point of this test.
  assert.ok(Math.abs(row.entry_price_usd - 2.02) < 0.01, `expected ~2.02 (freshly-fetched price + slippage), not the stale token.priceUsd (999) - got ${row.entry_price_usd}`);
});

test('two overlapping exit-ticks reading the same stale position only sell once (regression: real live bug - one position sold "70% of original" 36 times in 13 minutes instead of once, because overlapping async ticks each read remaining_amount_sol before the other had written it)', async () => {
  // opened_at pushed past the bearish-exit grace period (default 90s) -
  // otherwise the grace gate added later would return before this test's
  // score-exit branch ever ran, unrelated to the race condition being tested.
  const pos = insertOpenPosition({
    mint: 'RACE', original_amount_sol: 0.05, remaining_amount_sol: 0.05, opened_at: Date.now() - 200 * 1000,
  });
  // Two independent snapshots of the SAME row, exactly like two overlapping
  // getOpenPositions() calls would each return before either tick's write -
  // NOT the same object reference, which would defeat the point of the test.
  const snapshotA = { ...pos };
  const snapshotB = { ...pos };

  await Promise.all([
    // priceUsd === entry price (0% change) so neither stop-loss nor take-profit
    // fires first - isolates the score-exit branch (score < 40 -> sell 70% of original).
    positions.evaluateExit(snapshotA, { priceUsd: 1.0 }, { score: 10, volumeRatio: 3 }),
    positions.evaluateExit(snapshotB, { priceUsd: 1.0 }, { score: 10, volumeRatio: 3 }),
  ]);

  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('RACE');
  // 70% of 0.05 = 0.035 sold ONCE, not twice - remaining should be 0.015, not -0.02.
  assert.ok(Math.abs(row.remaining_amount_sol - 0.015) < 1e-9, `expected 0.015 remaining after exactly one 70% sell, got ${row.remaining_amount_sol}`);
  const sells = db.prepare("SELECT * FROM trades WHERE mint = 'RACE' AND side = 'sell'").all();
  assert.strictEqual(sells.length, 1, `expected exactly 1 recorded sell, got ${sells.length}`);
});

test('two overlapping entry-ticks evaluating the same brand-new mint only buy once (regression: attemptEntry\'s hasOpenPosition check was synchronous but executor.buy() was awaited before the position row existed to check against, so e.g. discoveryTick and pendingTick could both pass the check for the same mint moments apart and each independently buy)', async () => {
  const token = { mint: 'DOUBLEBUY', name: 'Double', symbol: 'DBL', priceUsd: 1, liquidityUsd: 10000 };
  const score = { score: 60 };

  const [resultA, resultB] = await Promise.all([
    positions.attemptEntry(token, score),
    positions.attemptEntry(token, score),
  ]);

  const successes = [resultA, resultB].filter((r) => r.ok);
  assert.strictEqual(successes.length, 1, `expected exactly one of the two concurrent entries to succeed, got ${successes.length}`);
  const failure = [resultA, resultB].find((r) => !r.ok);
  assert.ok(failure.reason, 'the losing concurrent entry should report why, not just fail silently');

  const rows = db.prepare("SELECT * FROM positions WHERE mint = 'DOUBLEBUY'").all();
  assert.strictEqual(rows.length, 1, `expected exactly 1 position row, got ${rows.length}`);
  const buys = db.prepare("SELECT * FROM trades WHERE mint = 'DOUBLEBUY' AND side = 'buy'").all();
  assert.strictEqual(buys.length, 1, `expected exactly 1 recorded buy, got ${buys.length}`);
});

test('a mint can be manually re-bought after its first position fully closes (regression: positions.mint used to be a PRIMARY KEY, which crashed on this exact sequence)', async () => {
  const first = await positions.attemptManualBuy('REBUY', 0.01);
  assert.strictEqual(first.ok, true);
  const sellResult = await positions.attemptManualSell('REBUY');
  assert.strictEqual(sellResult.ok, true);

  const second = await positions.attemptManualBuy('REBUY', 0.01);
  assert.strictEqual(second.ok, true, `second buy should succeed, got: ${second.reason}`);

  const rows = db.prepare('SELECT * FROM positions WHERE mint = ?').all('REBUY');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].status, 'closed');
  assert.strictEqual(rows[1].status, 'open');
});

test('attemptEntry (the automated path) can re-buy a mint bought earlier the same day - the 24h re-buy cooldown was removed by user request after real alerts were seen getting blocked purely on cooldown despite still scoring well (e.g. "bought within the last 24h" on a 65/100 candidate)', async () => {
  // Earlier tests in this file leave several positions open (by design -
  // they're testing partial-sell/race behavior, not full lifecycles), which
  // would otherwise trip the UNRELATED maxOpenPositions guard here. Force a
  // clean slate first - this test only cares about the re-buy cooldown gate.
  db.prepare("UPDATE positions SET status = 'closed' WHERE status = 'open'").run();

  const token = {
    mint: 'AUTOREBUY', name: 'AutoRebuy', symbol: 'ARB', priceUsd: 1, liquidityUsd: 10000,
  };
  const score = { score: 60 };

  const first = await positions.attemptEntry(token, score);
  assert.strictEqual(first.ok, true, `first entry should succeed, got: ${first.reason}`);
  // Close at a PROFIT specifically - this test is about the (now-disabled)
  // blanket rebuyCooldownHours, not the separate loss-rebuy cooldown below.
  // The file's module-level mock (priceUsd:2, ±1% slippage) would otherwise
  // make this close a small real loss and trip that unrelated guard.
  dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 3, liquidityUsd: 5000 });
  const closed = await positions.attemptManualSell('AUTOREBUY');
  assert.strictEqual(closed.ok, true, `closing the first position should succeed, got: ${closed.reason}`);
  dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 2, liquidityUsd: 5000 }); // restore the file's default mock

  const second = await positions.attemptEntry(token, score);
  assert.strictEqual(second.ok, true, `re-buy should not be blocked by the (now-disabled) rebuy cooldown, got: ${second.reason}`);
});

test('a mint closed at a LOSS cannot be re-bought within the loss-rebuy cooldown window (regression: real live data showed "Pumpooor" bought and re-bought 9 times in one hour after the blanket cooldown was removed, losing a little almost every round trip to fees/slippage)', async () => {
  db.prepare("UPDATE positions SET status = 'closed' WHERE status = 'open'").run();
  const token = {
    mint: 'LOSSREBUY', name: 'LossRebuy', symbol: 'LRB', priceUsd: 1, liquidityUsd: 10000,
  };
  const score = { score: 60 };

  const first = await positions.attemptEntry(token, score);
  assert.strictEqual(first.ok, true, `first entry should succeed, got: ${first.reason}`);
  // File default mock (priceUsd:2, ±1% slippage) makes this close a real
  // loss (sell fills at 1.98, below the 2.02 entry) - exactly what should
  // trip the new guard.
  const closed = await positions.attemptManualSell('LOSSREBUY');
  assert.strictEqual(closed.ok, true, `closing the first position should succeed, got: ${closed.reason}`);

  const second = await positions.attemptEntry(token, score);
  assert.strictEqual(second.ok, false, 'a mint that just closed at a loss should not be immediately re-buyable');
  assert.match(second.reason, /loss re-buy cooldown/);
});

test('a mint closed at a PROFIT is never touched by the loss-rebuy cooldown, even seconds later', async () => {
  db.prepare("UPDATE positions SET status = 'closed' WHERE status = 'open'").run();
  const token = {
    mint: 'PROFITREBUY', name: 'ProfitRebuy', symbol: 'PRB', priceUsd: 1, liquidityUsd: 10000,
  };
  const score = { score: 60 };

  const first = await positions.attemptEntry(token, score);
  assert.strictEqual(first.ok, true, `first entry should succeed, got: ${first.reason}`);
  dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 3, liquidityUsd: 5000 }); // real profit on close
  const closed = await positions.attemptManualSell('PROFITREBUY');
  assert.strictEqual(closed.ok, true, `closing the first position should succeed, got: ${closed.reason}`);
  dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 2, liquidityUsd: 5000 }); // restore the file's default mock

  const second = await positions.attemptEntry(token, score);
  assert.strictEqual(second.ok, true, `a mint that closed at a real profit should be immediately re-buyable, got: ${second.reason}`);
});
