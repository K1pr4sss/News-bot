const test = require('node:test');
const assert = require('node:assert');
const { runSafetyFilters } = require('../lib/filters');
const config = require('../lib/config');

const cleanToken = { symbol: 'XYZ', liquidityUsd: 50000, socialsCount: 1 };
const cleanRugcheck = { rugged: false, mintAuthorityActive: false, freezeAuthorityActive: false };

test('passes with no Birdeye data at all (holder-count check is skipped, not enforced as a failure)', () => {
  const { pass } = runSafetyFilters(cleanToken, cleanRugcheck, null);
  assert.strictEqual(pass, true);
});

test('rejects when Birdeye reports a holder count below the floor', () => {
  const { pass, reasons } = runSafetyFilters(cleanToken, cleanRugcheck, { holderCount: 3 });
  assert.strictEqual(pass, false);
  assert.ok(reasons.some((r) => r.includes('holder count')));
});

test('passes when Birdeye holder count clears the floor', () => {
  const { pass } = runSafetyFilters(cleanToken, cleanRugcheck, { holderCount: 500 });
  assert.strictEqual(pass, true);
});

// Price-momentum gate. The real finding behind it (2026-09-05, replaying 125
// real positions against real price history): entries into coins that were
// already moving made +0.078 SOL while entries into flat coins lost -0.195
// SOL, and flat entries hit +30% only 9% of the time vs 67% for ones already
// running. See config.js's minPriceMomentumH1Pct.
// These two assertions used to run the other way round - 3% was rejected as
// "not moving yet" and 140% was accepted as "already running". The
// counterfactual inverted both: the >=50% population the gate was built to
// select loses in both halves of the sample (-4.7% / -7.1%, 39% of them falling
// below -80% within two hours), while the mild band it was rejecting wins in
// both (+4.8% / +5.9%, 19% dying). Kept pointing the new way rather than
// deleted, because the direction of this gate IS the finding.
test('passes a token drifting gently upward - what the old floor threw away', () => {
  const { pass } = runSafetyFilters({ ...cleanToken, priceChangeH1Pct: 3 }, cleanRugcheck, null);
  assert.strictEqual(pass, true);
});

test('rejects a token that has already run 140% in the hour - what the old floor demanded', () => {
  const { pass, reasons } = runSafetyFilters({ ...cleanToken, priceChangeH1Pct: 140 }, cleanRugcheck, null);
  assert.strictEqual(pass, false);
  assert.ok(reasons.some((r) => r.includes('price momentum')), `expected a momentum rejection, got: ${reasons.join(' | ')}`);
});

test('rejects on a NEGATIVE 1h change (a fading coin must not slip through as "no data")', () => {
  const { pass, reasons } = runSafetyFilters({ ...cleanToken, priceChangeH1Pct: -40 }, cleanRugcheck, null);
  assert.strictEqual(pass, false);
  assert.ok(reasons.some((r) => r.includes('price momentum')));
});

// The single most important property of this gate: a pool minutes old has no
// 1h history, and GeckoTerminal returns NaN for the field. Rejecting on that
// would silently starve the entire pipeline - exactly how REQUIRE_SOCIALS
// failed before it was removed. The gate may only ever act on real evidence.
test('FAILS OPEN when 1h price change is unavailable, rather than blocking every brand-new pool', () => {
  for (const missing of [undefined, null, NaN]) {
    const { pass } = runSafetyFilters({ ...cleanToken, priceChangeH1Pct: missing }, cleanRugcheck, null);
    assert.strictEqual(pass, true, `momentum gate must not block when h1 is ${String(missing)}`);
  }
});

// --- Minimum pool age -------------------------------------------------------
// Older pools did materially better across the bot's own entry readings, and
// the fresh ones carry the catastrophic tail: of the 14 trades a 30-minute
// floor would have skipped, 12 lost, including NVDA at -101.4% on an 18-minute
// pool that gapped from +7.6% to -99.7% in two candles.

test('rejects a pool younger than the minimum age floor', () => {
  const { pass, reasons } = runSafetyFilters(
    { ...cleanToken, poolCreatedAt: Date.now() - 10 * 60000 }, cleanRugcheck, null,
  );
  assert.strictEqual(pass, false);
  assert.ok(reasons.some((r) => r.includes('too fresh')));
});

test('accepts a pool that has aged past the floor', () => {
  const { pass } = runSafetyFilters(
    { ...cleanToken, poolCreatedAt: Date.now() - 120 * 60000 }, cleanRugcheck, null,
  );
  assert.strictEqual(pass, true);
});

test('minimum pool age fails OPEN when the pool creation time is unreadable (an unknown field must never silently reject, same rule as the momentum gate)', () => {
  assert.strictEqual(runSafetyFilters(cleanToken, cleanRugcheck, null).pass, true);
  assert.strictEqual(
    runSafetyFilters({ ...cleanToken, poolCreatedAt: null }, cleanRugcheck, null).pass, true,
  );
});

// --- Volume / liquidity churn ceiling ---------------------------------------

test('rejects a pool churning its whole liquidity many times an hour', () => {
  const { pass, reasons } = runSafetyFilters(
    {
      ...cleanToken, poolCreatedAt: Date.now() - 120 * 60000,
      liquidityUsd: 50000, volumeH1Usd: 50000 * 20,
    }, cleanRugcheck, null,
  );
  assert.strictEqual(pass, false);
  assert.ok(reasons.some((r) => r.includes('volume/liquidity')));
});

test('accepts normal turnover', () => {
  const { pass } = runSafetyFilters(
    {
      ...cleanToken, poolCreatedAt: Date.now() - 120 * 60000,
      liquidityUsd: 50000, volumeH1Usd: 50000 * 2,
    }, cleanRugcheck, null,
  );
  assert.strictEqual(pass, true);
});

test('churn ceiling is skipped, not enforced, when volume is unreadable', () => {
  const base = { ...cleanToken, poolCreatedAt: Date.now() - 120 * 60000 };
  assert.strictEqual(runSafetyFilters({ ...base, volumeH1Usd: undefined }, cleanRugcheck, null).pass, true);
  // Zero liquidity is rejected, but by the liquidity floor - the churn ratio is
  // undefined there and must not be the thing that reports it.
  const { reasons } = runSafetyFilters({ ...base, liquidityUsd: 0, volumeH1Usd: 1000 }, cleanRugcheck, null);
  assert.ok(reasons.some((r) => r.includes('liquidity $0')));
  assert.ok(!reasons.some((r) => r.includes('volume/liquidity')));
});

// --- Momentum band ----------------------------------------------------------
// The counterfactual: coins rejected ONLY for momentum under 50% raced forward
// on the same rule returned +5.4% in the 0-15% band (train +4.8 / test +5.9,
// 19% died) against -5.9% for the >=50% coins the bot was actually buying
// (train -4.7 / test -7.1, 39% died). The gate was inverted.

const aged = { ...cleanToken, poolCreatedAt: Date.now() - 120 * 60000 };

test('rejects a coin that has already run too far in the hour (blow-off)', () => {
  const { pass, reasons } = runSafetyFilters({ ...aged, priceChangeH1Pct: 80 }, cleanRugcheck, null);
  assert.strictEqual(pass, false);
  assert.ok(reasons.some((r) => r.includes('ceiling')));
});

test('rejects a coin that is not moving at all', () => {
  const { pass, reasons } = runSafetyFilters({ ...aged, priceChangeH1Pct: -3 }, cleanRugcheck, null);
  assert.strictEqual(pass, false);
  assert.ok(reasons.some((r) => r.includes('floor')));
});

test('accepts mild upward momentum - the only band that was positive in both halves', () => {
  assert.strictEqual(runSafetyFilters({ ...aged, priceChangeH1Pct: 8 }, cleanRugcheck, null).pass, true);
});

test('the momentum band still fails OPEN when h1 is unreadable (a pool minutes old has no 1h history, and rejecting on absent data starves the pipeline)', () => {
  assert.strictEqual(runSafetyFilters(aged, cleanRugcheck, null).pass, true);
  assert.strictEqual(runSafetyFilters({ ...aged, priceChangeH1Pct: null }, cleanRugcheck, null).pass, true);
});

test('the 50%+ momentum the bot used to REQUIRE is now the thing it refuses', () => {
  const { pass } = runSafetyFilters({ ...aged, priceChangeH1Pct: 50 }, cleanRugcheck, null);
  assert.strictEqual(pass, false);
});

// --- Telegram override ------------------------------------------------------
// The momentum ceiling blocks 100% of coins up more than 50% in an hour - 4,581
// of them in 43 hours - so the bot cannot participate in any hype wave. A named
// call in a curated alpha group is the one OFF-chain signal available, and the
// one thing a wash trader cannot manufacture cheaply.

test('a coin named in a tracked alpha group skips the momentum band', () => {
  const hot = { ...cleanToken, poolCreatedAt: Date.now() - 120 * 60000, priceChangeH1Pct: 300 };
  assert.strictEqual(runSafetyFilters(hot, cleanRugcheck, null).pass, false, 'blocked without the call');
  assert.strictEqual(
    runSafetyFilters({ ...hot, telegramCalled: true }, cleanRugcheck, null).pass, true,
    'a tracked-group call waives the momentum judgement',
  );
});

test('the override waives momentum ONLY - every safety filter still applies', () => {
  const base = { ...cleanToken, poolCreatedAt: Date.now() - 120 * 60000, priceChangeH1Pct: 300, telegramCalled: true };
  // rug verdict
  assert.strictEqual(runSafetyFilters(base, { ...cleanRugcheck, rugged: true }, null).pass, false);
  // mint authority
  assert.strictEqual(runSafetyFilters(base, { ...cleanRugcheck, mintAuthorityActive: true }, null).pass, false);
  // top-holder cap
  assert.strictEqual(runSafetyFilters(base, { ...cleanRugcheck, topHolderPct: 90 }, null).pass, false);
  // liquidity floor
  assert.strictEqual(runSafetyFilters({ ...base, liquidityUsd: 100 }, cleanRugcheck, null).pass, false);
  // pool age floor
  assert.strictEqual(runSafetyFilters({ ...base, poolCreatedAt: Date.now() - 60000 }, cleanRugcheck, null).pass, false);
  // churn ceiling
  assert.strictEqual(
    runSafetyFilters({ ...base, liquidityUsd: 50000, volumeH1Usd: 50000 * 40 }, cleanRugcheck, null).pass, false,
  );
});

test('the override can be switched off entirely', () => {
  const original = config.telegramOverridesMomentum;
  config.telegramOverridesMomentum = false;
  try {
    const hot = { ...cleanToken, poolCreatedAt: Date.now() - 120 * 60000, priceChangeH1Pct: 300, telegramCalled: true };
    assert.strictEqual(runSafetyFilters(hot, cleanRugcheck, null).pass, false);
  } finally {
    config.telegramOverridesMomentum = original;
  }
});
