const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

// GetXAPI - see config.js's getxapiApiKey comment for the full tradeoff
// (paid, unofficial third-party X reseller). Budget-gated like youtube.js:
// only ever called for candidates that already look promising (see
// evaluator.js), never on every raw discovery candidate - real money per
// call, not a free quota.
const SEARCH_URL = 'https://api.getxapi.com/twitter/tweet/advanced_search';

let callsToday = 0;
let budgetResetAt = 0;

function resetBudgetIfNeeded() {
  if (Date.now() >= budgetResetAt) {
    callsToday = 0;
    budgetResetAt = Date.now() + 24 * 60 * 60 * 1000;
  }
}

/** Recent real X mentions for a specific coin name/symbol - counts only
 * tweets within the same short mention window every other fast-moving
 * source (Reddit/Google Alerts/Telegram) uses, since X posts move at least
 * as fast as those. */
async function searchMentionCount(nameOrSymbol, windowMinutes = config.socialMentionWindowMinutes) {
  if (!config.getxapiApiKey) return 0;
  const term = (nameOrSymbol || '').trim();
  if (term.length < 2) return 0;

  resetBudgetIfNeeded();
  if (callsToday >= config.getxapiDailyCallBudget) {
    logger.debug('GetXAPI daily call budget exhausted, skipping', { term, callsToday });
    return 0;
  }

  try {
    callsToday += 1;
    const { data } = await axios.get(SEARCH_URL, {
      params: { q: term, product: 'Latest' },
      headers: { Authorization: `Bearer ${config.getxapiApiKey}` },
      timeout: 10000,
    });
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    return (data?.tweets || []).filter((t) => new Date(t.createdAt).getTime() > cutoff).length;
  } catch (err) {
    logger.warn('GetXAPI search failed', { term, error: err.message });
    return 0;
  }
}

function start() {
  if (!config.getxapiApiKey) {
    logger.info('GetXAPI (X/Twitter, unofficial third-party) not configured (GETXAPI_API_KEY empty) - contributes 0 to social velocity until set');
  }
  budgetResetAt = Date.now() + 24 * 60 * 60 * 1000;
}

module.exports = { start, searchMentionCount };
