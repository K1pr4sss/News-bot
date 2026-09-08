process.env.DB_PATH = ':memory:';
process.env.PAPER_STARTING_BALANCE_SOL = '1.0';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../lib/db');
const executor = require('../lib/executor');
const dexscreener = require('../lib/dexscreener');
const positions = require('../lib/positions');
const config = require('../lib/config');

dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 2, liquidityUsd: 5000 });

function insertOpenPosition(overrides = {}) {
  const base = {
    mint: 'TESTMINT', name: 'Test', symbol: 'TEST',
    entry_price_usd: 1.0, original_amount_sol: 0.1, remaining_amount_sol: 0.1,
    entry_score: 50, opened_at: Date.now(), max_hold_minutes: 999999, tp1_fired: 0,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO positions (mint, name, symbol, entry_price_usd, original_amount_sol, remaining_amount_sol, entry_score, opened_at, max_hold_minutes, tp1_fired)
    VALUES (@mint, @name, @symbol, @entry_price_usd, @original_amount_sol, @remaining_amount_sol, @entry_score, @opened_at, @max_hold_minutes, @tp1_fired)
  `).run(base);
  return db.prepare('SELECT * FROM positions WHERE mint = ?').get(base.mint);
}

const flatScore = { score: 50, volumeRatio: 3 };

// The 30/60/100 ladder is gone. Race-testing real price paths with realistic
// friction (stop overshoot, slippage, flat fee) gave +40/-35 a train EV of
// +7.5% and test EV of +4.3%, while the old +30/-20 was negative in BOTH halves
// (-2.9 / -2.6). +40% is the peak at every stop level and everything at +50%+
// is negative in both halves, so "let winners run" is actively wrong here.
test('take-profit closes the WHOLE position in one exit at +40%', async () => {
  const pos = insertOpenPosition({ mint: 'TP1' });
  await positions.evaluateExit(pos, { priceUsd: 1.30 }, flatScore); // +30% - below the new tier
  assert.strictEqual(db.prepare('SELECT * FROM positions WHERE mint = ?').get('TP1').status, 'open', '+30% must no longer trigger anything');

  await positions.evaluateExit(pos, { priceUsd: 1.42 }, flatScore); // +42%
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('TP1');
  assert.strictEqual(row.remaining_amount_sol, 0, 'the whole position closes - no remainder to give back');
  assert.strictEqual(row.status, 'closed');
  const sells = db.prepare("SELECT * FROM trades WHERE mint = 'TP1' AND side = 'sell'").all();
  assert.strictEqual(sells.length, 1, 'one exit, one fee leg');
});

test('stop-loss closes the full remaining position', async () => {
  const pos = insertOpenPosition({ mint: 'SL' });
  await positions.evaluateExit(pos, { priceUsd: 0.60 }, flatScore); // -40%, clear of the -35% boundary to avoid float-precision flakiness at the exact threshold
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('SL');
  assert.strictEqual(row.remaining_amount_sol, 0);
  assert.strictEqual(row.status, 'closed');
});

test('stop-loss still fires immediately inside the thesis-cut window (the cut delay must never delay real risk protection)', async () => {
  const pos = insertOpenPosition({ mint: 'SLGRACE', opened_at: Date.now() }); // brand new, well inside the 10min window
  await positions.evaluateExit(pos, { priceUsd: 0.60 }, flatScore); // -40%
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('SLGRACE');
  assert.strictEqual(row.status, 'closed', 'stop-loss must not be delayed by the thesis-cut timer');
});

// Replaces the old "bearish score-exit ladder" tests. That ladder killed 90%
// of all real positions (112/125, -0.443 SOL) because it fired off an absolute
// score threshold that transient volume-spike decay guaranteed would be
// crossed - 92% of its exits landed within 30s of the grace period expiring,
// making it a timer rather than a signal. These three tests pin the properties
// that actually distinguish the replacement.
test('thesis cut does NOT fire on a position that is UP, no matter how far the hype score has fallen', async () => {
  const deadScore = { score: 0, volumeRatio: 0 }; // total score collapse - the old ladder would have sold instantly
  const pos = insertOpenPosition({ mint: 'WINNER', opened_at: Date.now() - 60 * 60 * 1000 }); // an hour old, well past the cut delay
  await positions.evaluateExit(pos, { priceUsd: 1.25 }, deadScore); // +25%, below the +30% tier-1 trigger
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('WINNER');
  assert.strictEqual(row.status, 'open', 'a profitable position must survive a score collapse - this precondition is the whole fix');
  assert.ok(Math.abs(row.remaining_amount_sol - 0.1) < 1e-9, 'nothing should have been sold');
});

test('the thesis cut is DISABLED by default - it was tuned against blow-off entries and costs 1.7pp against the mild-momentum band the bot now buys (live: 11 of the first 13 exits were thesis cuts, most on flat positions, each paying a full round trip to close a trade that had not done anything)', async () => {
  assert.strictEqual(config.thesisCutAfterMinutes, 0);
  const aged = insertOpenPosition({ mint: 'CUT0', opened_at: Date.now() - 60 * 60 * 1000 });
  await positions.evaluateExit(aged, { priceUsd: 0.95 }, flatScore); // -5% and an hour old
  assert.strictEqual(
    db.prepare('SELECT * FROM positions WHERE mint = ?').get('CUT0').status, 'open',
    'a losing position must now be judged by the stop and max-hold, not closed for being flat',
  );
});

test('when explicitly re-enabled, the thesis cut still holds off until the delay and closes in ONE sell', async () => {
  const original = config.thesisCutAfterMinutes;
  config.thesisCutAfterMinutes = 10;
  try {
    const fresh = insertOpenPosition({ mint: 'CUT1', opened_at: Date.now() }); // 0min old
    await positions.evaluateExit(fresh, { priceUsd: 0.95 }, flatScore); // -5%, losing but too young
    const stillOpen = db.prepare('SELECT * FROM positions WHERE mint = ?').get('CUT1');
    assert.strictEqual(stillOpen.status, 'open', 'should not cut before thesisCutAfterMinutes');

    const aged = { ...stillOpen, opened_at: Date.now() - 11 * 60 * 1000 }; // past the delay
    await positions.evaluateExit(aged, { priceUsd: 0.95 }, flatScore);
    const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('CUT1');
    assert.strictEqual(row.status, 'closed');
    assert.strictEqual(row.remaining_amount_sol, 0);
    const sells = db.prepare("SELECT * FROM trades WHERE mint = ? AND side = 'sell'").all('CUT1');
    assert.strictEqual(sells.length, 1, 'must close in a single sell - the old 70%-then-30% two-step burned an extra fee leg on every loser');
  } finally {
    config.thesisCutAfterMinutes = original;
  }
});

test('the thesis cut never fires on a position that has banked a take-profit - the breakeven stop governs it instead', async () => {
  // A position that took profit and is now UP stays open: the cut is skipped
  // (tp1_fired) and it is above the breakeven stop.
  const up = insertOpenPosition({ mint: 'CUT2', opened_at: Date.now() - 30 * 60 * 1000, tp1_fired: 1 });
  await positions.evaluateExit(up, { priceUsd: 1.10 }, flatScore);
  assert.strictEqual(db.prepare('SELECT * FROM positions WHERE mint = ?').get('CUT2').status, 'open');

  // Below breakeven it closes - but via the breakeven stop, NOT the thesis cut,
  // and that distinction is the point: it would close even if it were brand new.
  const down = insertOpenPosition({ mint: 'CUT3', opened_at: Date.now(), tp1_fired: 1 });
  await positions.evaluateExit(down, { priceUsd: 0.95 }, flatScore);
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('CUT3');
  assert.strictEqual(row.status, 'closed');
  const sells = db.prepare("SELECT reason FROM trades WHERE mint = 'CUT3' AND side = 'sell'").all();
  assert.ok(/breakeven stop/.test(sells[0].reason), `expected the breakeven stop, not the cut - got: ${sells[0].reason}`);
});

// index.js's exitTick now calls evaluateExit with price ONLY - no score - so
// it can skip the rate-limited GeckoTerminal lookup that was costing 0.125 SOL
// in stop-loss latency (5 of 7 real stops fired late, not on a price gap; Dark
// Arena breached -25% and sold 157s later at -90.8%). Every exit rule must
// therefore work with no score in hand.
test('every exit rule works with price alone, no hype score supplied (the shape exitTick actually calls)', async () => {
  const sl = insertOpenPosition({ mint: 'NOSCORE_SL' });
  await positions.evaluateExit(sl, { priceUsd: 0.60 }); // -40%, no third argument at all
  assert.strictEqual(db.prepare('SELECT * FROM positions WHERE mint = ?').get('NOSCORE_SL').status, 'closed');

  const tp = insertOpenPosition({ mint: 'NOSCORE_TP' });
  await positions.evaluateExit(tp, { priceUsd: 1.42 }); // +42%, past the single +40% tier
  assert.strictEqual(db.prepare('SELECT * FROM positions WHERE mint = ?').get('NOSCORE_TP').status, 'closed');

  const original = config.thesisCutAfterMinutes;
  config.thesisCutAfterMinutes = 10; // disabled by default; exercised here for the no-score path
  const cut = insertOpenPosition({ mint: 'NOSCORE_CUT', opened_at: Date.now() - 11 * 60 * 1000 });
  try {
    await positions.evaluateExit(cut, { priceUsd: 0.95 }); // losing, past the cut delay
  } finally {
    config.thesisCutAfterMinutes = original;
  }
  assert.strictEqual(db.prepare('SELECT * FROM positions WHERE mint = ?').get('NOSCORE_CUT').status, 'closed');

  // and the recorded score is a clean null rather than the string "undefined"
  const sells = db.prepare("SELECT score FROM trades WHERE mint = 'NOSCORE_CUT' AND side = 'sell'").all();
  assert.strictEqual(sells.length, 1);
  assert.strictEqual(sells[0].score, null);
});

// Real measured cost of not having this guard: across 13 live entries, fills
// averaged 5.7% ABOVE the market bar's open on top of the 1% slippage, and 3 of
// 13 filled above the bar's HIGH entirely. On a bot whose round-trip friction
// is already ~6%, that is indefensible regardless of strategy.
test('does not chase - skips the buy when the price ran away between evaluation and execution', async () => {
  // maxOpenPositions is now 3 (raised sizing, held exposure flat), so earlier
  // tests leaving positions open can exhaust the budget before this one runs.
  db.prepare("UPDATE positions SET status = 'closed' WHERE status = 'open'").run();
  // Snapshot and restore: the accepting cases below really do buy, and the
  // sizing test later in this file asserts against an exact paper balance.
  const balanceBefore = executor.getBalanceSol();

  // evaluated at 1.0, executing at 2.0 = +100% drift, far over the 3% cap
  const ran = await positions.attemptEntry({ mint: 'CHASE1', name: 'x', symbol: 'x', priceUsd: 1.0 }, { score: 50 });
  assert.strictEqual(ran.ok, false);
  assert.ok(/not chasing/.test(ran.reason), `expected a chase rejection, got: ${ran.reason}`);
  assert.ok(!db.prepare("SELECT 1 FROM positions WHERE mint = 'CHASE1'").get(), 'no position may be opened');

  // For the accepting cases, assert on the GUARD specifically rather than on
  // ok:true - other unrelated gates (max open positions, balance) depend on
  // whatever earlier tests in this file happened to leave behind, and this
  // test is about the drift check, not about them.
  const ok = await positions.attemptEntry({ mint: 'CHASE2', name: 'x', symbol: 'x', priceUsd: 1.98 }, { score: 50 });
  assert.ok(!/not chasing/.test(ok.reason || ''), `a small upward drift inside the cap must not trip the guard, got: ${ok.reason}`);

  // a price that MOVED DOWN since evaluation is the good case - never blocked
  const cheaper = await positions.attemptEntry({ mint: 'CHASE3', name: 'x', symbol: 'x', priceUsd: 99 }, { score: 50 });
  assert.ok(!/not chasing/.test(cheaper.reason || ''), `a cheaper price must never trip the guard, got: ${cheaper.reason}`);

  db.prepare("DELETE FROM positions WHERE mint IN ('CHASE1','CHASE2','CHASE3')").run();
  db.prepare("DELETE FROM trades WHERE mint IN ('CHASE1','CHASE2','CHASE3')").run();
  db.prepare('UPDATE paper_wallet SET balance_sol = ? WHERE id = 1').run(balanceBefore);
});

// The single worst hole in the payoff arithmetic: the ladder sells only 50% at
// +30%, so a coin that WORKS and then reverses nets about -1% of position
// because the unsold half rides to a stop that really fills near -28%. Real
// cases: phantom took +48% then stopped at -44.3%; UMI took +30% and +62% then
// stopped at -29%. Worth +0.0117 SOL and +3pp win rate across 108 replayed
// positions.
test('once a take-profit has fired, the remainder is protected at breakeven instead of riding to the full stop', async () => {
  // Take-profit tiers now close 100%, so production never leaves a remainder.
  // The breakeven guard remains as protection for any partial-tier config, and
  // is tested by seeding that state directly.
  const afterTp = insertOpenPosition({ mint: 'BE1', tp1_fired: 1, remaining_amount_sol: 0.05 });

  // -5% would be nowhere near the -20% rule, but it IS below breakeven, so the
  // protected remainder must close rather than ride back down.
  await positions.evaluateExit(afterTp, { priceUsd: 0.95 });
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('BE1');
  assert.strictEqual(row.status, 'closed', 'a banked winner must not be allowed to become a loser');
  const sells = db.prepare("SELECT reason FROM trades WHERE mint = 'BE1' AND side = 'sell'").all();
  assert.ok(/breakeven stop/.test(sells[sells.length - 1].reason), `expected a breakeven-stop exit, got: ${sells[sells.length - 1].reason}`);
});

test('the breakeven stop does NOT apply before any take-profit has fired', async () => {
  const pos = insertOpenPosition({ mint: 'BE2', opened_at: Date.now() });
  // -5%, losing but nothing banked yet and too young for the thesis cut:
  // the full -20% stop still governs, so this must stay open.
  await positions.evaluateExit(pos, { priceUsd: 0.95 });
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('BE2');
  assert.strictEqual(row.status, 'open', 'an unproven position keeps the full stop, not the breakeven one');
});

// The single most damaging pattern across all 145 historical positions: after
// the first attempt at a mint, the win rate collapses to ~0 (81 re-buys, ONE
// winner between them). OTC was bought 20x and never won. Capping at one per
// mint would have moved the account from -0.420 to -0.031 SOL and cut 419 trade
// legs to 183 - which matters doubly, since flat fees (0.419 SOL) account for
// essentially the entire historical loss.
test('a mint cannot be bought twice in a day - re-buys of the same coin have a ~0% win rate', async () => {
  db.prepare("UPDATE positions SET status = 'closed' WHERE status = 'open'").run();
  const balanceBefore = executor.getBalanceSol();
  const token = { mint: 'ONEPERDAY', name: 'x', symbol: 'OPD', priceUsd: 2, liquidityUsd: 10000 };

  const first = await positions.attemptEntry(token, { score: 50 });
  assert.strictEqual(first.ok, true, `first entry should succeed, got: ${first.reason}`);

  // Close it at a PROFIT, so neither the loss-cooldown nor the open-position
  // guard can be what blocks the second attempt - it has to be this cap.
  dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 4, liquidityUsd: 5000 });
  await positions.attemptManualSell('ONEPERDAY');
  assert.ok(
    db.prepare("SELECT realized_pnl_sol FROM trades WHERE mint='ONEPERDAY' AND side='sell'").get().realized_pnl_sol > 0,
    'setup: the close must be profitable for this test to prove what it claims',
  );
  dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 2, liquidityUsd: 5000 });

  const second = await positions.attemptEntry(token, { score: 50 });
  assert.strictEqual(second.ok, false, 'a second position in the same mint must be blocked even after a WINNING close');
  assert.ok(/position\(s\) in this mint today/.test(second.reason), `expected the per-mint cap, got: ${second.reason}`);

  db.prepare("DELETE FROM positions WHERE mint = 'ONEPERDAY'").run();
  db.prepare("DELETE FROM trades WHERE mint = 'ONEPERDAY'").run();
  db.prepare('UPDATE paper_wallet SET balance_sol = ? WHERE id = 1').run(balanceBefore);
});

test('a price that jumps straight past several tiers still closes exactly once', async () => {
  // All three tiers now sell 100%, so whichever is reached first closes the
  // position. A gap from entry to +150% must not produce three sells.
  const pos = insertOpenPosition({ mint: 'LADDER' });
  await positions.evaluateExit(pos, { priceUsd: 2.50 }, flatScore); // +150%, past every tier
  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('LADDER');
  assert.strictEqual(row.remaining_amount_sol, 0);
  assert.strictEqual(row.status, 'closed');
  const sells = db.prepare("SELECT * FROM trades WHERE mint = 'LADDER' AND side = 'sell'").all();
  assert.strictEqual(sells.length, 1, `a gap past all tiers must still be ONE sell, got ${sells.length}`);
});

test('entry sizing matches the score-band table against live paper balance', async () => {
  // maxOpenPositions is now 3 (raised sizing, held exposure flat), so earlier
  // tests leaving positions open can exhaust the budget before this one runs.
  db.prepare("UPDATE positions SET status = 'closed' WHERE status = 'open'").run();
  const balanceBefore = executor.getBalanceSol();
  const entry = await positions.attemptEntry(
    { mint: 'ENTRY1', name: 'Entry', symbol: 'ENT', priceUsd: 2, liquidityUsd: 10000 },
    { score: 60 }, // 55-70 band
  );
  assert.strictEqual(entry.ok, true);
  assert.strictEqual(entry.tier.label, '55-70');
  // Asserted against config rather than a literal: what this test protects is
  // that the score lands in the right BAND and that the band's fraction is the
  // one applied, not any particular tuning of that fraction.
  assert.ok(Math.abs(entry.amountSol - balanceBefore * config.sizeTier2Pct) < 1e-9);
});

test('size tiers are flat - the score does not earn a bigger bet (higher-score trades died more often and lost more, in both halves of the sample)', () => {
  assert.strictEqual(config.sizeTier2Pct, config.sizeTier1Pct);
  assert.strictEqual(config.sizeTier3Pct, config.sizeTier1Pct);
});

test('position size stays inside the range that survives the realised return distribution (12% bootstrapped to a 100% chance of losing 90%+ of the account over 400 trades; the measured per-trade mean is -10.5% with a 95% CI excluding zero)', () => {
  assert.ok(config.sizeTier1Pct <= 0.06, 'sizing above ~6% is ruinous against the observed fat left tail');
  // ...and the floor must not be set so high that it silently halts trading:
  // at this fraction it has to clear on a balance the bot actually has.
  assert.ok(config.minPositionSol < config.sizeTier1Pct * 0.5,
    'minPositionSol must be reachable at the current size fraction, or the bot freezes itself');
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
  // Driven through take-profit tier 1 rather than the old bearish score-exit,
  // which no longer exists (see the thesis-cut tests above). Deliberately a
  // PARTIAL sell: a full close would leave remaining at 0 either way, which
  // would let a genuinely broken CAS still pass this test. A 50% slice sold
  // twice lands at a visibly wrong remaining, so the assertion has teeth.
  const pos = insertOpenPosition({
    mint: 'RACE', original_amount_sol: 0.05, remaining_amount_sol: 0.05, opened_at: Date.now() - 200 * 1000,
  });
  // Two independent snapshots of the SAME row, exactly like two overlapping
  // getOpenPositions() calls would each return before either tick's write -
  // NOT the same object reference, which would defeat the point of the test.
  const snapshotA = { ...pos };
  const snapshotB = { ...pos };

  await Promise.all([
    // -40%: both snapshots read the same remaining_amount_sol and both reach
    // sellFraction, so the compare-and-swap there is the only thing preventing
    // a double sell. Driven through the stop-loss rather than a partial tier
    // because take-profit tiers now close 100% and leave no partial to race on.
    positions.evaluateExit(snapshotA, { priceUsd: 0.60 }, flatScore),
    positions.evaluateExit(snapshotB, { priceUsd: 0.60 }, flatScore),
  ]);

  const row = db.prepare('SELECT * FROM positions WHERE mint = ?').get('RACE');
  assert.strictEqual(row.remaining_amount_sol, 0);
  assert.strictEqual(row.status, 'closed');
  // The real assertion: the second overlapping tick must be rejected by the CAS
  // rather than recording a second sell of an already-sold position.
  const sells = db.prepare("SELECT * FROM trades WHERE mint = 'RACE' AND side = 'sell'").all();
  assert.strictEqual(sells.length, 1, `expected exactly 1 recorded sell, got ${sells.length}`);
});

test('realized P&L accounts for the BUY-side fee too (regression: reported P&L and the real wallet balance disagreed by exactly one paperFeeSol per position - 0.125 SOL across 125 real positions - because executor.sell only netted the sell-side fee, hiding half the account\'s true loss)', async () => {
  const before = executor.getBalanceSol();
  // entry_price_usd matches what the mocked dexscreener returns, so this is a
  // FLAT round trip: with zero price movement the only thing P&L can reflect
  // is friction - both fee legs plus the slippage haircut - which makes a
  // missing fee show up as a clean, unambiguous discrepancy.
  const pos = insertOpenPosition({
    mint: 'FEEACCT', entry_price_usd: 2, original_amount_sol: 0.1, remaining_amount_sol: 0.1,
  });
  await positions.attemptManualSell('FEEACCT');
  const sells = db.prepare("SELECT * FROM trades WHERE mint = 'FEEACCT' AND side = 'sell'").all();
  assert.strictEqual(sells.length, 1);

  // The buy leg was inserted directly by the test helper, so simulate only the
  // sell side's effect on the balance and check P&L reconciles against it.
  const balanceDelta = executor.getBalanceSol() - before;
  const reported = sells[0].realized_pnl_sol;
  // proceeds credited to the wallet = cost + reportedPnl + buyFeeShare, i.e.
  // the reported figure must be one full buy fee BELOW the raw wallet movement.
  assert.ok(
    Math.abs((balanceDelta - 0.1) - (reported + 0.001)) < 1e-9,
    `reported P&L (${reported}) should be exactly one buy fee below the wallet's own accounting (${balanceDelta - 0.1})`,
  );
  assert.ok(reported < 0, 'a flat round trip must show a LOSS once both fee legs and slippage are counted');
});

test('two overlapping entry-ticks evaluating the same brand-new mint only buy once (regression: attemptEntry\'s hasOpenPosition check was synchronous but executor.buy() was awaited before the position row existed to check against, so e.g. discoveryTick and pendingTick could both pass the check for the same mint moments apart and each independently buy)', async () => {
  const token = { mint: 'DOUBLEBUY', name: 'Double', symbol: 'DBL', priceUsd: 2, liquidityUsd: 10000 };
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
    mint: 'AUTOREBUY', name: 'AutoRebuy', symbol: 'ARB', priceUsd: 2, liquidityUsd: 10000,
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
  // The blanket rebuyCooldownHours is still disabled and must not be what
  // blocks this. But a re-buy IS now blocked, by maxPositionsPerMintPerDay -
  // and that supersedes the earlier decision to allow same-day re-buys, on
  // evidence rather than preference. Reviewing all 145 historical positions:
  // 81 re-buys produced ONE winner, and the specific case that decision was
  // protecting - a coin re-scoring well - did no better (re-buys scoring 60+:
  // n=14, P&L -0.074, 0% win). Re-buys after a WINNING close also went 0/3.
  assert.strictEqual(second.ok, false);
  assert.ok(
    !/re-buy cooldown/.test(second.reason),
    `the blanket cooldown must stay disabled - it should not be the blocker, got: ${second.reason}`,
  );
  assert.match(second.reason, /position\(s\) in this mint today/);
});

test('a mint closed at a LOSS cannot be re-bought within the loss-rebuy cooldown window (regression: real live data showed "Pumpooor" bought and re-bought 9 times in one hour after the blanket cooldown was removed, losing a little almost every round trip to fees/slippage)', async () => {
  db.prepare("UPDATE positions SET status = 'closed' WHERE status = 'open'").run();
  const token = {
    mint: 'LOSSREBUY', name: 'LossRebuy', symbol: 'LRB', priceUsd: 2, liquidityUsd: 10000,
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
    mint: 'PROFITREBUY', name: 'ProfitRebuy', symbol: 'PRB', priceUsd: 2, liquidityUsd: 10000,
  };
  const score = { score: 60 };

  const first = await positions.attemptEntry(token, score);
  assert.strictEqual(first.ok, true, `first entry should succeed, got: ${first.reason}`);
  dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 3, liquidityUsd: 5000 }); // real profit on close
  const closed = await positions.attemptManualSell('PROFITREBUY');
  assert.strictEqual(closed.ok, true, `closing the first position should succeed, got: ${closed.reason}`);
  dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 2, liquidityUsd: 5000 }); // restore the file's default mock

  const second = await positions.attemptEntry(token, score);
  // The loss-rebuy cooldown still correctly ignores a PROFITABLE close - that
  // guard's scope is unchanged and this pins it. The daily per-mint cap is what
  // blocks the re-buy now, and it blocks regardless of how the previous
  // position ended, because the data gave no reason to exempt winners:
  // re-buys following a winning close went 0 for 3.
  assert.strictEqual(second.ok, false);
  assert.ok(
    !/loss re-buy cooldown/.test(second.reason),
    `the loss cooldown must not fire on a profitable close, got: ${second.reason}`,
  );
  assert.match(second.reason, /position\(s\) in this mint today/);
});
