process.env.YOUTUBE_API_KEY = 'test-key';
process.env.YOUTUBE_DAILY_CALL_BUDGET = '3';

const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

let callCount = 0;
axios.get = async () => {
  callCount += 1;
  return { data: { items: [{ snippet: {} }] } };
};

const youtube = require('../lib/youtube');
youtube.start();

test('stops calling the API once the daily budget is exhausted', async () => {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await youtube.searchMentionCount(`coin${i}`);
  }
  assert.strictEqual(callCount, 3, `expected exactly 3 real calls (the budget), got ${callCount}`);
});

test('returns 0 without making a call when no API key is configured', async () => {
  const before = callCount;
  process.env.YOUTUBE_API_KEY = '';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/youtube')];
  const freshYoutube = require('../lib/youtube');
  const result = await freshYoutube.searchMentionCount('somecoin');
  assert.strictEqual(result, 0);
  assert.strictEqual(callCount, before);
});
