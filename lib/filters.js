const config = require('./config');

/**
 * Safety filters, per spec Section 4 - all must pass. Returns { pass, reasons }
 * with `reasons` populated only on failure (why it was rejected). Missing
 * socials is NOT one of these - it's a scoring bonus category instead (see
 * scoring.js), not a hard reject, per the old sniper bot's own finding that
 * hard-blocking on it was too strict (plenty of legit early tokens haven't
 * added socials yet).
 */
function runSafetyFilters(token, rugcheckReport, birdeyeOverview) {
  const reasons = [];

  // Copycat detection: an EXACT match against an established, real trending
  // ticker (DOGE/PEPE/BONK/etc, not just anything currently hyped) combined
  // with thin liquidity is a brand-new token impersonating a known name, not
  // the real thing appearing again.
  const symbolUpper = (token.symbol || '').toUpperCase();
  const isKnownTickerCopy = config.trendingKeywords.includes(symbolUpper) && token.liquidityUsd < config.minLiquidityUsd * 10;
  if (isKnownTickerCopy) reasons.push(`copycat: symbol "${symbolUpper}" matches a known ticker with only $${Math.round(token.liquidityUsd)} liquidity`);

  if (!(token.liquidityUsd >= config.minLiquidityUsd)) {
    reasons.push(`liquidity $${Math.round(token.liquidityUsd || 0)} below $${config.minLiquidityUsd} floor`);
  }

  if (typeof rugcheckReport.topHolderPct === 'number' && rugcheckReport.topHolderPct > config.maxTopHolderPct) {
    reasons.push(`top holder ${rugcheckReport.topHolderPct.toFixed(1)}% over ${config.maxTopHolderPct}% cap`);
  }

  if (typeof rugcheckReport.insiderNetworkPct === 'number' && rugcheckReport.insiderNetworkPct > config.maxInsiderNetworkPct) {
    reasons.push(`insider-network clustering ${rugcheckReport.insiderNetworkPct.toFixed(1)}% over ${config.maxInsiderNetworkPct}% cap (proxy for coordinated/dev dumping)`);
  }

  // Price-momentum gate - see config.js's minPriceMomentumH1Pct for the real
  // data. Two deliberate design choices here:
  //
  // 1. This lives among the safety filters rather than in the score so that a
  //    coin failing it lands in evaluator.js's pendingCandidates retry queue
  //    (momentum is exactly the kind of thing time can fix - a flat coin can
  //    start running five minutes later) instead of being dropped outright.
  // 2. It only applies when h1 is actually a finite number. A pool minutes old
  //    has no 1h history, and rejecting on a missing field would silently
  //    starve the whole pipeline - the same failure mode REQUIRE_SOCIALS had
  //    before it was removed. Failing OPEN on absent data is the conservative
  //    choice: the gate can only ever remove coins it has real evidence about.
  //    m5 is deliberately NOT used as a fallback - it was tested as a gate and
  //    performed badly (m5>=5% and m5>=15% both lost money), so substituting
  //    it here would be inventing a rule the data doesn't support.
  if (config.minPriceMomentumH1Pct > 0 && Number.isFinite(token.priceChangeH1Pct)
      && token.priceChangeH1Pct < config.minPriceMomentumH1Pct) {
    reasons.push(`price momentum ${token.priceChangeH1Pct.toFixed(1)}% over 1h below ${config.minPriceMomentumH1Pct}% floor (not moving yet)`);
  }

  if (config.maxTokenAgeMinutes > 0 && typeof token.poolCreatedAt === 'number') {
    const ageMinutes = (Date.now() - token.poolCreatedAt) / 60000;
    if (ageMinutes > config.maxTokenAgeMinutes) reasons.push(`age ${ageMinutes.toFixed(0)}min over ${config.maxTokenAgeMinutes}min cap`);
  }

  if (rugcheckReport.rugged === true) reasons.push('RugCheck verdict: rugged');
  if (rugcheckReport.mintAuthorityActive) reasons.push('mint authority still active');
  if (rugcheckReport.freezeAuthorityActive) reasons.push('freeze authority still active');

  // Distinct signal from RugCheck's top-holder % (one wallet's share of
  // supply) - a token can look clean on that while still having almost no
  // real distribution. Only enforced when Birdeye is actually configured.
  if (birdeyeOverview && typeof birdeyeOverview.holderCount === 'number' && birdeyeOverview.holderCount < config.minHolderCount) {
    reasons.push(`holder count ${birdeyeOverview.holderCount} below ${config.minHolderCount} floor`);
  }

  return { pass: reasons.length === 0, reasons };
}

module.exports = { runSafetyFilters };
