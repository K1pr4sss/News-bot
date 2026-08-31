const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending';

let trendingTerms = new Set();

async function refresh() {
  try {
    const { data } = await axios.get(TRENDING_URL, { timeout: 10000 });
    const coins = Array.isArray(data?.coins) ? data.coins : [];
    const terms = coins.flatMap((c) => [c.item?.symbol, c.item?.name])
      .filter(Boolean)
      .map((s) => String(s).toUpperCase());
    trendingTerms = new Set([...config.trendingKeywords, ...terms]);
  } catch (err) {
    logger.warn('CoinGecko trending refresh failed, keeping previous snapshot', { error: err.message });
  }
}

function matchesTrending(name) {
  const upper = (name || '').toUpperCase();
  return [...trendingTerms].some((term) => upper.includes(term));
}

function start() {
  refresh();
  setInterval(refresh, config.trendingPollIntervalMs);
}

module.exports = { start, matchesTrending, get trendingTerms() { return trendingTerms; } };
