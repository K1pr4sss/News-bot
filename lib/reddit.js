const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const POSITIVE_WORDS = ['moon', 'bullish', 'gem', 'pump', 'based', 'lfg', 'ape', 'send it', 'breakout', '100x', '10x'];
const NEGATIVE_WORDS = ['rug', 'scam', 'dump', 'dead', 'avoid', 'honeypot', 'ponzi', 'exit scam', 'red flag'];

let accessToken = null;
let tokenExpiresAt = 0;
// { text: string, createdAtMs: number }[]
let recentPosts = [];

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  const { data } = await axios.post(
    'https://www.reddit.com/api/v1/access_token',
    'grant_type=client_credentials',
    {
      auth: { username: config.redditClientId, password: config.redditClientSecret },
      headers: { 'User-Agent': config.redditUserAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    },
  );
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return accessToken;
}

async function refresh() {
  if (!config.redditClientId || !config.redditClientSecret) return; // not configured - social signal degrades to zero, not a crash
  try {
    const token = await getAccessToken();
    const fetched = [];
    for (const sub of config.redditSubreddits) {
      const { data } = await axios.get(`https://oauth.reddit.com/r/${sub.trim()}/new`, {
        params: { limit: 50 },
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': config.redditUserAgent },
        timeout: 10000,
      });
      for (const child of data?.data?.children || []) {
        const post = child.data;
        const rawText = `${post.title || ''} ${post.selftext || ''}`.trim();
        fetched.push({
          text: rawText.toLowerCase(), // matching only - original case kept separately for display
          rawText,
          createdAtMs: (post.created_utc || 0) * 1000,
        });
      }
    }
    const cutoff = Date.now() - 60 * 60 * 1000; // keep 1h of history, well past the 5min scoring window
    recentPosts = [...fetched, ...recentPosts].filter((p) => p.createdAtMs > cutoff);
  } catch (err) {
    logger.warn('Reddit refresh failed, keeping previous snapshot', { error: err.message });
  }
}

/**
 * Mentions of a token name/symbol in the last `windowMinutes`, plus a
 * positive/negative keyword ratio over the same matched posts. Reddit-only
 * for v1 - see plan doc on why the spec's literal 1000-mention cooldown
 * threshold doesn't fit this source's realistic volume.
 */
function getSignal(nameOrSymbol, windowMinutes = config.socialMentionWindowMinutes) {
  const term = (nameOrSymbol || '').toLowerCase();
  if (!term || term.length < 2) return { mentionCount: 0, positiveRatio: null, sampleText: null };
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const matches = recentPosts.filter((p) => p.createdAtMs > cutoff && p.text.includes(term));
  if (!matches.length) return { mentionCount: 0, positiveRatio: null, sampleText: null };

  let positive = 0;
  let negative = 0;
  for (const m of matches) {
    if (POSITIVE_WORDS.some((w) => m.text.includes(w))) positive += 1;
    if (NEGATIVE_WORDS.some((w) => m.text.includes(w))) negative += 1;
  }
  const totalSentimentHits = positive + negative;
  const positiveRatio = totalSentimentHits > 0 ? positive / totalSentimentHits : null;

  // recentPosts is prepended-newest-first (see refresh), so matches[0] is
  // the most recent real post - shown verbatim, not paraphrased, so the
  // user can actually read the meme/context themselves.
  return { mentionCount: matches.length, positiveRatio, sampleText: matches[0]?.rawText || null };
}

function start() {
  if (!config.redditClientId || !config.redditClientSecret) {
    logger.info('Reddit integration not configured (REDDIT_CLIENT_ID/SECRET missing) - social/sentiment scoring will read as 0 until set');
    return;
  }
  refresh();
  setInterval(refresh, config.redditPollIntervalMs);
}

module.exports = { start, getSignal };
