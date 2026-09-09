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
  assert.deepStrictEqual(result, { mentionCount: 0, rawMentionCount: 0, sampleText: null });
  assert.strictEqual(callCount, before);
});

test('the scored mention count stays capped at 5 while the RAW count is reported uncapped - un-capping the scored value would shift every score and silently invalidate the >=60 entry bar, which was measured on this scale', async () => {
  process.env.YOUTUBE_API_KEY = 'k';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/youtube')];
  const axios2 = require('axios');
  const realGet = axios2.get;
  axios2.get = async () => ({ data: { items: new Array(37).fill({ snippet: { title: 'vid' } }) } });
  const fresh = require('../lib/youtube');
  try {
    const r = await fresh.searchMentionCount('somecoin');
    assert.strictEqual(r.mentionCount, 5, 'the SCORED value must stay capped');
    assert.strictEqual(r.rawMentionCount, 37, 'the RAW value must be the real count');
  } finally {
    axios2.get = realGet;
  }
});

test('the search asks for enough results to be informative - quota is charged per call, not per result, so the old maxResults:5 was capping the signal for free', async () => {
  process.env.YOUTUBE_API_KEY = 'k';
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/youtube')];
  const axios2 = require('axios');
  const realGet = axios2.get;
  let sentParams = null;
  axios2.get = async (url, opts) => { sentParams = opts.params; return { data: { items: [] } }; };
  const fresh = require('../lib/youtube');
  try {
    await fresh.searchMentionCount('somecoin');
    assert.ok(sentParams.maxResults >= 50, `expected a wide search, got maxResults=${sentParams.maxResults}`);
  } finally {
    axios2.get = realGet;
  }
});
