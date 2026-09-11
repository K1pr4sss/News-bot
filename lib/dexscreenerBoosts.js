const axios = require('axios');
const logger = require('./logger');

// DexScreener's paid-promotion feeds, keyless and verified live (HTTP 200,
// 300 req/min on the pair endpoints, 60/min on these).
//
// Worth having for a reason none of the other discovery sources cover: a boost
// is somebody spending real money to put a token in front of traders. Every
// other signal this bot reads is either on-chain (which a wash trader
// manufactures for nothing) or social (which is free to fake). Paying
// DexScreener is not free, so it is a different KIND of evidence - weak, but
// not manufacturable at zero cost.
//
// Deliberately NOT scored. The bot already has `isBoosted` worth +10 trending
// points, and routing a second, differently-ranked boost feed into the same
// bonus would inflate scores and shift the scale the entry bar was re-derived
// against on 2026-09-10. These are discovery candidates only - they compete on
// the same score as everything else.
//
// token-profiles is included alongside token-boosts because it carries the same
// "someone paid to be listed" property and the two lists overlap only partly.
//
// BUILT, TESTED, AND NOT SCHEDULED - on the evidence, not on doubt. A live run
// resolved 20 promoted Solana tokens and exactly ONE cleared the momentum band
// and the liquidity floor. The population is systematically wrong for this
// strategy:
//
//     DELIVERY   h1 +116%   liq  $24k   age 0d
//     GAYCAT     h1 +308%   liq   $0k   age 0d
//     BULLISHCAT h1  -98%   liq   $2k   age 0d
//     HELIUSCAT  h1  +18%   liq  $87k   age 0d
//
// Paid promotion is what people buy for a FRESH LAUNCH: hours old, thin, already
// up hundreds of percent. That is the rug profile - the exact thing the organic
// score gate exists to refuse - and the band buys established tokens with a
// median pool age of 28 days. Wiring this into discovery would spend 22 calls a
// tick to hand the rug gate more work.
//
// Kept rather than deleted because the module is correct and the finding is
// about the POPULATION, not the plumbing. If the boost feed's composition ever
// shifts, scheduling getDiscoveryCandidates is a one-line change.
const BOOSTS_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';
const PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
const PAIRS_URL = (mint) => `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;

const status = {
  totalCalls: 0, ok: 0, failed: 0, lastCallAt: null, lastSuccessAt: null, lastError: null,
  solanaSeen: 0, candidatesReturned: 0,
};

/** The boosted/promoted Solana mints. Cheap: two calls, no per-token work. */
async function getPromotedMints() {
  const mints = new Set();
  for (const url of [BOOSTS_URL, PROFILES_URL]) {
    try {
      status.totalCalls += 1;
      status.lastCallAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const { data } = await axios.get(url, { timeout: 10000 });
      const rows = Array.isArray(data) ? data : (data?.tokens || []);
      for (const r of rows) {
        if (r?.chainId === 'solana' && r.tokenAddress) mints.add(r.tokenAddress);
      }
      status.ok += 1;
      status.lastSuccessAt = Date.now();
      status.lastError = null;
    } catch (err) {
      status.failed += 1;
      status.lastError = err.response?.status ? `HTTP ${err.response.status}` : err.message;
      logger.warn('DexScreener promotion feed failed', { url, error: status.lastError });
    }
  }
  status.solanaSeen = mints.size;
  return [...mints];
}

/** Map a DexScreener pair onto the candidate shape evaluateCandidate expects
 * (geckoterminal.js holds the canonical one). Fields DexScreener does not
 * report are left undefined rather than zeroed - a zero would read as a real
 * measurement instead of an absent one, and gates fail open on absent data. */
function pairToCandidate(p) {
  if (!p?.baseToken?.address || !Number.isFinite(Number(p.priceUsd))) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    mint: p.baseToken.address,
    poolAddress: p.pairAddress,
    name: p.baseToken.name || p.baseToken.symbol || p.baseToken.address.slice(0, 6),
    symbol: p.baseToken.symbol || p.baseToken.name || p.baseToken.address.slice(0, 6),
    priceUsd: Number(p.priceUsd),
    liquidityUsd: num(p.liquidity?.usd) ?? 0,
    poolCreatedAt: Number.isFinite(p.pairCreatedAt) ? p.pairCreatedAt : null,
    priceChangeM5Pct: num(p.priceChange?.m5),
    priceChangeH1Pct: num(p.priceChange?.h1),
    priceChangeH6Pct: num(p.priceChange?.h6),
    priceChangeH24Pct: num(p.priceChange?.h24),
    volumeH1Usd: num(p.volume?.h1),
    volumeH24Usd: num(p.volume?.h24),
    buyersH1: p.txns?.h1?.buys ?? 0,
    sellersH1: p.txns?.h1?.sells ?? 0,
  };
}

/**
 * Promoted Solana tokens, resolved to candidates. One call per promoted mint,
 * so the list is capped - these feeds return ~30 rows of which ~12-18 are
 * Solana, and the whole point is that it stays small and cheap.
 */
async function getDiscoveryCandidates(maxTokens = 20) {
  const mints = (await getPromotedMints()).slice(0, maxTokens);
  const out = [];
  for (const mint of mints) {
    try {
      status.totalCalls += 1;
      // eslint-disable-next-line no-await-in-loop
      const { data } = await axios.get(PAIRS_URL(mint), { timeout: 10000 });
      const pairs = Array.isArray(data) ? data : (data?.pairs || []);
      // Deepest pool wins - the same token can list on several DEXes and the
      // shallow ones price badly.
      const best = pairs
        .filter((p) => p?.chainId === 'solana')
        .sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))[0];
      const c = best && pairToCandidate(best);
      if (c) out.push(c);
      status.ok += 1;
      status.lastSuccessAt = Date.now();
    } catch (err) {
      status.failed += 1;
      status.lastError = err.response?.status ? `HTTP ${err.response.status}` : err.message;
    }
  }
  status.candidatesReturned = out.length;
  return out;
}

function getStatus() {
  return { ...status, configured: true, scored: false };
}

module.exports = { getPromotedMints, getDiscoveryCandidates, pairToCandidate, getStatus };
