const config = require('./config');
const logger = require('./logger');
const rugcheck = require('./rugcheck');
const pumpfunApi = require('./pumpfunApi');
const geckoterminal = require('./geckoterminal');
const coingecko = require('./coingecko');
const reddit = require('./reddit');
const walletTracker = require('./walletTracker');
const dexscreener = require('./dexscreener');
const scoring = require('./scoring');
const filters = require('./filters');
const positions = require('./positions');
const telegramBot = require('./telegramBot');

const lastEvaluatedAt = new Map(); // mint -> ms, throttles repeat API calls on a token still sitting in the discovery window

/**
 * Enrich a raw GeckoTerminal candidate with every signal source, score it,
 * run safety filters, and attempt a paper entry if everything clears. Called
 * from both the discovery poll (index.js) and the trending-pools poll.
 */
async function evaluateCandidate(token, { trendingPool = false } = {}) {
  const now = Date.now();
  const last = lastEvaluatedAt.get(token.mint);
  if (last && now - last < config.discoveryPollIntervalMs) return;
  lastEvaluatedAt.set(token.mint, now);

  if (!Number.isFinite(token.priceUsd) || !Number.isFinite(token.liquidityUsd)) return;

  const [rugcheckReport, socials] = await Promise.all([
    rugcheck.getFullReport(token.mint),
    pumpfunApi.getSocials(token.mint),
  ]);

  const enriched = {
    ...token,
    socialsCount: socials.count,
    matchedTrendingKeyword: coingecko.matchesTrending(token.name),
    matchedTrendingPool: trendingPool,
    isBoosted: dexscreener.isBoosted(token.mint),
    insiderBuyerCount: walletTracker.getBuyerCount(token.mint),
  };

  const redditSignal = reddit.getSignal(token.symbol || token.name);
  enriched.mentionCount = redditSignal.mentionCount;
  enriched.positiveRatio = redditSignal.positiveRatio;

  const scoreResult = scoring.scoreToken(enriched);
  const { pass, reasons: filterReasons } = filters.runSafetyFilters(enriched, rugcheckReport);

  logger.debug('Candidate evaluated', {
    mint: token.mint, symbol: token.symbol, score: scoreResult.score, pass, filterReasons,
  });

  if (!pass) return;
  if (scoreResult.score < config.scoreAlertThreshold) return;
  if (scoreResult.volumeRatio < config.entryVolumeSpikeMultiplier) return;

  const alertLines = [
    `🚀 ${enriched.symbol} scored ${scoreResult.score}/100`,
    `Mint: ${token.mint}`,
    `Liquidity: $${Math.round(token.liquidityUsd).toLocaleString()}`,
    ...scoreResult.reasons,
  ];

  const entry = await positions.attemptEntry(enriched, scoreResult);
  if (entry) {
    alertLines.push(`\n✅ Paper-bought ${entry.amountSol.toFixed(4)} SOL (${entry.tier.label} band)`);
  }
  telegramBot.sendAlert(alertLines.join('\n'));
}

/**
 * Live price + re-score for an OPEN position, used by the exit poll loop.
 * Deliberately skips RugCheck/socials re-fetches (safety filters don't run
 * again post-entry, and neither field feeds scoring.js's rubric) - only
 * pulls what the exit ladder actually needs: current price, current volume
 * ratio, and the same trending/insider/social components as entry scoring.
 */
async function getLiveTokenAndScore(position) {
  const priceInfo = await dexscreener.getTokenPriceUsd(position.mint);
  if (!priceInfo) return null;

  const pools = await geckoterminal.getPoolsForToken(position.mint);
  const pool = pools[0];

  const redditSignal = reddit.getSignal(position.symbol || position.name);
  const enriched = {
    priceUsd: priceInfo.priceUsd,
    volumeH1Usd: pool?.volumeH1Usd || 0,
    volumeH24Usd: pool?.volumeH24Usd || 0,
    matchedTrendingKeyword: coingecko.matchesTrending(position.name),
    matchedTrendingPool: false,
    isBoosted: dexscreener.isBoosted(position.mint),
    insiderBuyerCount: walletTracker.getBuyerCount(position.mint),
    mentionCount: redditSignal.mentionCount,
    positiveRatio: redditSignal.positiveRatio,
  };

  return { liveToken: enriched, scoreResult: scoring.scoreToken(enriched) };
}

module.exports = { evaluateCandidate, getLiveTokenAndScore };
