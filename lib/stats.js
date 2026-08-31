// In-memory diagnostic stats - mirrors the old sniper bot's `this.stats`
// object. Resets on restart by design (same as that bot's non-persisted
// counters); real trade history lives in the DB, this is just for /status,
// /queue, /reasons, /nearmiss.
const startedAt = Date.now();
let tokensScanned = 0;
let alertsSent = 0;
const recentAlerts = []; // { symbol, mint, score, at } - newest last, capped
const rejectionReasons = {}; // label -> count
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
  get nearMisses() { return nearMisses; },
  recordScanned,
  recordAlert,
  recordRejection,
  recordNearMiss,
};
