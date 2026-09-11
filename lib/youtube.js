const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// Real free quota is 100 search.list calls/day (10,000 units / 100 per call -
// the standard, well-documented number, not the 1k the user first assumed).
// Given that, searching per raw candidate doesn't work - PumpPortal alone
// produces hundreds of tokens/day, which would blow the budget in minutes.
// Instead this searches for a SPECIFIC coin name, and only gets called (see
// evaluator.js) for candidates that already cleared safety filters and are
// close to qualifying - a much smaller, higher-value set. A hard daily
// counter below is the actual backstop regardless of caller discipline.
const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

let callsToday = 0;
let budgetResetAt = 0;
// Health counters - a quota-exhausted source fails closed (returns 0), which
// is indistinguishable from a coin nobody mentioned. See /sources.
const health = { lastCallAt: null, lastSuccessAt: null, lastError: null, totalCalls: 0, totalMentionsFound: 0 };

function resetBudgetIfNeeded() {
  if (Date.now() >= budgetResetAt) {
    callsToday = 0;
    budgetResetAt = Date.now() + 24 * 60 * 60 * 1000;
  }
}

/** Recent (last 24h) video count specifically mentioning this exact coin
 * name/symbol - video content has natural production lag, so this uses a
 * much wider window than the 5-minute one Reddit/Alerts use for the same
 * "mentions" signal; it's a slower-moving, influencer-confirmation signal,
 * not a velocity one. */
async function searchMentionCount(nameOrSymbol) {
  if (!config.youtubeApiKey) return { mentionCount: 0, rawMentionCount: 0, sampleText: null };
  const term = (nameOrSymbol || '').trim();
  if (term.length < 2) return { mentionCount: 0, rawMentionCount: 0, sampleText: null };

  resetBudgetIfNeeded();
  if (callsToday >= config.youtubeDailyCallBudget) {
    logger.debug('YouTube daily search budget exhausted, skipping', { term, callsToday });
    return { mentionCount: 0, rawMentionCount: 0, sampleText: null };
  }

  try {
    callsToday += 1;
    health.totalCalls += 1;
    health.lastCallAt = Date.now();
    const { data } = await axios.get(SEARCH_URL, {
      params: {
        part: 'snippet',
        // QUALIFIED. The bare term was searching YouTube for an English word,
        // not for a coin: "HOOD", "fone", "GOOG", "LAPTOP" all return 50 hits of
        // completely unrelated video, every time. That was not just noise in the
        // score - evaluator.js adds this count to mentionCount BEFORE the
        // minMentionCount gate, so "at least one real mention" was satisfied for
        // essentially every candidate by videos about laptops.
        //
        // Quoting forces the exact token and the OR group forces a crypto
        // context, so a real memecoin with real coverage still matches while a
        // common English word stops matching anything.
        q: config.youtubeQualifySearch ? `"${term}" (solana OR crypto OR memecoin OR token)` : term,
        type: 'video',
        order: 'date',
        // 5 -> 50. YouTube's quota is charged PER CALL (100 units for a
        // search.list) regardless of how many results come back, so this is
        // free. It was silently capping the bot's most important signal: with
        // Telegram quiet, X out of credit and Farcaster near-silent, YouTube is
        // effectively the only live mention source, so mentionCount was pinned
        // at whatever this number is. 49 of 60 real entries recorded EXACTLY 5
        // mentions - the signal was a constant wearing a variable's clothes.
        maxResults: 50,
        publishedAfter: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        key: config.youtubeApiKey,
      },
      timeout: 10000,
    });
    const items = data?.items || [];
    health.lastSuccessAt = Date.now();
    health.lastError = null;
    health.totalMentionsFound += items.length;
    // Tracked so the effect of qualifying is visible within an hour rather than
    // guessed at: if `zeroResultSearches` climbs to match `totalCalls`, the
    // query is too strict and YOUTUBE_QUALIFY_SEARCH=false reverts it.
    if (items.length === 0) health.zeroResultSearches += 1;
    if (items.length >= 50) health.saturatedSearches += 1;
    // DELIBERATELY still capped at 5 for the SCORE. The uncapped figure is
    // returned alongside it as rawMentionCount and recorded, not scored.
    //
    // The reason is calibration, not caution for its own sake. scoreAlertThreshold
    // was raised to 60 on evidence from real trades - score >=60 wins 29% against
    // 14% below it, the only rule in this project positive in both halves - and
    // that evidence was gathered on THIS scale. Un-capping the input would shift
    // every score upward, so "60" would no longer select the population it was
    // measured on, and the one working filter would be silently invalidated
    // days before real money goes in.
    //
    // So: collect the better signal now, keep behaviour identical, and
    // re-derive the threshold once there is enough data to do it honestly.
    // Same record-first discipline that was applied to offAthPct and the
    // RugCheck score.
    return {
      mentionCount: Math.min(5, items.length),
      rawMentionCount: items.length,
      sampleText: items[0]?.snippet?.title || null,
    };
  } catch (err) {
    health.lastError = err.message;
    logger.warn('YouTube search failed', { term, error: err.message });
    return { mentionCount: 0, rawMentionCount: 0, sampleText: null };
  }
}

function start() {
  if (!config.youtubeApiKey) {
    logger.info('YouTube not configured (YOUTUBE_API_KEY empty) - contributes 0 to social velocity until set');
  }
  budgetResetAt = Date.now() + 24 * 60 * 60 * 1000;
}

function getStatus() {
  return {
    configured: !!config.youtubeApiKey,
    qualifiedSearch: config.youtubeQualifySearch,
    zeroResultSearches: health.zeroResultSearches,
    saturatedSearches: health.saturatedSearches,
    callsToday,
    dailyBudget: config.youtubeDailyCallBudget,
    budgetExhausted: callsToday >= config.youtubeDailyCallBudget,
    ...health,
    callsButNeverAnyMentions: health.totalCalls >= 10 && health.totalMentionsFound === 0,
  };
}

module.exports = { start, searchMentionCount, getStatus };
