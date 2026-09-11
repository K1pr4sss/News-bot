const test = require('node:test');
const assert = require('node:assert');
const boosts = require('../lib/dexscreenerBoosts');

test('maps a DexScreener pair onto the candidate shape evaluateCandidate expects', () => {
  const c = boosts.pairToCandidate({
    chainId: 'solana',
    pairAddress: 'POOL1',
    baseToken: { address: 'MINT1', name: 'Coin', symbol: 'CN' },
    priceUsd: '0.25',
    liquidity: { usd: 88000 },
    pairCreatedAt: 1789000000000,
    priceChange: { m5: 0.4, h1: 6.2, h24: -3 },
    volume: { h1: 4200, h24: 90000 },
    txns: { h1: { buys: 30, sells: 22 } },
  });
  assert.strictEqual(c.mint, 'MINT1');
  assert.strictEqual(c.priceUsd, 0.25);
  assert.strictEqual(c.liquidityUsd, 88000);
  assert.strictEqual(c.priceChangeH1Pct, 6.2);
  assert.strictEqual(c.buyersH1, 30);
  assert.ok(c.poolCreatedAt > 0, 'pool age must survive so the minimum-age gate can apply');
});

test('an unreported field stays undefined rather than becoming 0 - gates fail OPEN on absent data, and a zero would be read as a real measurement', () => {
  const c = boosts.pairToCandidate({
    chainId: 'solana', baseToken: { address: 'M', symbol: 'S' }, priceUsd: '1',
  });
  assert.strictEqual(c.priceChangeH1Pct, undefined);
  assert.strictEqual(c.volumeH1Usd, undefined);
  assert.strictEqual(c.liquidityUsd, 0, 'liquidity alone defaults to 0 so the floor rejects rather than skips');
});

test('drops a pair with no usable price', () => {
  assert.strictEqual(boosts.pairToCandidate({ baseToken: { address: 'M' } }), null);
  assert.strictEqual(boosts.pairToCandidate(null), null);
});

test('this source is not scheduled and not scored - a live run returned 20 promoted tokens of which ONE cleared the band, because paid promotion is bought for fresh thin launches (0 days old, $0-24k liquidity, up 116-308%), which is the rug profile', () => {
  assert.strictEqual(boosts.getStatus().scored, false);
  const index = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(
    !/scheduleInterval\(\s*dexscreenerBoosts/.test(index),
    'if this is ever scheduled it must be a deliberate decision with fresh evidence on the population',
  );
});
