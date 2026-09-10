const axios = require('axios');
const logger = require('./logger');

// Jupiter's Token API v2, keyless on lite-api.jup.ag. One call returns more of
// what this bot cares about than any other single source it uses:
//
//   organicScore + organicScoreLabel   Jupiter's own "is this real activity or
//                                      manufactured" metric
//   holderCount                        currently from Birdeye, which needs a key
//                                      and rate-limits hard on the free tier
//   audit.topHoldersPercentage         currently from RugCheck, frequently null
//   audit.mintAuthorityDisabled        also RugCheck
//   audit.freezeAuthorityDisabled      also RugCheck
//   audit.devMints / devMigrations     the serial-rugger signal RugCheck could
//                                      not supply - creatorTokens comes back null
//   launchpad / graduatedAt            pump.fun graduation, currently inferred
//   firstPool.createdAt                pool age, currently from GeckoTerminal
//   stats24h.buyOrganicVolume          organic vs total volume - a direct read
//                                      on the wash trading the literature says
//                                      precedes 56% of pump-and-dumps
//
// RECORDED, NOT GATED - and that is a deliberate call, not laziness. Tested
// against all 95 traded mints, NOTHING here predicts the outcome:
//
//   devMints          flips or negative in both halves at every cut
//   devMigrations     same
//   organicScore      flips; the 70+ bucket is the WORST (-10.3%, 0% win)
//   holderCount       no signal
//   topHoldersPct     flips
//   label "high"      -11.8%, 0 wins of 6
//
// The one apparent gap - graduated -3.9% vs not-graduated -15.9% - is 11 tokens
// that all sit in the later half, so there is no train leg to check it against,
// and "not graduated" there really means "Jupiter has no launchpad record",
// which is a data-coverage fact rather than a quality one.
//
// So this is adopted as better PLUMBING, not as a signal: keyless where Birdeye
// needs a key, one call where RugCheck plus Birdeye plus GeckoTerminal are three,
// and complete where RugCheck's fields are often null. Recording it now is what
// makes it possible to re-check any of the above on real forward data instead of
// on 95 backward-looking mints.
const SEARCH_URL = 'https://lite-api.jup.ag/tokens/v2/search';
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map();
const status = {
  totalCalls: 0, ok: 0, failed: 0, lastCallAt: null, lastSuccessAt: null, lastError: null,
};

const EMPTY = {
  organicScore: null,
  organicScoreLabel: null,
  holderCount: null,
  topHoldersPct: null,
  devBalancePct: null,
  devMints: null,
  devMigrations: null,
  mintAuthorityDisabled: null,
  freezeAuthorityDisabled: null,
  launchpad: null,
  graduated: null,
  poolCreatedAt: null,
  buyVolume24h: null,
  buyOrganicVolume24h: null,
  organicVolumeShare: null,
};

async function getTokenData(mint) {
  if (!mint) return EMPTY;
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  status.totalCalls += 1;
  status.lastCallAt = Date.now();
  try {
    const { data } = await axios.get(SEARCH_URL, { params: { query: mint }, timeout: 8000 });
    const t = Array.isArray(data) ? data[0] : null;
    if (!t) throw new Error('no token returned');

    const buy = t.stats24h?.buyVolume;
    const buyOrganic = t.stats24h?.buyOrganicVolume;
    const value = {
      organicScore: Number.isFinite(t.organicScore) ? Number(t.organicScore.toFixed(2)) : null,
      organicScoreLabel: t.organicScoreLabel ?? null,
      holderCount: Number.isFinite(t.holderCount) ? t.holderCount : null,
      topHoldersPct: Number.isFinite(t.audit?.topHoldersPercentage)
        ? Number(t.audit.topHoldersPercentage.toFixed(2)) : null,
      devBalancePct: Number.isFinite(t.audit?.devBalancePercentage)
        ? Number(t.audit.devBalancePercentage.toFixed(3)) : null,
      devMints: t.audit?.devMints ?? null,
      devMigrations: t.audit?.devMigrations ?? null,
      mintAuthorityDisabled: t.audit?.mintAuthorityDisabled ?? null,
      freezeAuthorityDisabled: t.audit?.freezeAuthorityDisabled ?? null,
      launchpad: t.launchpad ?? null,
      graduated: t.graduatedAt ? true : false,
      poolCreatedAt: t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : null,
      buyVolume24h: Number.isFinite(buy) ? Math.round(buy) : null,
      buyOrganicVolume24h: Number.isFinite(buyOrganic) ? Math.round(buyOrganic) : null,
      // The share of buying that Jupiter considers real. Low means the volume
      // that looks like demand is mostly not.
      organicVolumeShare: (Number.isFinite(buy) && buy > 0 && Number.isFinite(buyOrganic))
        ? Number((buyOrganic / buy).toFixed(3)) : null,
    };
    cache.set(mint, { at: Date.now(), value });
    status.ok += 1;
    status.lastSuccessAt = Date.now();
    status.lastError = null;
    return value;
  } catch (err) {
    status.failed += 1;
    status.lastError = err.response?.status ? `HTTP ${err.response.status}` : err.message;
    logger.debug('Jupiter token lookup failed - recording nulls', { mint, error: status.lastError });
    cache.set(mint, { at: Date.now(), value: EMPTY });
    return EMPTY;
  }
}

// --- Discovery -------------------------------------------------------------
// The bot's other discovery sources are all pointed at NEW coins - PumpPortal
// pushes pump.fun creations, GeckoTerminal's new_pools returns two-minute-old
// pools - while the strategy now buys ESTABLISHED tokens (median pool age at
// entry: 28 days). Nothing was looking where the band actually shops.
//
// Jupiter's category endpoints are keyless and return exactly that profile.
// Measured on toptrending: median pool age 35.9 days, median liquidity
// $158,102 - against band entries that ran $73k-$513k. Checked against the
// 18,923 mints the bot had actually processed over 43 hours:
//
//     toptrending      100 tokens   48 already seen   52 NEW   5 novel AND tradeable
//     toporganicscore  100 tokens   63 already seen   37 NEW   1 novel AND tradeable
//
// Half is duplicate coverage, which is fine - dedup is cheap. The novel slice
// is small per snapshot but it is the right KIND of coin, including things the
// new-pool sources structurally cannot surface: wPOND at 702 days old with
// 6,752 holders and an organic score of 70 was never going to appear in a feed
// of two-minute-old pools.
//
// Two calls per tick against a rate limit that tolerates roughly one request
// every 1.5s, so this is nowhere near binding at a multi-minute interval.
const CATEGORY_URL = (cat, limit) => `https://lite-api.jup.ag/tokens/v2/${cat}/24h?limit=${limit}`;

/** Map Jupiter's token shape onto the candidate shape evaluateCandidate expects
 * (see geckoterminal.js for the canonical one). Anything Jupiter does not carry
 * is left undefined rather than zero - a zero would read as a real measurement
 * of "no buyers" instead of "not reported". */
function toCandidate(t) {
  if (!t?.id || !Number.isFinite(t.usdPrice)) return null;
  const h1 = t.stats1h || {};
  const h24 = t.stats24h || {};
  return {
    mint: t.id,
    name: t.name || t.symbol || t.id.slice(0, 6),
    symbol: t.symbol || t.name || t.id.slice(0, 6),
    priceUsd: t.usdPrice,
    liquidityUsd: Number.isFinite(t.liquidity) ? t.liquidity : 0,
    poolCreatedAt: t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : null,
    priceChangeM5Pct: Number.isFinite(t.stats5m?.priceChange) ? t.stats5m.priceChange : undefined,
    priceChangeH1Pct: Number.isFinite(h1.priceChange) ? h1.priceChange : undefined,
    priceChangeH24Pct: Number.isFinite(h24.priceChange) ? h24.priceChange : undefined,
    volumeH1Usd: (Number.isFinite(h1.buyVolume) && Number.isFinite(h1.sellVolume))
      ? h1.buyVolume + h1.sellVolume : undefined,
    volumeH24Usd: (Number.isFinite(h24.buyVolume) && Number.isFinite(h24.sellVolume))
      ? h24.buyVolume + h24.sellVolume : undefined,
    buyersH1: Number.isFinite(h1.numBuys) ? h1.numBuys : 0,
    sellersH1: Number.isFinite(h1.numSells) ? h1.numSells : 0,
  };
}

/** Trending + top-organic-score, deduped. Returns candidate-shaped objects. */
async function getDiscoveryCandidates(limit = 100) {
  const out = new Map();
  for (const cat of ['toptrending', 'toporganicscore']) {
    try {
      status.totalCalls += 1;
      status.lastCallAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const { data } = await axios.get(CATEGORY_URL(cat, limit), { timeout: 12000 });
      if (!Array.isArray(data)) continue;
      for (const t of data) {
        const c = toCandidate(t);
        if (c && !out.has(c.mint)) out.set(c.mint, c);
      }
      status.ok += 1;
      status.lastSuccessAt = Date.now();
      status.lastError = null;
    } catch (err) {
      status.failed += 1;
      status.lastError = err.response?.status ? `HTTP ${err.response.status}` : err.message;
      logger.warn('Jupiter discovery category failed', { cat, error: status.lastError });
    }
  }
  return [...out.values()];
}

function getStatus() {
  return { ...status, configured: true, gated: false, cacheSize: cache.size };
}

module.exports = {
  getTokenData, getDiscoveryCandidates, toCandidate, getStatus, EMPTY,
};
