// In-memory diagnostic stats - mirrors the old sniper bot's `this.stats`
// object. Resets on restart by design (same as that bot's non-persisted
// counters); real trade history lives in the DB, this is just for /status,
// /queue, /reasons, /nearmiss.
const startedAt = Date.now();
let tokensScanned = 0;
let alertsSent = 0;
const recentAlerts = []; // { symbol, mint, score, at } - newest last, capped
const rejectionReasons = {}; // label -> count (a candidate failing N filters bumps N counters)
const soleRejectionReasons = {}; // label -> count, ONLY when it was the single blocker
const nearMisses = []; // { symbol, mint, score, reason, at } - newest last, capped

function recordScanned() {
  tokensScanned += 1;
}

function recordAlert({ symbol, mint, score }) {
  alertsSent += 1;
  recentAlerts.push({ symbol, mint, score, at: Date.now() });
  if (recentAlerts.length > 50) recentAlerts.shift();
}

function recordRejection(reasons) {
  for (const r of reasons) {
    // filters.js reasons are full sentences ("liquidity $X below..."); bucket by
    // the leading label before the first space/colon so the breakdown stays readable.
    const label = r.split(/[:\s]/)[0];
    rejectionReasons[label] = (rejectionReasons[label] || 0) + 1;
  }
  // A candidate failing three filters increments three counters, so these
  // totals overlap heavily and cannot answer the question that actually
  // matters when tuning: "what is the BINDING constraint - which filter, on
  // its own, is the only thing standing between us and a trade?" A count of
  // 127 next to `price` reads as "the momentum gate blocked 127 tokens" when
  // most of those may have failed liquidity and top-holder too, and would
  // never have traded regardless. This records the sole blocker separately, so
  // loosening a threshold is a decision about real cost rather than a guess.
  if (reasons.length === 1) {
    const label = reasons[0].split(/[:\s]/)[0];
    soleRejectionReasons[label] = (soleRejectionReasons[label] || 0) + 1;
  }
}

function recordNearMiss({
  symbol, mint, score, reason,
}) {
  nearMisses.push({
    symbol, mint, score, reason, at: Date.now(),
  });
  if (nearMisses.length > 15) nearMisses.shift();
}

module.exports = {
  startedAt,
  get tokensScanned() { return tokensScanned; },
  get alertsSent() { return alertsSent; },
  get recentAlerts() { return recentAlerts; },
  get rejectionReasons() { return rejectionReasons; },
  get soleRejectionReasons() { return soleRejectionReasons; },
  get nearMisses() { return nearMisses; },
  recordScanned,
  recordAlert,
  recordRejection,
  recordNearMiss,
};
