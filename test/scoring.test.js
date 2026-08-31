const test = require('node:test');
const assert = require('node:assert');
const { scoreToken, computeVolumeSpikeRatio, computeSizeTier } = require('../lib/scoring');

test('scoreToken sums independent signal categories correctly (max 85 - no insider category)', () => {
  const result = scoreToken({
    mentionCount: 20, // saturates social (30)
    volumeH1Usd: 10000, volumeH24Usd: 24000, // ratio = 10000/1000 = 10x -> saturates volume (25)
    matchedTrendingKeyword: true, matchedTrendingPool: true, isBoosted: true, // 3 sources -> 20
    positiveRatio: 1, // -> 10
  });
  assert.strictEqual(result.score, 85);
});

test('scoreToken with zero signals scores 0', () => {
  const result = scoreToken({ mentionCount: 0, volumeH1Usd: 0, volumeH24Usd: 0 });
  assert.strictEqual(result.score, 0);
});

test('computeVolumeSpikeRatio falls back to h1-only baseline when no 24h history exists', () => {
  const ratio = computeVolumeSpikeRatio({ volumeH1Usd: 2000, volumeH24Usd: 0 });
  assert.strictEqual(ratio, 2); // 2000 / 1000 baseline
});

test('computeSizeTier bands match spec exactly', () => {
  assert.strictEqual(computeSizeTier(45).label, '40-55');
  assert.strictEqual(computeSizeTier(60).label, '55-70');
  assert.strictEqual(computeSizeTier(85).label, '70+');
});
