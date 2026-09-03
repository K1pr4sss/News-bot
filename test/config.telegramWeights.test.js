const test = require('node:test');
const assert = require('node:assert');

// The parsing logic here (comma/colon-split env var -> weight map) is the
// real risk area in telegramGroupWeights - the reduce that consumes it in
// telegramUserClient.js's getSignal is a one-liner with nothing to get
// wrong once the map itself is correct. Tested via fresh requires with
// different env values rather than mocking GramJS (this file has no live
// client dependency at all - it's pure config parsing).
test('telegramGroupWeights: default gives hadesalphacalls a 3x weight, everything else defaults to 1x', () => {
  delete process.env.TELEGRAM_GROUP_WEIGHTS;
  delete require.cache[require.resolve('../lib/config')];
  const config = require('../lib/config');
  assert.strictEqual(config.telegramGroupWeights.hadesalphacalls, 3);
  assert.strictEqual(config.telegramGroupWeights.somerandomgroup, undefined); // absent, not 1 - callers use `|| 1` as the fallback
});

test('telegramGroupWeights: custom env value parses multiple group:weight pairs, case-insensitively keyed', () => {
  process.env.TELEGRAM_GROUP_WEIGHTS = 'HadesAlphaCalls:5, othergroup:2 ,badpair';
  delete require.cache[require.resolve('../lib/config')];
  const config = require('../lib/config');
  assert.strictEqual(config.telegramGroupWeights.hadesalphacalls, 5, 'key should be lowercased regardless of input casing');
  assert.strictEqual(config.telegramGroupWeights.othergroup, 2);
  assert.strictEqual(config.telegramGroupWeights.badpair, 1, 'a pair with no ":weight" part should default to 1x, not NaN or crash');
  delete process.env.TELEGRAM_GROUP_WEIGHTS;
  delete require.cache[require.resolve('../lib/config')];
});
