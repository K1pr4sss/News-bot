const axios = require('axios');
const logger = require('./logger');

// Same proven-live endpoints as the old bot's dexscreenerBoosts.js - reused
// here as one module since this bot only needs the boosted-list + price
// fallback, not the migration-tracking logic that lived alongside them there.
const BOOSTS_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';
const REFRESH_MS = 60000;

let boostedMints = new Set();

async function refreshBoosts() {
  try {
    const { data } = await axios.get(BOOSTS_URL, { timeout: 8000 });
    boostedMints = new Set(
      (Array.isArray(data) ? data : [])
        .filter((entry) => entry.chainId === 'solana')
        .map((entry) => entry.tokenAddress),
    );
  } catch (err) {
    logger.warn('DexScreener boosts refresh failed, keeping previous snapshot', { error: err.message });
  }
}

function isBoosted(mint) {
  return boostedMints.has(mint);
}

async function getTokenPriceUsd(mint) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 8000 });
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    if (!pairs.length) return null;
    const best = pairs.reduce((a, b) => ((b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a));
    const priceUsd = Number(best.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
    return { priceUsd, liquidityUsd: best.liquidity?.usd || 0 };
  } catch (err) {
    logger.warn('DexScreener getTokenPriceUsd failed', { mint, error: err.message });
    return null;
  }
}

function start() {
  refreshBoosts();
  setInterval(refreshBoosts, REFRESH_MS);
}

module.exports = { start, isBoosted, getTokenPriceUsd };
