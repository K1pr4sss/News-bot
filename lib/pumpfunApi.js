const axios = require('axios');
const logger = require('./logger');

// pump.fun's own coin metadata API - proven live on the old bot as the real
// source for socials (an IPFS-gateway approach was tried first there and
// 403'd from every gateway tested; this REST endpoint works). A brand-new
// mint can briefly 404 here before pump.fun's own backend has indexed it,
// hence the short backoff retry rather than treating one miss as permanent.
const COIN_URL = (mint) => `https://frontend-api-v3.pump.fun/coins/${mint}`;
const RETRY_DELAYS_MS = [0, 5000, 15000];

const EMPTY = {
  count: 0, twitter: null, telegram: null, website: null, description: '',
};

async function getSocials(mint) {
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const { data } = await axios.get(COIN_URL(mint), { timeout: 8000 });
      const count = [data?.twitter, data?.telegram, data?.website].filter(Boolean).length;
      return {
        count,
        twitter: data?.twitter || null,
        telegram: data?.telegram || null,
        website: data?.website || null,
        // Creator-supplied blurb - most launches leave this blank (confirmed
        // live against several real tokens before shipping), but free when
        // present since this endpoint is already being called for socials.
        description: (data?.description || '').trim(),
      };
    } catch (err) {
      // A 404 here is a FACT, not a transient miss: this mint is not a
      // pump.fun coin at all. GeckoTerminal's new_pools feed is not
      // pump.fun-only - it carries bonk.fun tokens, Raydium listings and
      // everything else on Solana - so a large share of candidates can never
      // resolve here no matter how long we wait.
      //
      // Retrying those through the full [0, 5s, 15s] backoff burned 20 SECONDS
      // of wall time per non-pump.fun token, and evaluateCandidate is awaited
      // sequentially inside discoveryTick - so a single batch containing a
      // handful of them stalled discovery for minutes at a time, on a poll
      // loop that is supposed to run every 20s. The backoff still applies to
      // genuine transient failures (timeouts, 5xx, and the real case it was
      // written for: a brand-new pump.fun mint its own backend hasn't indexed
      // yet, which returns 500/503 rather than 404).
      if (err.response?.status === 404) {
        logger.debug('pump.fun has no coin for this mint - not a pump.fun token, not retrying', { mint });
        return EMPTY;
      }
      logger.debug('pump.fun coin lookup miss, retrying', { mint, error: err.message });
    }
  }
  return EMPTY;
}

module.exports = { getSocials };
