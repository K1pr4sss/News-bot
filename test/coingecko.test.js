const test = require('node:test');
const assert = require('node:assert');
const coingecko = require('../lib/coingecko');

// matchesTrending used to be a plain `upper.includes(term)` over a keyword list
// containing 'AI', 'CAT', 'WIF', 'MEW'. Every false match is worth +10 of the
// 20-point trending category - a quarter of the 40-point entry threshold, and
// enough to push a position into a bigger sizing tier.
test('short trending terms do not false-match inside unrelated words', () => {
  for (const name of ['CHAIN', 'RAIN', 'MAINNET', 'DAILY', 'PAIR', 'FAIL', 'AIDEN']) {
    assert.strictEqual(coingecko.matchesTrending(name), false, `"${name}" must not match on the 2-letter term AI`);
  }
  for (const name of ['LOCATION', 'SCATTER', 'CATCH']) {
    assert.strictEqual(coingecko.matchesTrending(name), false, `"${name}" must not match on the 3-letter term CAT`);
  }
  assert.strictEqual(coingecko.matchesTrending('SWIFT'), false, 'SWIFT must not match on WIF');
});

test('longer theme words still substring-match, since a SOLDOGE really is riding the DOGE meta', () => {
  assert.strictEqual(coingecko.matchesTrending('SOLDOGE'), true);
  assert.strictEqual(coingecko.matchesTrending('PEPEKING'), true);
  assert.strictEqual(coingecko.matchesTrending('TrumpCoin'), true);
  assert.strictEqual(coingecko.matchesTrending('ANGRYFROG'), true);
});

test('a short term still matches when it stands alone or is a separate word', () => {
  assert.strictEqual(coingecko.matchesTrending('CAT'), true);
  assert.strictEqual(coingecko.matchesTrending('AI'), true);
  assert.strictEqual(coingecko.matchesTrending('MOON CAT'), true);
  assert.strictEqual(coingecko.matchesTrending('SUPER-AI'), true);
});

// The latent version of the bug, and the more dangerous one: trendingTerms is
// rebuilt from CoinGecko's LIVE trending symbols, which have no length floor. A
// single 1-2 character ticker trending there would have matched essentially
// every token name and handed +10 points to the entire pipeline.
test('a one-character trending symbol cannot match everything', () => {
  coingecko.trendingTerms.add('S');
  coingecko.trendingTerms.add('X');
  assert.strictEqual(coingecko.matchesTrending('ZZZQQQ'), false, 'a 1-char trending symbol must never match arbitrary names');
  assert.strictEqual(coingecko.matchesTrending('BUSINESS'), false);
  coingecko.trendingTerms.delete('S');
  coingecko.trendingTerms.delete('X');
});

test('empty or missing names never match', () => {
  assert.strictEqual(coingecko.matchesTrending(''), false);
  assert.strictEqual(coingecko.matchesTrending(null), false);
  assert.strictEqual(coingecko.matchesTrending(undefined), false);
});
