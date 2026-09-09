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

function getStatus() {
  return { ...status, configured: true, gated: false, cacheSize: cache.size };
}

module.exports = { getTokenData, getStatus, EMPTY };
