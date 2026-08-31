const axios = require('axios');
const logger = require('./logger');

// pump.fun's own coin metadata API - proven live on the old bot as the real
// source for socials (an IPFS-gateway approach was tried first there and
// 403'd from every gateway tested; this REST endpoint works). A brand-new
// mint can briefly 404 here before pump.fun's own backend has indexed it,
// hence the short backoff retry rather than treating one miss as permanent.
const COIN_URL = (mint) => `https://frontend-api-v3.pump.fun/coins/${mint}`;
const RETRY_DELAYS_MS = [0, 5000, 15000];

async function getSocials(mint) {
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const { data } = await axios.get(COIN_URL(mint), { timeout: 8000 });
      const count = [data?.twitter, data?.telegram, data?.website].filter(Boolean).length;
      return { count, twitter: data?.twitter || null, telegram: data?.telegram || null, website: data?.website || null };
    } catch (err) {
      logger.debug('pump.fun coin lookup miss, retrying', { mint, error: err.message });
    }
  }
  return { count: 0, twitter: null, telegram: null, website: null };
}

module.exports = { getSocials };
