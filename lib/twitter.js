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
// Latched by a 402 - see the catch block below.
let outOfCredit = false;
// Health counters. A prepaid source that runs out of credit fails CLOSED - it
// returns 0 mentions forever, exactly like a coin nobody is talking about -
// so without these there is no way to tell "nobody mentioned it" from "this
// source died three days ago". See index.js's /sources endpoint.
const health = {
  lastCallAt: null, lastSuccessAt: null, lastError: null, totalCalls: 0, totalMentionsFound: 0,
};

function resetBudgetIfNeeded() {
  if (Date.now() >= budgetResetAt) {
    callsToday = 0;
    budgetResetAt = Date.now() + 24 * 60 * 60 * 1000;
  }
}

/** Recent real X mentions for a specific coin name/symbol - counts only
 * tweets within the same short mention window every other fast-moving
 * source (Reddit/Google Alerts/Telegram) uses, since X posts move at least
 * as fast as those. Also returns the newest matching tweet's own text (not
 * a summary/paraphrase) so a human can read the actual context/meme behind
 * a candidate, not just a count - real user ask, real raw quote beats a
 * guessed-at label. */
async function searchMentionCount(nameOrSymbol, windowMinutes = config.socialMentionWindowMinutes) {
  if (!config.getxapiApiKey) return { mentionCount: 0, sampleText: null };
  // Latched off by a 402 - see the catch block. Cleared only by a restart, so a
  // topped-up account resumes without a code change.
  if (outOfCredit) return { mentionCount: 0, sampleText: null };
  const term = (nameOrSymbol || '').trim();
  if (term.length < 2) return { mentionCount: 0, sampleText: null };

  resetBudgetIfNeeded();
  if (callsToday >= config.getxapiDailyCallBudget) {
    logger.debug('GetXAPI daily call budget exhausted, skipping', { term, callsToday });
    return { mentionCount: 0, sampleText: null };
  }

  try {
    callsToday += 1;
    health.totalCalls += 1;
    health.lastCallAt = Date.now();
    const { data } = await axios.get(SEARCH_URL, {
      params: { q: term, product: 'Latest' },
      headers: { Authorization: `Bearer ${config.getxapiApiKey}` },
      timeout: 10000,
    });
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    const fresh = (data?.tweets || []).filter((t) => new Date(t.createdAt).getTime() > cutoff);
    health.lastSuccessAt = Date.now();
    health.lastError = null;
    health.totalMentionsFound += fresh.length;
    return { mentionCount: fresh.length, sampleText: fresh[0]?.text || null };
  } catch (err) {
    health.lastError = err.message;
    // 402 PAYMENT REQUIRED means the prepaid balance is gone. That is not a
    // transient failure and no amount of retrying fixes it - the account has to
    // be topped up, which is a decision with real money attached and therefore
    // the user's to make, not the bot's to keep re-asking.
    //
    // Left running, it sat in the hot path of every promising candidate,
    // spending latency on a call that could only ever fail: 54 calls, 0
    // mentions found, every one a 402. Latch it off instead, and say so loudly
    // in getStatus so a topped-up account can be spotted and the latch cleared
    // on the next restart rather than the source silently staying dark.
    if (err.response?.status === 402) {
      outOfCredit = true;
      logger.warn('GetXAPI is out of prepaid credit (402) - disabling this source until restart', { term });
    }
    logger.warn('GetXAPI search failed', { term, error: err.message });
    return { mentionCount: 0, sampleText: null };
  }
}

function getStatus() {
  return {
    configured: !!config.getxapiApiKey,
    // Distinct from `configured`. A source can be configured and completely
    // dark, which is exactly what a prepaid balance running out looks like.
    outOfCredit,
    callsToday,
    dailyBudget: config.getxapiDailyCallBudget,
    budgetExhausted: callsToday >= config.getxapiDailyCallBudget,
    ...health,
    // Prepaid credit, so this is the tell that matters: calls going out but
    // nothing ever coming back means the balance is spent, not that X is quiet.
    callsButNeverAnyMentions: health.totalCalls >= 10 && health.totalMentionsFound === 0,
  };
}

function start() {
  if (!config.getxapiApiKey) {
    logger.info('GetXAPI (X/Twitter, unofficial third-party) not configured (GETXAPI_API_KEY empty) - contributes 0 to social velocity until set');
  }
  budgetResetAt = Date.now() + 24 * 60 * 60 * 1000;
}

module.exports = { start, searchMentionCount, getStatus };
