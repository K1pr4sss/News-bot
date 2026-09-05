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

// Unbounded, this queue grows to arrival-rate x max-age (~18/min x 60min is
// ~1,000), at which point the batch cap gives each candidate about ONE recheck
// in its whole life - it stops working precisely because it's full. Eviction is
// worst-top-holder-first because that filter is what binds and is furthest from
// being satisfied (live sample: median 80%, zero under the 15% cap).
test('pending queue is capped, and evicts the candidates furthest from qualifying first', async () => {
  process.env.PENDING_CANDIDATE_MAX_AGE_MINUTES = '60';
  process.env.PENDING_RECHECK_BATCH_SIZE = '25';
  process.env.PENDING_CANDIDATE_MAX_SIZE = '5';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/evaluator')];
  // eslint-disable-next-line global-require
  const ev = require('../lib/evaluator');

  // Queue 5 hopeless candidates (creator still holds ~everything), then 3 that
  // are genuinely close to the 15% cap. The close ones must survive.
  for (let i = 0; i < 5; i++) {
    rugcheck.getFullReport = async () => ({ ...cleanRugcheck, topHolderPct: 90 + i });
    await ev.evaluateCandidate(thinToken('HOPELESS' + i)); // eslint-disable-line no-await-in-loop
  }
  assert.strictEqual(ev.getPendingCount(), 5, 'cap not exceeded yet');

  for (let i = 0; i < 3; i++) {
    rugcheck.getFullReport = async () => ({ ...cleanRugcheck, topHolderPct: 17 + i });
    await ev.evaluateCandidate(thinToken('CLOSE' + i)); // eslint-disable-line no-await-in-loop
  }
  assert.strictEqual(ev.getPendingCount(), 5, 'queue must stay at the cap, not grow');

  // Prove WHICH survived by seeing who gets rechecked - the close ones must be
  // in the queue, the worst hopeless ones must have been dropped.
  const seen = [];
  geckoterminal.getPoolsForToken = async (mint) => { seen.push(mint); return [thinToken(mint, { liquidityUsd: 100 })]; };
  rugcheck.getFullReport = async () => ({ ...cleanRugcheck, topHolderPct: 90 });
  await ev.pendingCandidatesTick();
  for (let i = 0; i < 3; i++) {
    assert.ok(seen.includes('CLOSE' + i), `CLOSE${i} (top-holder ~${17 + i}%) must survive eviction, queue held: ${seen.join(',')}`);
  }
  assert.ok(!seen.includes('HOPELESS4'), 'the worst top-holder candidate must be evicted first');
});

// The retry loop used to make one GeckoTerminal call per pending candidate per
// tick. At the real observed queue depth (~76) that schedules ~160s of
// rate-limited work every 90s, so the queue can never drain - it just grows,
// eating the shared budget. The momentum gate makes this sharply worse because
// "not moving yet" is an improvable reason, so most rejects now land here.
test('pending retry is batched per tick and rotates by least-recently-checked, so a deep queue cannot monopolise the rate-limited budget', async () => {
  process.env.PENDING_CANDIDATE_MAX_AGE_MINUTES = '60';
  process.env.PENDING_RECHECK_BATCH_SIZE = '5';
  process.env.PENDING_CANDIDATE_MAX_SIZE = '1000'; // isolate rotation from the eviction test's cap
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/evaluator')];
  // eslint-disable-next-line global-require
  const ev = require('../lib/evaluator');
  rugcheck.getFullReport = async () => cleanRugcheck;

  for (let i = 0; i < 20; i++) await ev.evaluateCandidate(thinToken('DEEP' + i)); // eslint-disable-line no-await-in-loop
  assert.strictEqual(ev.getPendingCount(), 20);

  // Count real lookups, and keep every candidate failing so none graduate out
  // and change the queue size underneath the assertions.
  const seen = [];
  geckoterminal.getPoolsForToken = async (mint) => { seen.push(mint); return [thinToken(mint, { liquidityUsd: 100 })]; };

  await ev.pendingCandidatesTick();
  assert.strictEqual(seen.length, 5, `batch cap must hold the tick to 5 lookups, got ${seen.length}`);
  assert.strictEqual(ev.getPendingCount(), 20, 'still-failing candidates stay queued');

  // Second tick must move on to a DIFFERENT five - if it re-checked the same
  // head of the queue, the tail would never be looked at again.
  const firstFive = [...seen];
  seen.length = 0;
  await ev.pendingCandidatesTick();
  assert.strictEqual(seen.length, 5);
  assert.strictEqual(
    firstFive.filter((m) => seen.includes(m)).length, 0,
    `second tick must rotate to unchecked candidates, but repeated: ${seen.filter((m) => firstFive.includes(m)).join(',')}`,
  );
});
