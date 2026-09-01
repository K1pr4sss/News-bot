const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const geckoterminal = require('../lib/geckoterminal');

// Real bug this covers (2026-09-01): PumpPortal schedules a getPoolsForToken
// lookup for EVERY new token it discovers, sharing the same rate-limited
// queue as exit-tick's own checks for ALREADY-OPEN positions. A real
// position crashed hard but its stop-loss didn't fire for 85 minutes -
// stuck behind a backlog of low-priority new-token lookups the whole time.
// This proves a 'high' priority call (open-position protection) jumps
// ahead of already-queued 'low' priority calls (new-token discovery),
// even though it arrives LATER. Uses real timer spacing (MIN_SPACING_MS),
// same as the existing slow tests in this suite - a handful of seconds,
// not something worth mocking timers to avoid.
test('a high-priority GeckoTerminal call jumps ahead of already-queued low-priority calls (open positions must never queue behind brand-new-token discovery lookups)', async () => {
  const callOrder = [];
  axios.get = async (url) => {
    const mint = url.split('/tokens/')[1]?.split('/pools')[0];
    callOrder.push(mint);
    return { data: { data: [] } };
  };

  // Two low-priority calls queued first (simulating PumpPortal's flood of
  // new-token lookups), then a high-priority call arrives shortly after
  // (simulating exit-tick checking an open position) - it should still
  // finish before the SECOND low-priority call, even though it was
  // enqueued after both.
  const p1 = geckoterminal.getPoolsForToken('LOW1', 'low');
  const p2 = geckoterminal.getPoolsForToken('LOW2', 'low');
  await new Promise((r) => setTimeout(r, 50)); // let p1 start processing (claims the queue) before the high-priority call arrives
  const p3 = geckoterminal.getPoolsForToken('OPENPOSITION', 'high');

  await Promise.all([p1, p2, p3]);

  assert.strictEqual(callOrder[0], 'LOW1', 'the already-in-flight low-priority call should still complete first');
  assert.strictEqual(callOrder[1], 'OPENPOSITION', 'the high-priority call should jump ahead of the still-queued LOW2');
  assert.strictEqual(callOrder[2], 'LOW2', 'the low-priority call should run last, after being passed over');
});
