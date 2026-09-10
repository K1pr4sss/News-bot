const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

// Quote responses are driven per-test. `calls` records what was asked for, so
// the "quote the EXACT tokens back" contract can be asserted rather than assumed.
let calls = [];
let handler = null;
axios.get = async (url, opts) => {
  calls.push(opts.params);
  return handler(opts.params);
};

const jupiter = require('../lib/jupiter');
const config = require('../lib/config');

function reset() { calls = []; }

// A pool that hands back 97% of the SOL put in is a 3% round trip. Building the
// mock this way - buy leg mints tokens at a rate, sell leg burns them at a
// worse one - is what makes the arithmetic under test real rather than stubbed.
function pool(returnFraction) {
  return async (p) => {
    if (p.inputMint === jupiter.WSOL) {
      return { data: { outAmount: String(Number(p.amount) * 1000) } };
    }
    return { data: { outAmount: String(Math.round((Number(p.amount) / 1000) * returnFraction)) } };
  };
}

test('measures the true round trip: SOL in, those exact tokens back out', async () => {
  reset();
  handler = pool(0.97);
  const cost = await jupiter.getRoundTripCostPct('MINT_A', 0.1);
  assert.ok(Math.abs(cost - 3) < 0.01, `expected ~3%, got ${cost}`);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].amount, '100000000', 'buy leg quotes the position size in lamports');
  assert.strictEqual(
    calls[1].amount, String(100000000 * 1000),
    'sell leg must quote the EXACT tokens the buy leg returned - anything else prices a different trade',
  );
});

test('a cheap pool measures cheap', async () => {
  reset();
  handler = pool(0.9946);
  const cost = await jupiter.getRoundTripCostPct('MINT_CHEAP', 0.1);
  assert.ok(cost < 0.6, `expected well under 0.6%, got ${cost}`);
});

test('an expensive pool measures expensive (LOOM, the band era\'s worst loser, really cost 7.8% to round-trip)', async () => {
  reset();
  handler = pool(0.922);
  const cost = await jupiter.getRoundTripCostPct('MINT_LOOM', 0.1);
  assert.ok(cost > 7 && cost < 8.5, `expected ~7.8%, got ${cost}`);
});

test('a negative cost is floored at zero - two legs routing through momentarily inconsistent venues is arbitrage, not a discount', async () => {
  reset();
  handler = pool(1.05);
  assert.strictEqual(await jupiter.getRoundTripCostPct('MINT_ARB', 0.1), 0);
});

test('returns null (unknown), not a number, when there is no route', async () => {
  reset();
  handler = async () => ({ data: { outAmount: '0' } });
  assert.strictEqual(await jupiter.getRoundTripCostPct('MINT_DEAD', 0.1), null);
});

test('returns null when Jupiter is unreachable - an outage must degrade the bot to its old blind behaviour, never halt it', async () => {
  reset();
  handler = async () => { throw new Error('ECONNRESET'); };
  assert.strictEqual(await jupiter.getRoundTripCostPct('MINT_DOWN', 0.1), null);
});

test('rejects a nonsense request without spending a network call', async () => {
  reset();
  handler = pool(0.97);
  assert.strictEqual(await jupiter.getRoundTripCostPct('', 0.1), null);
  assert.strictEqual(await jupiter.getRoundTripCostPct('MINT_X', 0), null);
  assert.strictEqual(calls.length, 0);
});

test('caches per mint AND per size - the same token costs differently at a different position size', async () => {
  reset();
  handler = pool(0.97);
  await jupiter.getRoundTripCostPct('MINT_CACHE', 0.1);
  await jupiter.getRoundTripCostPct('MINT_CACHE', 0.1);
  assert.strictEqual(calls.length, 2, 'second identical call must be served from cache');
  await jupiter.getRoundTripCostPct('MINT_CACHE', 0.5);
  assert.strictEqual(calls.length, 4, 'a different size is a different quote');
});

// --- the gate ---------------------------------------------------------------

test('an UNKNOWN cost never refuses a trade - same rule as the momentum gate failing open on an absent h1', () => {
  assert.strictEqual(jupiter.isCostAcceptable(null).ok, true);
  assert.strictEqual(jupiter.isCostAcceptable(undefined).ok, true);
});

test('refuses a trade that starts further underwater than the strategy can earn', () => {
  const r = jupiter.isCostAcceptable(7.8);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes('7.80%'));
  assert.ok(r.reason.includes('Jupiter'), 'the reason must say this was measured, not modelled');
});

test('accepts the median coin - the 2% assumption was right, it was the spread that was missed', () => {
  assert.strictEqual(jupiter.isCostAcceptable(2.02).ok, true);
});

test('the ceiling is exclusive at the boundary', () => {
  const original = config.maxRoundTripCostPct;
  config.maxRoundTripCostPct = 3;
  try {
    assert.strictEqual(jupiter.isCostAcceptable(3.0).ok, true, 'exactly at the ceiling passes');
    assert.strictEqual(jupiter.isCostAcceptable(3.01).ok, false);
  } finally {
    config.maxRoundTripCostPct = original;
  }
});

test('setting the ceiling to 0 disables the gate entirely', () => {
  const original = config.maxRoundTripCostPct;
  config.maxRoundTripCostPct = 0;
  try {
    assert.strictEqual(jupiter.isCostAcceptable(99).ok, true);
  } finally {
    config.maxRoundTripCostPct = original;
  }
});

test('getStatus reports health without throwing', () => {
  const s = jupiter.getStatus();
  assert.strictEqual(typeof s.totalQuotes, 'number');
  assert.strictEqual(s.ceilingPct, config.maxRoundTripCostPct);
});

// --- Jupiter Token API v2 (recorded, never gated) ---------------------------

test('token intel is recorded but gates nothing - tested against all 95 traded mints, no field predicted the outcome (organicScore flips, its 70+ bucket is the WORST at -10.3% and 0 wins; devMints, holderCount and topHoldersPct all flip or are negative in both halves)', () => {
  const jt = require('../lib/jupiterTokens');
  const s = jt.getStatus();
  assert.strictEqual(s.gated, false, 'if this ever becomes true it must be a decision made against forward data');
  assert.deepStrictEqual(Object.keys(jt.EMPTY).sort(), [
    'buyOrganicVolume24h', 'buyVolume24h', 'devBalancePct', 'devMigrations', 'devMints',
    'freezeAuthorityDisabled', 'graduated', 'holderCount', 'launchpad', 'mintAuthorityDisabled',
    'organicScore', 'organicScoreLabel', 'organicVolumeShare', 'poolCreatedAt', 'topHoldersPct',
  ]);
});

test('a failed token lookup records nulls rather than throwing - enrichment must never be able to block a trade', async () => {
  const axios2 = require('axios');
  const jt = require('../lib/jupiterTokens');
  const realGet = axios2.get;
  axios2.get = async () => { throw new Error('ECONNRESET'); };
  try {
    const r = await jt.getTokenData('SOMEMINT_THAT_FAILS');
    assert.strictEqual(r.organicScore, null);
    assert.strictEqual(r.holderCount, null);
  } finally {
    axios2.get = realGet;
  }
});

test('discovery maps Jupiter tokens onto the candidate shape evaluateCandidate expects, and drops anything unpriceable', () => {
  const jt = require('../lib/jupiterTokens');
  const c = jt.toCandidate({
    id: 'MINT1', name: 'Coin', symbol: 'CN', usdPrice: 0.5, liquidity: 120000,
    firstPool: { createdAt: '2026-08-01T00:00:00Z' },
    stats1h: { priceChange: 7.5, buyVolume: 1000, sellVolume: 500, numBuys: 12, numSells: 8 },
    stats5m: { priceChange: 1.2 },
  });
  assert.strictEqual(c.mint, 'MINT1');
  assert.strictEqual(c.priceUsd, 0.5);
  assert.strictEqual(c.liquidityUsd, 120000);
  assert.strictEqual(c.priceChangeH1Pct, 7.5);
  assert.strictEqual(c.volumeH1Usd, 1500, 'volume is buy + sell, matching the GeckoTerminal shape');
  assert.strictEqual(c.buyersH1, 12);
  assert.ok(c.poolCreatedAt > 0, 'pool age must survive so the minimum-age gate can apply');
  assert.strictEqual(jt.toCandidate({ id: 'X' }), null, 'no price means not a candidate');
  assert.strictEqual(jt.toCandidate(null), null);
});

test('a field Jupiter does not report stays undefined rather than becoming 0 - a zero would read as a real measurement of "no buyers" and fail gates open on invented data', () => {
  const jt = require('../lib/jupiterTokens');
  const c = jt.toCandidate({ id: 'M', symbol: 'S', usdPrice: 1, liquidity: 9000, stats1h: {} });
  assert.strictEqual(c.priceChangeH1Pct, undefined);
  assert.strictEqual(c.volumeH1Usd, undefined);
});
