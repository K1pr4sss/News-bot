const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const TRENDING_URL = 'https://api.coingecko.com/api/v3/search/trending';

// Seeded with the static keyword list at module load, NOT left empty until the
// first successful refresh. refresh() only assigns on success and otherwise
// keeps the previous snapshot - which at boot was the empty set, so a
// CoinGecko outage (or just the window before the first fetch returns) silently
// disabled the entire trending category for every candidate, with no error and
// nothing in the logs to show for it. The static keywords don't depend on
// CoinGecko being reachable, so they should never have been gated behind it.
let trendingTerms = new Set(config.trendingKeywords);

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

// Plain `upper.includes(term)` here was badly wrong for short tickers, and
// each false match is worth +10 of the 20-point trending category - a quarter
// of the whole 40-point entry threshold, and enough to bump a position into a
// larger sizing tier. With 'AI' in the keyword list, CHAIN / RAIN / MAINNET /
// DAILY / PAIR / FAIL all scored trending points; 'CAT' caught LOCATION and
// SCATTER, 'WIF' caught SWIFT.
//
// The latent version of this was worse than the static list: trendingTerms is
// rebuilt every refresh from CoinGecko's live trending symbols, which are not
// length-controlled. A single one- or two-character ticker trending there (S,
// OP, AI16Z's peers) would have matched essentially EVERY token name and
// handed +10 points to the entire pipeline until it stopped trending.
//
// Length-dependent matching rather than blanket word-boundary matching,
// because substring genuinely is the right test for longer theme words - a
// coin called SOLDOGE really is riding the DOGE meta. Short terms get the
// strict treatment where accidental collisions actually happen. Precision is
// the priority: a missed trending match costs 10 points on one candidate, a
// false one inflates the score AND the position size on a coin that earned
// neither.
const SUBSTRING_MIN_LEN = 4;

function matchesTrending(name) {
  const upper = (name || '').toUpperCase();
  if (!upper) return false;
  for (const term of trendingTerms) {
    if (!term || term.length < 2) continue; // a single character matches everything
    if (term.length >= SUBSTRING_MIN_LEN) {
      if (upper.includes(term)) return true;
    } else if (upper === term || new RegExp(`(^|[^A-Z0-9])${term}([^A-Z0-9]|$)`).test(upper)) {
      return true;
    }
  }
  return false;
}

function start() {
  refresh();
  setInterval(refresh, config.trendingPollIntervalMs);
}

module.exports = { start, matchesTrending, get trendingTerms() { return trendingTerms; } };
