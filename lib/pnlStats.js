/**
 * Groups a chronological list of 'sell' trade rows into one entry per closed
 * position (all its partial/take-profit/stop-loss sells summed), not one
 * entry per sell event. Tracked per-mint so sells for different open
 * positions can interleave across poll cycles without corrupting each
 * other's grouping - a single global "last mint" pointer would wrongly
 * split one still-open position's partial sells into two episodes whenever
 * another mint's sell landed in between (confirmed by test before shipping).
 */
function groupSellsIntoPositions(sells) {
  const byPosition = new Map(); // episode key -> { symbol, sells: [] }
  const openEpisodeForMint = new Map(); // mint -> current episode key, cleared on a full close
  for (const t of sells) {
    let key = openEpisodeForMint.get(t.mint);
    if (!key) {
      key = `${t.mint}-${t.id}`;
      openEpisodeForMint.set(t.mint, key);
    }
    if (!byPosition.has(key)) byPosition.set(key, { symbol: t.symbol, sells: [] });
    byPosition.get(key).sells.push(t);
    if (t.fraction === null || t.fraction >= 0.999999) openEpisodeForMint.delete(t.mint);
  }
  return [...byPosition.values()];
}

function positionPnl(position) {
  return position.sells.reduce((sum, t) => sum + (t.realized_pnl_sol || 0), 0);
}

module.exports = { groupSellsIntoPositions, positionPnl };
