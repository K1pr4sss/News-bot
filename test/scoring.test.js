const test = require('node:test');
const assert = require('node:assert');
const { scoreToken, computeVolumeSpikeRatio, computeSizeTier } = require('../lib/scoring');

test('scoreToken sums independent signal categories correctly (max 100 - no insider category)', () => {
  const result = scoreToken({
    mentionCount: 20, // saturates social (30)
    volumeH1Usd: 10000, volumeH24Usd: 24000, // ratio = 10000/1000 = 10x -> saturates volume (25)
    matchedTrendingKeyword: true, matchedTrendingPool: true, isBoosted: true, // 3 sources -> 20
    positiveRatio: 1, // -> 10
    socialsCount: 3, // -> 15
  });
  assert.strictEqual(result.score, 100);
});

test('scoreToken with zero signals scores 0', () => {
  const result = scoreToken({ mentionCount: 0, volumeH1Usd: 0, volumeH24Usd: 0 });
  assert.strictEqual(result.score, 0);
});

test('missing socials costs bonus points but is not a hard reject (regression: this used to be a hard filter in runSafetyFilters, moved to a scoring bonus since real data showed it was too strict - see old sniper bot history)', () => {
  const withSocials = scoreToken({ mentionCount: 20, socialsCount: 3 });
  const withoutSocials = scoreToken({ mentionCount: 20, socialsCount: 0 });
  assert.strictEqual(withSocials.score - withoutSocials.score, 15);
  assert.ok(withoutSocials.score > 0, 'a token with zero socials should still score normally on other categories');
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
