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
const twitter = require('./twitter');
const farcaster = require('./farcaster');
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
    if (last && now - last < config.candidateReevaluateThrottleMs) return;
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
    description: socials.description || '',
    matchedTrendingKeyword: coingecko.matchesTrending(token.name),
    matchedTrendingPool: trendingPool,
    isBoosted: dexscreener.isBoosted(token.mint),
  };

  const redditSignal = reddit.getSignal(token.symbol || token.name);
  const alertsSignal = googleAlerts.getSignal(token.symbol || token.name);
  const telegramSignal = telegramUserClient.getSignal(token.symbol || token.name);
  enriched.mentionCount = redditSignal.mentionCount + alertsSignal.mentionCount + telegramSignal.mentionCount;
  enriched.positiveRatio = redditSignal.positiveRatio; // other sources are too sparse for a meaningful sentiment read - Reddit stays the only sentiment source

  // Named, not just counted - "why is this flagged" is a real question the
  // user asked for directly, and a raw mention number doesn't answer it.
  // sampleTexts holds the actual, unmodified post/message text per source
  // (not a paraphrase or AI summary) so a human can read the real context/
  // meme themselves - collected incrementally as each source is actually
  // checked (some only run conditionally below), rendered into the alert
  // further down by SAMPLE_PRIORITY.
  const mentionSourceNames = [];
  const sampleTexts = {};
  if (redditSignal.mentionCount > 0) { mentionSourceNames.push('Reddit'); sampleTexts.Reddit = redditSignal.sampleText; }
  if (alertsSignal.mentionCount > 0) { mentionSourceNames.push('Google Alerts'); sampleTexts['Google Alerts'] = alertsSignal.sampleText; }
  if (telegramSignal.mentionCount > 0) { mentionSourceNames.push('Telegram alpha groups'); sampleTexts['Telegram alpha groups'] = telegramSignal.sampleText; }

  const { pass, reasons: filterReasons } = filters.runSafetyFilters(enriched, rugcheckReport, birdeyeOverview);
  let scoreResult = scoring.scoreToken(enriched);

  // YouTube/GetXAPI(X)/Farcaster are spent ONLY on candidates that already
  // look promising (passed filters, clear the volume gate, and are within
  // striking distance of the score threshold without them) - see each
  // module for why: YouTube's real quota is 100 searches/day, GetXAPI costs
  // real money per call, and Farcaster's exact monthly credit budget wasn't
  // confirmable before shipping (conflicting numbers across sources) - all
  // three would blow through blanket-checking every raw candidate given how
  // many tokens PumpPortal alone produces.
  if (pass && scoreResult.volumeRatio >= config.entryVolumeSpikeMultiplier && scoreResult.score >= config.scoreAlertThreshold - 10) {
    const [youtubeSignal, twitterSignal, farcasterSignal] = await Promise.all([
      youtube.searchMentionCount(token.symbol || token.name),
      twitter.searchMentionCount(token.symbol || token.name),
      farcaster.getSignal(token.symbol || token.name),
    ]);
    if (youtubeSignal.mentionCount > 0) { mentionSourceNames.push('YouTube'); sampleTexts.YouTube = youtubeSignal.sampleText; }
    if (twitterSignal.mentionCount > 0) { mentionSourceNames.push('X/Twitter'); sampleTexts['X/Twitter'] = twitterSignal.sampleText; }
    if (farcasterSignal.mentionCount > 0) { mentionSourceNames.push('Farcaster'); sampleTexts.Farcaster = farcasterSignal.sampleText; }
    const bonusMentions = youtubeSignal.mentionCount + twitterSignal.mentionCount + farcasterSignal.mentionCount;
    if (bonusMentions > 0) {
      enriched.mentionCount += bonusMentions;
      // Persisted onto the position row at entry (see positions.attemptEntry)
      // because getLiveTokenAndScore deliberately never re-runs these three
      // sources - without carrying the number forward, every open position
      // silently lost their entire social-velocity contribution on its first
      // exit-tick re-score. See getLiveTokenAndScore's comment for the rest.
      enriched.bonusMentionCount = bonusMentions;
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

  // Human-readable "why this coin" - the score breakdown below already says
  // WHAT earned points, this says WHERE the hype was actually seen. The
  // mention gate above guarantees mentionSourceNames is never empty for an
  // alert that actually fires, so this line always has something real to say.
  const trendingSourceNames = [];
  if (enriched.matchedTrendingKeyword) trendingSourceNames.push('CoinGecko trending search');
  if (enriched.matchedTrendingPool) trendingSourceNames.push('GeckoTerminal trending pools');
  if (enriched.isBoosted) trendingSourceNames.push('DexScreener boosted');
  const whyParts = [];
  if (trendingSourceNames.length) whyParts.push(`trending on ${trendingSourceNames.join(', ')}`);
  if (mentionSourceNames.length) whyParts.push(`seen on ${mentionSourceNames.join(', ')}`);

  // Pick ONE real post to quote verbatim, in priority order - Telegram
  // alpha groups and X/Twitter tend to carry actual community commentary
  // (the "why is this a thing" context), Google Alerts/YouTube tend to be
  // formal news/video titles (still real, just less likely to explain a
  // meme). Never an AI paraphrase - the user asked to see the real post so
  // they can judge the context themselves, not trust a guessed summary.
  const SAMPLE_PRIORITY = ['Telegram alpha groups', 'X/Twitter', 'Farcaster', 'Reddit', 'Google Alerts', 'YouTube'];
  const sampleSource = SAMPLE_PRIORITY.find((name) => sampleTexts[name]);

  const alertLines = [
    `🚀 ${enriched.symbol} scored ${scoreResult.score}/100`,
    `Mint: ${token.mint}`,
    `Liquidity: $${Math.round(token.liquidityUsd).toLocaleString()}`,
  ];
  if (enriched.description) alertLines.push(`"${enriched.description.slice(0, 200)}"`); // creator's own blurb - capped, most launches leave it blank
  if (whyParts.length) alertLines.push(`Why: ${whyParts.join(' · ')}`);
  if (sampleSource) alertLines.push(`📝 "${sampleTexts[sampleSource].slice(0, 220)}" — via ${sampleSource}`);
  alertLines.push(...scoreResult.reasons);

  const entry = await positions.attemptEntry(enriched, scoreResult);
  if (entry.ok) {
    alertLines.push(`\n✅ Paper-bought ${entry.amountSol.toFixed(4)} SOL (${entry.tier.label} band)`);
  } else {
    alertLines.push(`\n⏸️ Not bought - ${entry.reason}`);
  }
  logger.info('Alert sent', {
    mint: token.mint, symbol: enriched.symbol, score: scoreResult.score, bought: entry.ok, reason: entry.ok ? null : entry.reason,
  });
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

  // 'high' priority - real capital already in this position must never queue
  // behind GeckoTerminal lookups for brand-new tokens nobody has bought yet.
  // See geckoterminal.js's throttledGet comment for the real bug this fixes.
  const pools = await geckoterminal.getPoolsForToken(position.mint, 'high');
  const pool = pools[0];

  // Deliberately excludes YouTube/GetXAPI(X)/Farcaster - this runs every
  // ~10s per open position, and re-searching these here would either burn
  // real money every ~10s per open position (GetXAPI), risk blowing an
  // unconfirmed monthly credit budget (Farcaster), or check a slow-moving
  // signal that doesn't change meaningfully second to second (YouTube) -
  // all three only factor into the entry decision, never exit re-scoring.
  const redditSignal = reddit.getSignal(position.symbol || position.name);
  const alertsSignal = googleAlerts.getSignal(position.symbol || position.name);
  const telegramSignal = telegramUserClient.getSignal(position.symbol || position.name);
  const enriched = {
    priceUsd: priceInfo.priceUsd,
    volumeH1Usd: pool?.volumeH1Usd || 0,
    volumeH24Usd: pool?.volumeH24Usd || 0,
    matchedTrendingKeyword: coingecko.matchesTrending(position.name),
    // Was hardcoded false. Entry scoring sets this from whether the candidate
    // came off GeckoTerminal's trending-pools poll - a fact about how the
    // token was found, which cannot be recomputed here (this function has no
    // trending list in hand) and doesn't stop being true just because the
    // position is now open. Hardcoding false cost every trending-sourced
    // position up to 10 points on its very first exit-tick re-score, for free.
    matchedTrendingPool: !!position.entry_trending_pool,
    isBoosted: dexscreener.isBoosted(position.mint),
    socialsCount: position.entry_socials_count || 0,
    // Reddit/Google Alerts/Telegram are live-polled caches, so they re-read
    // cheaply here. YouTube/X/Farcaster are NOT re-run (see the comment below
    // for why) - but they DID contribute to the entry score, so dropping them
    // silently subtracted up to 30 points of social velocity from every
    // position the moment it opened. Carried forward from entry instead.
    mentionCount: redditSignal.mentionCount + alertsSignal.mentionCount + telegramSignal.mentionCount
      + (position.entry_bonus_mentions || 0),
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
