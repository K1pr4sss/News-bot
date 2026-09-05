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
//
// Priority-ordered, not strict FIFO - real bug found via live trade data
// (2026-09-01): PumpPortal schedules a getPoolsForToken lookup for EVERY
// single new token it discovers (dozens/minute under real load), sharing
// this exact queue with exit-tick's own getPoolsForToken calls for ALREADY-
// OPEN positions. A real position (GAMESTONK) crashed >40% within minutes
// of entry (confirmed against real GeckoTerminal OHLCV history) but its
// stop-loss didn't fire for 85 minutes - the exit-tick check for that
// specific position was stuck behind a growing backlog of speculative
// brand-new-token lookups the whole time. Money already at risk must never
// queue behind tokens nobody has bought yet. High-priority callers (exit-
// tick) always jump ahead of low-priority ones (discovery/new-token
// resolution) while the TOTAL combined rate still respects the same single
// MIN_SPACING_MS floor - this reorders the existing queue, it does not add
// a second parallel one (which would double real request volume and risk
// reintroducing the exact 429s this queue exists to prevent).
const MIN_SPACING_MS = 2100;
let lastCallAt = 0;
const highQueue = [];
const lowQueue = [];
let processing = false;

function enqueue(run, priority) {
  return new Promise((resolve, reject) => {
    (priority === 'high' ? highQueue : lowQueue).push({ run, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (highQueue.length || lowQueue.length) {
    // Wait FIRST, pick the item to dispatch SECOND - a high-priority item
    // that arrives while a low-priority one is already waiting out the
    // spacing floor must still win the next dispatch. Picking the item
    // before the wait (the original version of this queue) would let an
    // already-claimed low-priority item run ahead of a high-priority one
    // that arrived moments later but before the wait actually elapsed.
    const wait = Math.max(0, lastCallAt + MIN_SPACING_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait)); // eslint-disable-line no-await-in-loop
    const item = highQueue.shift() || lowQueue.shift();
    if (!item) break; // drained by the wait somehow - nothing left to dispatch
    lastCallAt = Date.now();
    try {
      item.resolve(await item.run()); // eslint-disable-line no-await-in-loop
    } catch (err) {
      item.reject(err);
    }
  }
  processing = false;
}

function throttledGet(url, opts, priority = 'low') {
  const run = async () => {
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
  return enqueue(run, priority);
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

/**
 * `duration` selects the trending WINDOW (5m / 1h / 6h / 24h) and was never
 * passed until 2026-09-05, so this always returned the 24h list. Measured
 * live, that default is close to useless for this bot: its pools had a median
 * age of ~13,871 minutes (nine days, with a 483-day-old coin at the top) and
 * ZERO of them cleared a 50% h1 momentum bar. It surfaces what has been big
 * for a day, not what is moving now.
 *
 * With the bot's other source being new_pools (median age 2 min, where nothing
 * passes the top-holder filter because the creator still holds ~80% of supply),
 * that left a hole exactly where the tradeable coins live: launched hours ago,
 * real liquidity, distributed enough to pass the safety filters, running right
 * now. The 5m/1h windows fill it - sampled live they added 12 candidates the
 * bot could not otherwise see, ALL of them clearing the $5k liquidity floor
 * (against 5 of 20 for new_pools).
 */
async function getTrendingPools(duration) {
  const url = duration ? `${BASE}/trending_pools?duration=${duration}` : `${BASE}/trending_pools`;
  try {
    const { data } = await throttledGet(url, { timeout: 15000 });
    return (data?.data || []).map(parsePool).filter(Boolean);
  } catch (err) {
    logger.warn('GeckoTerminal getTrendingPools failed', { duration: duration || '24h', error: err.message });
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
async function getPoolsForToken(mint, priority = 'low') {
  try {
    const { data } = await throttledGet(`${BASE}/tokens/${mint}/pools`, { timeout: 10000 }, priority);
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
