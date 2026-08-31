const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// One fixed broad search polled on an interval, cached and matched against
// each candidate's name/symbol - NOT a search per candidate. YouTube's free
// daily quota is real but small and search.list is the most expensive call
// type; this pattern (same as reddit.js/googleAlerts.js) keeps usage to one
// call per poll interval regardless of how many tokens get evaluated.
const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

let recentVideos = []; // { text, publishedAtMs }

async function refresh() {
  if (!config.youtubeApiKey) return;
  try {
    const { data } = await axios.get(SEARCH_URL, {
      params: {
        part: 'snippet',
        q: config.youtubeSearchQuery,
        type: 'video',
        order: 'date',
        maxResults: 25,
        key: config.youtubeApiKey,
      },
      timeout: 10000,
    });
    const fetched = (data?.items || []).map((item) => ({
      text: `${item.snippet?.title || ''} ${item.snippet?.description || ''}`.toLowerCase(),
      publishedAtMs: item.snippet?.publishedAt ? new Date(item.snippet.publishedAt).getTime() : Date.now(),
    }));
    const cutoff = Date.now() - 60 * 60 * 1000; // keep 1h, same window discipline as reddit.js/googleAlerts.js
    recentVideos = [...fetched, ...recentVideos].filter((v) => Number.isFinite(v.publishedAtMs) && v.publishedAtMs > cutoff);
  } catch (err) {
    logger.warn('YouTube search refresh failed, keeping previous snapshot', { error: err.message });
  }
}

function getSignal(nameOrSymbol, windowMinutes = config.socialMentionWindowMinutes) {
  const term = (nameOrSymbol || '').toLowerCase();
  if (!term || term.length < 2) return { mentionCount: 0 };
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const mentionCount = recentVideos.filter((v) => v.publishedAtMs > cutoff && v.text.includes(term)).length;
  return { mentionCount };
}

function start() {
  if (!config.youtubeApiKey) {
    logger.info('YouTube not configured (YOUTUBE_API_KEY empty) - contributes 0 to social velocity until set');
    return;
  }
  refresh();
  setInterval(refresh, config.youtubePollIntervalMs);
}

module.exports = { start, getSignal };
