const test = require('node:test');
const assert = require('node:assert');
const { runSafetyFilters } = require('../lib/filters');

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
test('rejects a token whose 1h price change is below the momentum floor', () => {
  const { pass, reasons } = runSafetyFilters({ ...cleanToken, priceChangeH1Pct: 3 }, cleanRugcheck, null);
  assert.strictEqual(pass, false);
  assert.ok(reasons.some((r) => r.includes('price momentum')), `expected a momentum rejection, got: ${reasons.join(' | ')}`);
});

test('passes a token that is already running', () => {
  const { pass } = runSafetyFilters({ ...cleanToken, priceChangeH1Pct: 140 }, cleanRugcheck, null);
  assert.strictEqual(pass, true);
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
