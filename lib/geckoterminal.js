const axios = require('axios');
const logger = require('./logger');

const BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// GeckoTerminal's free anonymous tier has a real, documented rate limit
// (~30 req/min) - confirmed live while building this (discoveryTick and
// trendingTick firing concurrently at startup, plus per-position exit-tick
// lookups, tripped 429s immediately). Every call in this module routes
// through one small sequential queue with a floor between requests, plus a
// single retry-with-backoff on 429, rather than each call site hitting the
// API independently - same lesson the old sniper bot learned the hard way
// about free-tier RPC limits, applied here before it became a real problem.
const MIN_SPACING_MS = 2100;
let queueTail = Promise.resolve();
let lastCallAt = 0;

function throttledGet(url, opts) {
  const run = async () => {
    const wait = Math.max(0, lastCallAt + MIN_SPACING_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    try {
      return await axios.get(url, opts);
    } catch (err) {
      if (err.response?.status === 429) {
        await new Promise((r) => setTimeout(r, 3000));
        lastCallAt = Date.now();
        return axios.get(url, opts);
      }
      throw err;
    }
  };
  const result = queueTail.then(run, run);
  queueTail = result.catch(() => {});
  return result;
}

function parsePool(pool) {
  try {
    const attrs = pool.attributes;
    const baseTokenId = pool.relationships?.base_token?.data?.id;
    const quoteTokenId = pool.relationships?.quote_token?.data?.id;
    if (!baseTokenId) return null;

    const baseMint = baseTokenId.replace('solana_', '');
    const quoteMint = quoteTokenId ? quoteTokenId.replace('solana_', '') : null;
    if (baseMint === SOL_MINT) return null; // SOL is the quote side of every pair we'd buy, not the base
    if (quoteMint && quoteMint !== SOL_MINT) return null; // only SOL-quoted pairs

    const poolCreatedAt = attrs.pool_created_at ? new Date(attrs.pool_created_at).getTime() : null;

    return {
      mint: baseMint,
      poolAddress: attrs.address,
      name: (attrs.name || '').split('/')[0]?.trim() || baseMint.slice(0, 6),
      symbol: (attrs.name || '').split('/')[0]?.trim() || baseMint.slice(0, 6),
      priceUsd: Number(attrs.base_token_price_usd),
      liquidityUsd: Number(attrs.reserve_in_usd),
      poolCreatedAt,
      priceChangeM5Pct: Number(attrs.price_change_percentage?.m5),
      priceChangeH1Pct: Number(attrs.price_change_percentage?.h1),
      priceChangeH6Pct: Number(attrs.price_change_percentage?.h6),
      priceChangeH24Pct: Number(attrs.price_change_percentage?.h24),
      volumeH1Usd: Number(attrs.volume_usd?.h1),
      volumeH24Usd: Number(attrs.volume_usd?.h24),
      buyersH1: attrs.transactions?.h1?.buyers ?? 0,
      sellersH1: attrs.transactions?.h1?.sellers ?? 0,
    };
  } catch {
    return null;
  }
}

async function getNewPools() {
  try {
    const { data } = await throttledGet(`${BASE}/new_pools`, { timeout: 15000 });
    return (data?.data || []).map(parsePool).filter(Boolean);
  } catch (err) {
    logger.warn('GeckoTerminal getNewPools failed', { error: err.message });
    return [];
  }
}

async function getTrendingPools() {
  try {
    const { data } = await throttledGet(`${BASE}/trending_pools`, { timeout: 15000 });
    return (data?.data || []).map(parsePool).filter(Boolean);
  } catch (err) {
    logger.warn('GeckoTerminal getTrendingPools failed', { error: err.message });
    return [];
  }
}

/**
 * Resolve a token mint (e.g. from PumpPortal's creation feed, which gives a
 * mint but not a GeckoTerminal pool address) to its pool(s). Best-effort -
 * not confirmed live before shipping, fails safe to empty so a brand-new
 * mint with no indexed pool yet (or a wrong guess at this endpoint's shape)
 * just means that token is picked up on the next new_pools poll instead.
 */
async function getPoolsForToken(mint) {
  try {
    const { data } = await throttledGet(`${BASE}/tokens/${mint}/pools`, { timeout: 10000 });
    return (data?.data || []).map(parsePool).filter(Boolean);
  } catch (err) {
    logger.debug('GeckoTerminal getPoolsForToken miss', { mint, error: err.message });
    return [];
  }
}

async function getPoolDetail(poolAddress) {
  try {
    const { data } = await throttledGet(`${BASE}/pools/${poolAddress}`, { timeout: 10000 });
    return parsePool(data?.data);
  } catch (err) {
    logger.warn('GeckoTerminal getPoolDetail failed', { poolAddress, error: err.message });
    return null;
  }
}

/**
 * Recent trades for a pool - used as the insider-buy/sell proxy fallback and
 * for volume-spike cross-checks. Free, no key, same endpoint family as the
 * rest of this module.
 */
async function getPoolTrades(poolAddress) {
  try {
    const { data } = await throttledGet(`${BASE}/pools/${poolAddress}/trades`, { timeout: 10000 });
    return (data?.data || []).map((t) => {
      const a = t.attributes || {};
      return {
        kind: a.kind, // 'buy' | 'sell'
        walletAddress: a.tx_from_address,
        volumeUsd: Number(a.volume_in_usd),
        blockTimestamp: a.block_timestamp ? new Date(a.block_timestamp).getTime() : null,
      };
    }).filter((t) => Number.isFinite(t.volumeUsd));
  } catch (err) {
    logger.warn('GeckoTerminal getPoolTrades failed', { poolAddress, error: err.message });
    return [];
  }
}

module.exports = {
  getNewPools, getTrendingPools, getPoolDetail, getPoolTrades, getPoolsForToken,
};
