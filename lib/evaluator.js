const config = require('./config');
const logger = require('./logger');
const rugcheck = require('./rugcheck');
const pumpfunApi = require('./pumpfunApi');
const birdeye = require('./birdeye');
const geckoterminal = require('./geckoterminal');
const coingecko = require('./coingecko');
const reddit = require('./reddit');
const googleAlerts = require('./googleAlerts');
const telegramUserClient = require('./telegramUserClient');
const youtube = require('./youtube');
const dexscreener = require('./dexscreener');
const scoring = require('./scoring');
const filters = require('./filters');
const positions = require('./positions');
const telegramBot = require('./telegramBot');
const stats = require('./stats');

const lastEvaluatedAt = new Map(); // mint -> ms, throttles repeat API calls on a token still sitting in the discovery window
// mint -> { token, firstSeenAt } - candidates that failed ONLY on
// reasons time can fix (thin liquidity, concentrated holders - see
// isImprovableReason below), re-checked independently of whether the token
// still shows up in GeckoTerminal's new_pools/trending_pools responses.
const pendingCandidates = new Map();

// Reasons a young token can genuinely grow out of vs. ones that are fixed
// facts about the token that more time can't change. Getting this wrong in
// the "improvable" direction just means one wasted recheck before eviction;
// getting it wrong in the "permanent" direction means silently giving up on
// a token that might have passed a few minutes later - err toward improvable.
function isPermanentReason(reason) {
  return reason.startsWith('copycat')
    || reason.startsWith('RugCheck verdict')
    || reason.startsWith('mint authority')
    || reason.startsWith('freeze authority')
    || reason.startsWith('age '); // only ever gets worse, never better
}

/**
 * Enrich a raw GeckoTerminal candidate with every signal source, score it,
 * run safety filters, and attempt a paper entry if everything clears. Called
 * from both the discovery poll (index.js), the trending-pools poll, and the
 * pending-candidate retry tick (see pendingCandidatesTick below).
 */
async function evaluateCandidate(token, { trendingPool = false, isRetry = false } = {}) {
  const now = Date.now();
  if (!isRetry) {
    const last = lastEvaluatedAt.get(token.mint);
    if (last && now - last < config.discoveryPollIntervalMs) return;
    lastEvaluatedAt.set(token.mint, now);
  }

  if (!Number.isFinite(token.priceUsd) || !Number.isFinite(token.liquidityUsd)) return;
  stats.recordScanned();

  const [rugcheckReport, socials, birdeyeOverview] = await Promise.all([
    rugcheck.getFullReport(token.mint),
    pumpfunApi.getSocials(token.mint),
    birdeye.getTokenOverview(token.mint),
  ]);

  const enriched = {
    ...token,
    socialsCount: socials.count,
    matchedTrendingKeyword: coingecko.matchesTrending(token.name),
    matchedTrendingPool: trendingPool,
    isBoosted: dexscreener.isBoosted(token.mint),
  };

  const redditSignal = reddit.getSignal(token.symbol || token.name);
  const alertsSignal = googleAlerts.getSignal(token.symbol || token.name);
  const telegramSignal = telegramUserClient.getSignal(token.symbol || token.name);
  enriched.mentionCount = redditSignal.mentionCount + alertsSignal.mentionCount + telegramSignal.mentionCount;
  enriched.positiveRatio = redditSignal.positiveRatio; // other sources are too sparse for a meaningful sentiment read - Reddit stays the only sentiment source

  const { pass, reasons: filterReasons } = filters.runSafetyFilters(enriched, rugcheckReport, birdeyeOverview);
  let scoreResult = scoring.scoreToken(enriched);

  // YouTube is spent ONLY on candidates that already look promising (passed
  // filters, clear the volume gate, and are within striking distance of the
  // score threshold without it) - see youtube.js for why: real quota is 100
  // searches/day, and blanket-checking every raw candidate would exhaust it
  // in minutes given how many tokens PumpPortal alone produces.
  if (pass && scoreResult.volumeRatio >= config.entryVolumeSpikeMultiplier && scoreResult.score >= config.scoreAlertThreshold - 10) {
    const youtubeMentions = await youtube.searchMentionCount(token.symbol || token.name);
    if (youtubeMentions > 0) {
      enriched.mentionCount += youtubeMentions;
      scoreResult = scoring.scoreToken(enriched);
    }
  }

  logger.debug('Candidate evaluated', {
    mint: token.mint, symbol: token.symbol, score: scoreResult.score, pass, filterReasons,
  });

  if (!pass) {
    stats.recordRejection(filterReasons);
    if (scoreResult.score >= config.scoreAlertThreshold - 15) {
      stats.recordNearMiss({
        symbol: enriched.symbol, mint: token.mint, score: scoreResult.score, reason: filterReasons[0],
      });
    }
    if (filterReasons.every((r) => !isPermanentReason(r))) {
      const existing = pendingCandidates.get(token.mint);
      pendingCandidates.set(token.mint, { token, firstSeenAt: existing?.firstSeenAt ?? now });
    } else {
      pendingCandidates.delete(token.mint);
    }
    return;
  }
  pendingCandidates.delete(token.mint); // cleared every filter - no longer needs time-based retries

  if (scoreResult.score < config.scoreAlertThreshold) {
    stats.recordRejection([`scored_low(${scoreResult.score})`]);
    if (scoreResult.score >= config.scoreAlertThreshold - 15) {
      stats.recordNearMiss({
        symbol: enriched.symbol, mint: token.mint, score: scoreResult.score, reason: 'score too low',
      });
    }
    return;
  }
  if (scoreResult.volumeRatio < config.entryVolumeSpikeMultiplier) {
    stats.recordRejection(['volume_spike_too_low']);
    return;
  }

  // The actual "has to be HYPED, not just have liquidity/volume" gate -
  // score/volume/filters can all clear on pure on-chain price action with
  // zero evidence anyone's actually talking about this coin anywhere. See
  // config.js's minMentionCount comment for the full reasoning.
  if (enriched.mentionCount < config.minMentionCount) {
    stats.recordRejection([`no real mentions (${enriched.mentionCount} < ${config.minMentionCount} required)`]);
    return;
  }

  stats.recordAlert({ symbol: enriched.symbol, mint: token.mint, score: scoreResult.score });

  const alertLines = [
    `🚀 ${enriched.symbol} scored ${scoreResult.score}/100`,
    `Mint: ${token.mint}`,
    `Liquidity: $${Math.round(token.liquidityUsd).toLocaleString()}`,
    ...scoreResult.reasons,
  ];

  const entry = await positions.attemptEntry(enriched, scoreResult);
  if (entry) {
    alertLines.push(`\n✅ Paper-bought ${entry.amountSol.toFixed(4)} SOL (${entry.tier.label} band)`);
  } else if (positions.isPaused()) {
    alertLines.push('\n⏸️ Auto-buy is paused - not bought.');
  }
  telegramBot.sendAlert(alertLines.join('\n'));
}

/**
 * Live price + re-score for an OPEN position, used by the exit poll loop.
 * Deliberately skips a RugCheck re-fetch (safety filters don't run again
 * post-entry) - only pulls what the exit ladder actually needs: current
 * price, current volume ratio, and the same trending/social components as
 * entry scoring. Socials count is reused from entry (persisted on the
 * position row as entry_socials_count) rather than re-fetched - a token's
 * twitter/telegram/website links don't meaningfully change within a single
 * position's hold time, and re-fetching would cost a pumpfunApi call every
 * ~10s per open position for a number that's essentially fixed. Regression:
 * this used to omit socialsCount entirely (built before that scoring
 * category existed), which meant every open position lost up to 15 real
 * entry-score points on its very first exit-tick re-score for free,
 * structurally biasing the score-drop exit trigger toward firing early -
 * not a real hype decline, just a missing field.
 */
async function getLiveTokenAndScore(position) {
  const priceInfo = await dexscreener.getTokenPriceUsd(position.mint);
  if (!priceInfo) return null;

  const pools = await geckoterminal.getPoolsForToken(position.mint);
  const pool = pools[0];

  // Deliberately excludes YouTube - this runs every ~10s per open position,
  // and re-searching a slow-moving signal (video mentions don't change
  // meaningfully second to second) that often would just burn the daily
  // budget for no real benefit. YouTube only factors into the entry decision.
  const redditSignal = reddit.getSignal(position.symbol || position.name);
  const alertsSignal = googleAlerts.getSignal(position.symbol || position.name);
  const telegramSignal = telegramUserClient.getSignal(position.symbol || position.name);
  const enriched = {
    priceUsd: priceInfo.priceUsd,
    volumeH1Usd: pool?.volumeH1Usd || 0,
    volumeH24Usd: pool?.volumeH24Usd || 0,
    matchedTrendingKeyword: coingecko.matchesTrending(position.name),
    matchedTrendingPool: false,
    isBoosted: dexscreener.isBoosted(position.mint),
    socialsCount: position.entry_socials_count || 0,
    mentionCount: redditSignal.mentionCount + alertsSignal.mentionCount + telegramSignal.mentionCount,
    positiveRatio: redditSignal.positiveRatio,
  };

  return { liveToken: enriched, scoreResult: scoring.scoreToken(enriched) };
}

/**
 * Re-checks every pending candidate against FRESH pool data (not whatever
 * new_pools happened to return once) - this is what actually gives a young
 * token a real chance to mature past thin-liquidity/concentrated-holders
 * before giving up on it. See pendingCandidates' own comment for why this
 * exists at all.
 */
async function pendingCandidatesTick() {
  const maxAgeMs = config.pendingCandidateMaxAgeMinutes * 60 * 1000;
  for (const [mint, { token, firstSeenAt }] of [...pendingCandidates]) {
    if (Date.now() - firstSeenAt >= maxAgeMs) {
      pendingCandidates.delete(mint);
      stats.recordRejection(['aged_out']);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const pools = await geckoterminal.getPoolsForToken(mint);
    const fresh = pools[0];
    if (!fresh) continue; // pool gone/unreadable this tick - leave it pending, try again next tick
    // eslint-disable-next-line no-await-in-loop
    await evaluateCandidate({ ...token, ...fresh }, { isRetry: true });
  }
}

function getPendingCount() {
  return pendingCandidates.size;
}

module.exports = {
  evaluateCandidate, getLiveTokenAndScore, pendingCandidatesTick, getPendingCount,
};
