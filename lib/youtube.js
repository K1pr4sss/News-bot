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
  if (!config.youtubeApiKey) return { mentionCount: 0, sampleText: null };
  const term = (nameOrSymbol || '').trim();
  if (term.length < 2) return { mentionCount: 0, sampleText: null };

  resetBudgetIfNeeded();
  if (callsToday >= config.youtubeDailyCallBudget) {
    logger.debug('YouTube daily search budget exhausted, skipping', { term, callsToday });
    return { mentionCount: 0, sampleText: null };
  }

  try {
    callsToday += 1;
    const { data } = await axios.get(SEARCH_URL, {
      params: {
        part: 'snippet',
        q: term,
        type: 'video',
        order: 'date',
        maxResults: 5,
        publishedAfter: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        key: config.youtubeApiKey,
      },
      timeout: 10000,
    });
    const items = data?.items || [];
    return { mentionCount: items.length, sampleText: items[0]?.snippet?.title || null };
  } catch (err) {
    logger.warn('YouTube search failed', { term, error: err.message });
    return { mentionCount: 0, sampleText: null };
  }
}

function start() {
  if (!config.youtubeApiKey) {
    logger.info('YouTube not configured (YOUTUBE_API_KEY empty) - contributes 0 to social velocity until set');
  }
  budgetResetAt = Date.now() + 24 * 60 * 60 * 1000;
}

module.exports = { start, searchMentionCount };
