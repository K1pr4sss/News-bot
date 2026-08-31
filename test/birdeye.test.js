process.env.BIRDEYE_API_KEY = 'test-key';
process.env.BIRDEYE_MIN_SPACING_MS = '200'; // short for a fast test, same mechanism as the real default

const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const callTimestamps = [];
axios.get = async () => {
  callTimestamps.push(Date.now());
  return { data: { data: { price: 1, v24hUSD: 100, holder: 50, liquidity: 1000 } } };
};

const birdeye = require('../lib/birdeye');

test('concurrent calls are spaced out, not fired in a burst (the actual live bug: PumpPortal bursts 429\'d Birdeye)', async () => {
  await Promise.all([
    birdeye.getTokenOverview('mintA'),
    birdeye.getTokenOverview('mintB'),
    birdeye.getTokenOverview('mintC'),
  ]);
  assert.strictEqual(callTimestamps.length, 3);
  assert.ok(callTimestamps[1] - callTimestamps[0] >= 190, 'second call should wait for the spacing window');
  assert.ok(callTimestamps[2] - callTimestamps[1] >= 190, 'third call should wait for the spacing window');
});
