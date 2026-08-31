const test = require('node:test');
const assert = require('node:assert');
const { groupSellsIntoPositions, positionPnl } = require('../lib/pnlStats');

test('groups multiple partial sells for one position into a single entry', () => {
  const sells = [
    { id: 1, mint: 'A', symbol: 'AAA', fraction: 0.5, realized_pnl_sol: 0.01 },
    { id: 2, mint: 'A', symbol: 'AAA', fraction: 1, realized_pnl_sol: 0.02 },
  ];
  const positions = groupSellsIntoPositions(sells);
  assert.strictEqual(positions.length, 1);
  assert.ok(Math.abs(positionPnl(positions[0]) - 0.03) < 1e-9);
});

test('interleaved sells for two different mints stay in separate positions (regression: a global "last mint" pointer used to merge these wrongly)', () => {
  const sells = [
    { id: 1, mint: 'A', symbol: 'AAA', fraction: 0.5, realized_pnl_sol: 0.01 }, // A partial
    { id: 2, mint: 'B', symbol: 'BBB', fraction: 1, realized_pnl_sol: 0.05 }, // B fully closes in between
    { id: 3, mint: 'A', symbol: 'AAA', fraction: 1, realized_pnl_sol: 0.02 }, // A's remaining sold later
  ];
  const positions = groupSellsIntoPositions(sells);
  assert.strictEqual(positions.length, 2);
  const aPosition = positions.find((p) => p.symbol === 'AAA');
  const bPosition = positions.find((p) => p.symbol === 'BBB');
  assert.strictEqual(aPosition.sells.length, 2);
  assert.ok(Math.abs(positionPnl(aPosition) - 0.03) < 1e-9);
  assert.ok(Math.abs(positionPnl(bPosition) - 0.05) < 1e-9);
});

test('a re-buy of the same mint after a full close starts a new episode', () => {
  const sells = [
    { id: 1, mint: 'A', symbol: 'AAA', fraction: 1, realized_pnl_sol: -0.01 }, // first episode closes at a loss
    { id: 2, mint: 'A', symbol: 'AAA', fraction: 1, realized_pnl_sol: 0.04 }, // re-buy, closes at a profit
  ];
  const positions = groupSellsIntoPositions(sells);
  assert.strictEqual(positions.length, 2);
  assert.ok(Math.abs(positionPnl(positions[0]) - (-0.01)) < 1e-9);
  assert.ok(Math.abs(positionPnl(positions[1]) - 0.04) < 1e-9);
});
