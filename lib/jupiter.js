const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// Jupiter's quote API, used to measure what a trade ACTUALLY costs instead of
// assuming it. This is the only input in the whole bot that is a measurement
// rather than an inference, and it is the reason it exists.
//
// Every cost figure the bot has ever used was the flat paperSlippagePct guess:
// 1% per leg, 2% per round trip, identical for every coin. Quoting 12 real
// band-era holdings both ways - SOL in, then the tokens straight back out -
// gives the true round trip including LP fees, price impact and routing on
// both legs:
//
//     CAPY    0.54%      PIXEL    2.02%      HOOD    3.36%
//     OTC     0.60%      HeeHaw   2.01%      ZCAT    5.90%
//     Jimothy 1.00%      STABLE   2.23%      LOOM    7.80%
//     CTO     1.28%      Pinata   2.37%
//     moonkey 1.48%
//
// The MEDIAN is 2.02% - the 2% assumption was right, which is worth stating
// plainly because the hypothesis going in was that it was too pessimistic.
// What the assumption missed is the SPREAD. p90 is 5.90%. A coin costing 7.80%
// to round-trip starts 7.80% underwater against a target the bot expects to
// clear in maybe 2.8%, so it cannot win no matter what the price does, and the
// bot was taking those trades blind. LOOM, the most expensive coin measured,
// was also the worst loser of the band era.
//
// A quote is one HTTP call per candidate that has already passed every other
// filter - a handful an hour - so the free tier's rate limit is never near
// binding in normal operation. It still fails OPEN: a Jupiter outage must
// degrade the bot to its old blind behaviour, never halt it.
const QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const WSOL = 'So11111111111111111111111111111111111111112';
const CACHE_TTL_MS = 60 * 1000;

const cache = new Map();
const status = {
  totalQuotes: 0, ok: 0, failed: 0, rateLimited: 0,
  lastCallAt: null, lastSuccessAt: null, lastError: null,
};

async function quote(inputMint, outputMint, amount) {
  const { data } = await axios.get(QUOTE_URL, {
    params: {
      inputMint, outputMint, amount: String(amount), slippageBps: 100,
    },
    timeout: 8000,
  });
  return data;
}

/**
 * True round-trip cost of trading `amountSol` of `mint`, as a percentage of the
 * SOL put in. Buys the token with SOL, then sells exactly those tokens back,
 * and reports the SOL that fails to return. That single number contains both
 * LP fees, both price impacts and any routing cost - there is nothing left to
 * estimate.
 *
 * Returns null when the cost cannot be established (no route, network error,
 * rate limit). Null means UNKNOWN and callers must treat it as such: a missing
 * reading may never be the reason a trade is refused, for the same reason the
 * momentum gate fails open on a missing h1.
 */
async function getRoundTripCostPct(mint, amountSol) {
  if (!mint || !(amountSol > 0)) return null;
  const lamports = Math.round(amountSol * 1e9);
  const key = `${mint}:${lamports}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  status.totalQuotes += 1;
  status.lastCallAt = Date.now();
  try {
    const buy = await quote(WSOL, mint, lamports);
    const tokensOut = Number(buy?.outAmount);
    if (!Number.isFinite(tokensOut) || tokensOut <= 0) throw new Error('no buy route');

    // Quote the EXACT tokens back rather than a notional amount - anything else
    // measures a different trade than the one the bot would actually unwind.
    const sell = await quote(mint, WSOL, tokensOut);
    const solBack = Number(sell?.outAmount);
    if (!Number.isFinite(solBack) || solBack <= 0) throw new Error('no sell route');

    const costPct = ((lamports - solBack) / lamports) * 100;
    // A negative cost is arbitrage, not a discount - it means the two legs
    // routed through different venues at momentarily inconsistent prices. Floor
    // at zero rather than let it flatter a trade.
    const value = Math.max(0, Number(costPct.toFixed(3)));
    cache.set(key, { at: Date.now(), value });
    status.ok += 1;
    status.lastSuccessAt = Date.now();
    status.lastError = null;
    return value;
  } catch (err) {
    if (err.response?.status === 429) status.rateLimited += 1;
    status.failed += 1;
    status.lastError = err.response?.status ? `HTTP ${err.response.status}` : err.message;
    logger.debug('Jupiter round-trip quote failed - treating cost as unknown', {
      mint, amountSol, error: status.lastError,
    });
    cache.set(key, { at: Date.now(), value: null });
    return null;
  }
}

/**
 * The gate. Separated from the measurement so the "unknown fails open" rule
 * lives in exactly one place and is testable on its own.
 */
function isCostAcceptable(costPct) {
  if (config.maxRoundTripCostPct <= 0) return { ok: true, reason: null };
  if (costPct === null || costPct === undefined) return { ok: true, reason: null };
  if (costPct > config.maxRoundTripCostPct) {
    return {
      ok: false,
      reason: `round-trip cost ${costPct.toFixed(2)}% over the ${config.maxRoundTripCostPct}% ceiling `
        + '(measured live via Jupiter, not modelled - this trade starts that far underwater)',
    };
  }
  return { ok: true, reason: null };
}

function getStatus() {
  return { ...status, configured: true, ceilingPct: config.maxRoundTripCostPct, cacheSize: cache.size };
}

module.exports = { getRoundTripCostPct, isCostAcceptable, getStatus, WSOL };
