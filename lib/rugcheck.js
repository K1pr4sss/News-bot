const axios = require('axios');
const logger = require('./logger');

// Same endpoint/parsing already proven live on the old sniper bot - RugCheck
// has no stable documented public API, so this fails safe (nulls, not throws)
// on any shape mismatch rather than crashing the pipeline.
const REPORT_URL = (mint) => `https://api.rugcheck.xyz/v1/tokens/${mint}/report`;

async function getFullReport(mint) {
  try {
    const { data } = await axios.get(REPORT_URL(mint), { timeout: 10000 });

    const topHolders = Array.isArray(data?.topHolders) ? data.topHolders : [];
    const topHolderPct = topHolders.length
      ? Math.max(...topHolders.map((h) => h.pct).filter((p) => typeof p === 'number'))
      : null;

    const insiderNetworks = Array.isArray(data?.insiderNetworks) ? data.insiderNetworks : [];
    const supply = data?.token?.supply;
    const insiderNetworkTokenAmount = insiderNetworks.reduce((sum, n) => sum + (n.tokenAmount || 0), 0);
    const insiderNetworkPct = (insiderNetworkTokenAmount > 0 && typeof supply === 'number' && supply > 0)
      ? (insiderNetworkTokenAmount / supply) * 100
      : null;

    return {
      rugged: typeof data?.rugged === 'boolean' ? data.rugged : null,
      scoreNormalised: typeof data?.score_normalised === 'number' ? data.score_normalised : null,
      topHolderPct: Number.isFinite(topHolderPct) ? topHolderPct : null,
      insiderNetworkPct: Number.isFinite(insiderNetworkPct) ? insiderNetworkPct : null,
      mintAuthorityActive: data?.token?.mintAuthority != null,
      freezeAuthorityActive: data?.token?.freezeAuthority != null,
      creatorAddress: data?.creator || data?.token?.creator || null,
      name: data?.tokenMeta?.name || null,
      symbol: data?.tokenMeta?.symbol || null,
    };
  } catch (err) {
    logger.warn('RugCheck lookup failed, treating as unknown', { mint, error: err.message });
    return {
      rugged: null,
      scoreNormalised: null,
      topHolderPct: null,
      insiderNetworkPct: null,
      mintAuthorityActive: null,
      freezeAuthorityActive: null,
      creatorAddress: null,
      name: null,
      symbol: null,
    };
  }
}

module.exports = { getFullReport };
