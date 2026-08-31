const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// Google Alerts can deliver as an RSS feed instead of email - a genuinely
// free, no-API-key mention source, but there's no public API to CREATE an
// alert programmatically. The user has to set one up manually (google.com/alerts
// -> create an alert for e.g. "solana new coin" or "memecoin" -> "Deliver to:
// RSS feed" -> copy that feed URL) and give this bot the URL(s) via
// GOOGLE_ALERTS_RSS_URLS. Inactive (reads as zero, not an error) until at
// least one URL is configured.
let recentItems = []; // { text, publishedAtMs }

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

function decodeEntities(text) {
  return text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (m) => HTML_ENTITIES[m]);
}

/**
 * Google Alerts feeds are Atom (<entry>/<title type="html">/<published>),
 * NOT RSS 2.0 (<item>/<pubDate>) - confirmed against a real feed the user
 * pasted before shipping (an earlier version of this parser was built
 * against the wrong format and would have silently matched zero items).
 * Titles carry inline HTML (<b>term</b> highlighting matched words) and
 * entities (&#39;, &nbsp;) that need stripping/decoding to get plain text.
 */
function parseRssItems(xml) {
  const items = [];
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const block of entryBlocks) {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const dateMatch = block.match(/<published>([\s\S]*?)<\/published>/) || block.match(/<updated>([\s\S]*?)<\/updated>/);
    if (!titleMatch) continue;
    const title = decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim();
    const publishedAtMs = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();
    if (title) items.push({ text: title.toLowerCase(), publishedAtMs });
  }
  return items;
}

async function refresh() {
  if (!config.googleAlertsRssUrls.length) return;
  try {
    const fetched = [];
    for (const url of config.googleAlertsRssUrls) {
      const { data } = await axios.get(url, { timeout: 10000 });
      fetched.push(...parseRssItems(data));
    }
    const cutoff = Date.now() - 60 * 60 * 1000; // keep 1h, same window discipline as reddit.js
    recentItems = [...fetched, ...recentItems].filter((i) => Number.isFinite(i.publishedAtMs) && i.publishedAtMs > cutoff);
  } catch (err) {
    logger.warn('Google Alerts RSS refresh failed, keeping previous snapshot', { error: err.message });
  }
}

/** Same shape as reddit.js's getSignal - mention count only (no sentiment;
 * Alerts headlines are too short/sparse for a meaningful positive/negative read). */
function getSignal(nameOrSymbol, windowMinutes = config.socialMentionWindowMinutes) {
  const term = (nameOrSymbol || '').toLowerCase();
  if (!term || term.length < 2) return { mentionCount: 0 };
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const mentionCount = recentItems.filter((i) => i.publishedAtMs > cutoff && i.text.includes(term)).length;
  return { mentionCount };
}

function start() {
  if (!config.googleAlertsRssUrls.length) {
    logger.info('Google Alerts not configured (GOOGLE_ALERTS_RSS_URLS empty) - contributes 0 to social velocity until set');
    return;
  }
  refresh();
  setInterval(refresh, config.redditPollIntervalMs);
}

module.exports = { start, getSignal, parseRssItems };
