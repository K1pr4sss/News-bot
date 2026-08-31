const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// Confirmed live against Birdeye's own docs before building (public-api.birdeye.so,
// X-API-KEY + x-chain headers). Optional supplementary source, same pattern as
// Solscan - degrades to null (not a crash, not a blocked filter) if no key is
// configured.
//
// Real live data confirmed the free tier rate-limits hard (429s) under any
// burst - PumpPortal's "create" events cluster tightly (many per second at
// times), and each schedules its own independent 30s-later evaluation, so
// without throttling, a PumpPortal burst produces a matching burst of
// concurrent Birdeye calls. Same exact bug class as the old sniper bot's
// "top-holder filter completely dead all session, RPC rate-limited" - this
// wasn't erroring loudly, it was just silently returning null (filter
// skipped) on nearly every call. Routes through the same
// sequential-queue-with-spacing pattern already proven for GeckoTerminal.
const OVERVIEW_URL = 'https://public-api.birdeye.so/defi/token_overview';
const MIN_SPACING_MS = Number(process.env.BIRDEYE_MIN_SPACING_MS || 1100);

let queueTail = Promise.resolve();
let lastCallAt = 0;

function throttledGet(url, opts) {
  const run = async () => {
    const wait = Math.max(0, lastCallAt + MIN_SPACING_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return axios.get(url, opts);
  };
  const result = queueTail.then(run, run);
  queueTail = result.catch(() => {});
  return result;
}

async function getTokenOverview(mint) {
  if (!config.birdeyeApiKey) return null;
  try {
    const { data } = await throttledGet(OVERVIEW_URL, {
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
