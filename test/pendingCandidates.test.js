process.env.DB_PATH = ':memory:';
process.env.PAPER_STARTING_BALANCE_SOL = '1.0';

const test = require('node:test');
const assert = require('node:assert');
const rugcheck = require('../lib/rugcheck');
const pumpfunApi = require('../lib/pumpfunApi');
const birdeye = require('../lib/birdeye');
const geckoterminal = require('../lib/geckoterminal');
const evaluator = require('../lib/evaluator');

// Stub every external network call evaluateCandidate touches - this test is
// about the pending-retry state machine, not any one API's real behavior.
const cleanRugcheck = {
  rugged: false, mintAuthorityActive: false, freezeAuthorityActive: false, topHolderPct: null, insiderNetworkPct: null,
};
pumpfunApi.getSocials = async () => ({ count: 0 });
birdeye.getTokenOverview = async () => null;

function thinToken(mint, overrides = {}) {
  return {
    mint, name: 'Test', symbol: 'TEST', priceUsd: 1, liquidityUsd: 500, volumeH1Usd: 0, volumeH24Usd: 0, ...overrides,
  };
}

// A single sequential test, not several independent ones - these all share
// mutable module state (the pendingCandidates map, the rugcheck mock), and
// node:test does not guarantee top-level tests in one file run in
// definition order, which caused real interleaving failures when this was
// split into separate test() calls (test 3's mock swap landed mid-flight of
// test 2's await, corrupting its result - confirmed by reproducing the
// exact sequence in a standalone script where it passed in isolation).
test('pending-candidate retry queue: queues on improvable failure, graduates once it matures, ignores permanent disqualifiers, evicts once too old', async () => {
  rugcheck.getFullReport = async () => cleanRugcheck;

  // 1. Fails only on liquidity (improvable) -> queued for retry, not dropped.
  await evaluator.evaluateCandidate(thinToken('PENDING1'));
  assert.strictEqual(evaluator.getPendingCount(), 1);

  // 2. Retry tick re-fetches FRESH data (not the stale first snapshot) and
  //    re-evaluates - once liquidity actually clears, it graduates out of
  //    the pending set (whether or not it also clears the score/volume bar).
  geckoterminal.getPoolsForToken = async () => [thinToken('PENDING1', { liquidityUsd: 10000, volumeH1Usd: 500, volumeH24Usd: 3000 })];
  await evaluator.pendingCandidatesTick();
  assert.strictEqual(evaluator.getPendingCount(), 0, 'PENDING1 should have graduated once liquidity cleared');

  // 3. A permanent disqualifier (rugged) is never queued at all - more time
  //    can't fix it, so retrying would just waste API calls forever.
  rugcheck.getFullReport = async () => ({ ...cleanRugcheck, rugged: true });
  await evaluator.evaluateCandidate(thinToken('RUGGED1'));
  assert.strictEqual(evaluator.getPendingCount(), 0);
  rugcheck.getFullReport = async () => cleanRugcheck;

  // 4. A candidate that's aged past the max pending window gets evicted on
  //    the next tick instead of being retried forever.
  process.env.PENDING_CANDIDATE_MAX_AGE_MINUTES = '0';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/evaluator')];
  // eslint-disable-next-line global-require
  const freshEvaluator = require('../lib/evaluator');
  await freshEvaluator.evaluateCandidate(thinToken('AGEOUT1'));
  assert.strictEqual(freshEvaluator.getPendingCount(), 1);
  await freshEvaluator.pendingCandidatesTick();
  assert.strictEqual(freshEvaluator.getPendingCount(), 0);
});
