const config = require('./config');

/**
 * Safety filters, per spec Section 4 - all must pass. Returns { pass, reasons }
 * with `reasons` populated only on failure (why it was rejected).
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

  if (config.requireSocials && !(token.socialsCount > 0)) {
    reasons.push('no socials (twitter/telegram/website)');
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
