const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// Farcaster via Neynar - see config.js's neynarApiKey comment for the full
// tradeoff (free, official, but a SEPARATE platform from X - not a mirror
// of it). No budget gating like twitter.js's GetXAPI needs - the free
// tier's rate limit comfortably covers this bot's polling volume, so this
// runs on the same short-window "mention velocity" pattern as Reddit/
// Google Alerts/Telegram (both entry AND exit re-scoring).
const SEARCH_URL = 'https://api.neynar.com/v2/farcaster/cast/search';

// Health counters - see index.js's /sources. Neynar has no per-call cost but
// it does have a monthly credit budget whose exact size was never confirmed,
// so "silently stopped returning anything" is a real failure mode here too.
const health = {
  lastCallAt: null, lastSuccessAt: null, lastError: null, totalCalls: 0, totalMentionsFound: 0,
};

async function getSignal(nameOrSymbol, windowMinutes = config.socialMentionWindowMinutes) {
  if (!config.neynarApiKey) return { mentionCount: 0, sampleText: null };
  const term = (nameOrSymbol || '').trim();
  if (term.length < 2) return { mentionCount: 0, sampleText: null };

  try {
    health.totalCalls += 1;
    health.lastCallAt = Date.now();
    const { data } = await axios.get(SEARCH_URL, {
      params: { q: term, limit: 20 },
      headers: { 'x-api-key': config.neynarApiKey, 'x-neynar-experimental': 'false' },
      timeout: 10000,
    });
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    const fresh = (data?.result?.casts || []).filter((c) => new Date(c.timestamp).getTime() > cutoff);
    health.lastSuccessAt = Date.now();
    health.lastError = null;
    health.totalMentionsFound += fresh.length;
    return { mentionCount: fresh.length, sampleText: fresh[0]?.text || null };
  } catch (err) {
    health.lastError = err.message;
    logger.warn('Farcaster (Neynar) cast search failed', { term, error: err.message });
    return { mentionCount: 0, sampleText: null };
  }
}

function getStatus() {
  return {
    configured: !!config.neynarApiKey,
    ...health,
    callsButNeverAnyMentions: health.totalCalls >= 10 && health.totalMentionsFound === 0,
  };
}

function start() {
  if (!config.neynarApiKey) {
    logger.info('Farcaster (Neynar) not configured (NEYNAR_API_KEY empty) - contributes 0 to social velocity until set');
  }
}

module.exports = { start, getSignal, getStatus };
