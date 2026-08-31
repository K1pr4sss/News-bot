const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// Confirmed live against Birdeye's own docs before building (public-api.birdeye.so,
// X-API-KEY + x-chain headers). Optional supplementary source, same pattern as
// Solscan - degrades to null (not a crash, not a blocked filter) if no key is
// configured. Birdeye's free-tier request volume isn't confirmed here; if it
// turns out too tight for the discovery-poll cadence, this is the one call site
// to throttle/cache first.
const OVERVIEW_URL = 'https://public-api.birdeye.so/defi/token_overview';

async function getTokenOverview(mint) {
  if (!config.birdeyeApiKey) return null;
  try {
    const { data } = await axios.get(OVERVIEW_URL, {
      params: { address: mint },
      headers: { 'X-API-KEY': config.birdeyeApiKey, 'x-chain': 'solana' },
      timeout: 10000,
    });
    const d = data?.data;
    if (!d) return null;
    return {
      priceUsd: Number(d.price),
      volume24hUsd: Number(d.v24hUSD),
      holderCount: typeof d.holder === 'number' ? d.holder : null,
      liquidityUsd: Number(d.liquidity),
    };
  } catch (err) {
    logger.debug('Birdeye getTokenOverview failed', { mint, error: err.message });
    return null;
  }
}

module.exports = { getTokenOverview };
