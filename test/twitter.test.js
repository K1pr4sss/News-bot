process.env.GETXAPI_API_KEY = 'test-key';
process.env.GETXAPI_DAILY_CALL_BUDGET = '3';

const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

// Single sequential test, not several independent ones - these share mutable
// module state (callCount, axios.get mock, require.cache swaps), and
// node:test does not guarantee top-level tests in one file run in
// definition order (see test/pendingCandidates.test.js's comment for the
// real interleaving failure this caused before).
test('GetXAPI: budget-capped (real per-call money, not a free quota), fails closed with no key, and only counts fresh mentions', async () => {
  let callCount = 0;
  axios.get = async () => {
    callCount += 1;
    return { data: { tweets: [{ createdAt: new Date().toUTCString() }] } };
  };
  const twitter = require('../lib/twitter');
  twitter.start();

  // 1. Stops calling the API once the daily budget is exhausted.
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await twitter.searchMentionCount(`coin${i}`);
  }
  assert.strictEqual(callCount, 3, `expected exactly 3 real calls (the budget), got ${callCount}`);

  // 2. Returns 0 without making a call when no API key is configured.
  process.env.GETXAPI_API_KEY = '';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/twitter')];
  const noKeyTwitter = require('../lib/twitter');
  const before = callCount;
  const noKeyResult = await noKeyTwitter.searchMentionCount('somecoin');
  assert.deepStrictEqual(noKeyResult, { mentionCount: 0, sampleText: null });
  assert.strictEqual(callCount, before, 'should not have made a real call with no key');

  // 3. Only counts tweets within the mention window (not stale older ones),
  // and returns the fresh tweet's ACTUAL text verbatim, not a paraphrase -
  // real user ask: see the real post, not a guessed-at summary.
  process.env.GETXAPI_API_KEY = 'test-key';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/twitter')];
  const freshTwitter = require('../lib/twitter');
  axios.get = async () => ({
    data: {
      tweets: [
        { createdAt: new Date().toUTCString(), text: 'wagmi this coin is the next big thing' }, // fresh
        { createdAt: new Date(Date.now() - 60 * 60 * 1000).toUTCString(), text: 'old stale tweet' }, // 1h old - stale
      ],
    },
  });
  const windowResult = await freshTwitter.searchMentionCount('somecoin', 5);
  assert.strictEqual(windowResult.mentionCount, 1, `expected only the fresh tweet to count, got ${windowResult.mentionCount}`);
  assert.strictEqual(windowResult.sampleText, 'wagmi this coin is the next big thing');
});
