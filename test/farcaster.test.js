process.env.NEYNAR_API_KEY = 'test-key';

const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

// Single sequential test, not several independent ones - see
// twitter.test.js's comment for why (shared mutable module state +
// node:test's undefined cross-test ordering).
test('Farcaster (Neynar): fails closed with no key, only counts fresh mentions, and degrades to 0 on a failed request', async () => {
  process.env.NEYNAR_API_KEY = '';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/farcaster')];
  const noKeyFarcaster = require('../lib/farcaster');
  noKeyFarcaster.start();

  // 1. Returns 0 without making a call when no API key is configured.
  const noKeyResult = await noKeyFarcaster.getSignal('somecoin');
  assert.deepStrictEqual(noKeyResult, { mentionCount: 0, sampleText: null });

  // 2. Only counts casts within the mention window (not stale older ones),
  // and returns the fresh cast's ACTUAL text verbatim, not a paraphrase.
  process.env.NEYNAR_API_KEY = 'test-key';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/farcaster')];
  const freshFarcaster = require('../lib/farcaster');
  axios.get = async () => ({
    data: {
      result: {
        casts: [
          { timestamp: new Date().toISOString(), text: 'gm frens this one is different' }, // fresh
          { timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(), text: 'old stale cast' }, // 1h old - stale
        ],
      },
    },
  });
  const windowResult = await freshFarcaster.getSignal('somecoin', 5);
  assert.strictEqual(windowResult.mentionCount, 1, `expected only the fresh cast to count, got ${windowResult.mentionCount}`);
  assert.strictEqual(windowResult.sampleText, 'gm frens this one is different');

  // 3. Failed request degrades to 0 mentions rather than throwing (fail
  // closed, matches every other optional source in this codebase).
  axios.get = async () => { throw new Error('network error'); };
  const failResult = await freshFarcaster.getSignal('somecoin');
  assert.deepStrictEqual(failResult, { mentionCount: 0, sampleText: null });
});
