const config = require('./config');
const db = require('./db');
const executor = require('./executor');
const scoring = require('./scoring');
const dexscreener = require('./dexscreener');
const logger = require('./logger');

// In-memory lock for entries, same race class as the sell-side bug (see
// sellFraction's comment) but caught by review rather than live data:
// attemptEntry's hasOpenPosition(mint) check is synchronous, but
// `await executor.buy(...)` happens before the position row is actually
// INSERTed - two different tick sources (e.g. discoveryTick and pendingTick)
// evaluating the same mint moments apart could both pass the check before
// either writes, each independently buying. A DB-level CAS doesn't apply
// here (there's no existing row to condition on for a brand-new entry), so
// this uses a synchronous check-and-set Set instead - the check and the
// lock acquisition happen with no await between them, which is enough to
// close the gap in a single-process, single-threaded Node app.
const mintsBeingBought = new Set();

function isPaused() {
  return db.getMeta('paused') === '1';
}

function pause() {
  db.setMeta('paused', '1');
}

function resume() {
  db.setMeta('paused', '0');
}

/** Resets the paper balance to the configured starting amount and marks a new
 * /pnl window - trade HISTORY is untouched, same "clean slate, nothing
 * deleted" philosophy as the old bot's /resetsession. */
function resetSession() {
  db.prepare('UPDATE paper_wallet SET balance_sol = ? WHERE id = 1').run(config.paperStartingBalanceSol);
  db.setMeta('statsResetAt', Date.now());
}

function recordTrade({
  mint, name, symbol, side, fraction, amountSol, priceUsd, score, reason, realizedPnlSol,
}) {
  db.prepare(`
    INSERT INTO trades (mint, name, symbol, side, fraction, amount_sol, price_usd, score, reason, realized_pnl_sol, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mint, name, symbol, side, fraction ?? null, amountSol, priceUsd ?? null, score ?? null, reason ?? null, realizedPnlSol ?? null, Date.now());
}

function getOpenPositions() {
  return db.prepare("SELECT * FROM positions WHERE status = 'open'").all();
}

function getOpenPositionCount() {
  return db.prepare("SELECT COUNT(*) as c FROM positions WHERE status = 'open'").get().c;
}

function hasOpenPosition(mint) {
  return !!db.prepare("SELECT 1 FROM positions WHERE mint = ? AND status = 'open'").get(mint);
}

function wasRecentlyBought(mint) {
  const cutoff = Date.now() - config.rebuyCooldownHours * 60 * 60 * 1000;
  return !!db.prepare("SELECT 1 FROM trades WHERE mint = ? AND side = 'buy' AND created_at > ? LIMIT 1").get(mint, cutoff);
}

/**
 * Entry: score >= threshold AND volume spike >= entryVolumeSpikeMultiplier
 * AND liquidity floor AND every safety filter passed (checked by the caller
 * before this is invoked - see index.js). Sizing per spec Section 6.
 */
/**
 * Returns { ok: true, mint, amountSol, score, tier } on success, or
 * { ok: false, reason } on any rejection - every path reports WHY, not just
 * a bare null. Real gap this closes: the caller (evaluator.js) sends a
 * Telegram alert either way once a candidate clears score/volume/filters/
 * mentions, but a null return gave it nothing to say beyond "not bought"
 * for 5 of 6 possible reasons (paused was the only one it could name) -
 * confusing from the user's side ("why alerts but no buy") and just as
 * blind server-side, since none of these paths logged anything either.
 */
async function attemptEntry(token, scoreResult) {
  if (isPaused()) return { ok: false, reason: 'auto-buy is paused (/resume to re-enable)' };
  if (mintsBeingBought.has(token.mint)) return { ok: false, reason: 'a buy for this mint is already in flight' }; // synchronous, no await yet - closes the race window
  if (hasOpenPosition(token.mint)) return { ok: false, reason: 'already have an open position in this mint' };
  if (wasRecentlyBought(token.mint)) return { ok: false, reason: `bought within the last ${config.rebuyCooldownHours}h (re-buy cooldown)` };
  if (getOpenPositionCount() >= config.maxOpenPositions) return { ok: false, reason: `max open positions reached (${config.maxOpenPositions})` };
  mintsBeingBought.add(token.mint);

  try {
    // Real bug found via live P&L verification (2026-09-02): this used to
    // buy at token.priceUsd - whatever price was attached when the
    // candidate was first discovered, not when the buy actually executes.
    // discoveryTick evaluates an entire getNewPools() batch in one
    // SEQUENTIAL loop, each candidate going through RugCheck + socials +
    // Birdeye + filters + scoring (+ the youtube/twitter/farcaster gate for
    // promising ones) before the next one even starts - a candidate late in
    // a large batch can be evaluated minutes after the batch's price
    // snapshot was taken. Confirmed on a real trade ("pippo"): the recorded
    // entry price didn't match ANY point in the coin's real GeckoTerminal
    // OHLCV history, off by ~3.8x from the actual price at the real buy
    // timestamp - a fast-moving token had already run up substantially
    // during the enrichment delay, and the stale snapshot price made the
    // eventual take-profit-tier-3 exit look artificially larger than what
    // really happened. attemptManualBuy already fetched a fresh price right
    // before executing (see below) - this brings the automated path to the
    // same standard.
    const priceInfo = await dexscreener.getTokenPriceUsd(token.mint);
    if (!priceInfo) return { ok: false, reason: 'no live price data found for this mint' };

    const balance = executor.getBalanceSol();
    const tier = scoring.computeSizeTier(scoreResult.score);
    const amountSol = Math.min(balance * tier.pct, balance * config.maxTradePct);
    if (amountSol <= 0) return { ok: false, reason: 'paper balance is empty' };

    const result = await executor.buy({ amountSol, priceUsd: priceInfo.priceUsd });
    if (!result.success) {
      logger.warn('Paper buy failed', { mint: token.mint, error: result.error });
      return { ok: false, reason: result.error || 'buy failed' };
    }

    db.prepare(`
      INSERT INTO positions (mint, name, symbol, entry_price_usd, original_amount_sol, remaining_amount_sol, entry_score, opened_at, max_hold_minutes, entry_socials_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(token.mint, token.name, token.symbol, result.filledPriceUsd, amountSol, amountSol, scoreResult.score, Date.now(), tier.holdMinutes, token.socialsCount || 0);

    recordTrade({
      mint: token.mint, name: token.name, symbol: token.symbol, side: 'buy', amountSol,
      priceUsd: result.filledPriceUsd, score: scoreResult.score, reason: `entry (${tier.label} band)`,
    });

    logger.info('Position opened', {
      mint: token.mint, symbol: token.symbol, amountSol, score: scoreResult.score, sizeTier: tier.label,
    });
    return {
      ok: true, mint: token.mint, amountSol, score: scoreResult.score, tier,
    };
  } finally {
    mintsBeingBought.delete(token.mint);
  }
}

/** /buy <mint> [amountSol] - explicit human override, skips score/filters
 * entirely (that's the point of a manual command) but still respects the
 * same open-position/cooldown/balance guards as an automated entry. */
async function attemptManualBuy(mint, amountSol) {
  if (mintsBeingBought.has(mint)) return { ok: false, reason: 'a buy for this mint is already in flight' };
  if (hasOpenPosition(mint)) return { ok: false, reason: 'already have an open position in this mint' };
  mintsBeingBought.add(mint);

  try {
    const priceInfo = await dexscreener.getTokenPriceUsd(mint);
    if (!priceInfo) return { ok: false, reason: 'no live price data found for this mint' };

    const balance = executor.getBalanceSol();
    const size = Math.min(amountSol, balance);
    if (size <= 0) return { ok: false, reason: 'paper balance is empty' };

    const result = await executor.buy({ amountSol: size, priceUsd: priceInfo.priceUsd });
    if (!result.success) return { ok: false, reason: result.error };

    db.prepare(`
      INSERT INTO positions (mint, name, symbol, entry_price_usd, original_amount_sol, remaining_amount_sol, entry_score, opened_at, max_hold_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(mint, mint.slice(0, 6), mint.slice(0, 6), result.filledPriceUsd, size, size, null, Date.now(), config.holdMinutesTier2);

    recordTrade({
      mint, name: mint.slice(0, 6), symbol: mint.slice(0, 6), side: 'buy', amountSol: size, priceUsd: result.filledPriceUsd, reason: 'manual',
    });
    logger.info('Manual position opened', { mint, amountSol: size });
    return { ok: true, amountSol: size };
  } finally {
    mintsBeingBought.delete(mint);
  }
}

/** /sell <mint> - force-closes whatever remains, regardless of ladder state -
 * the manual-override safety valve for a position whose automated exit
 * tracking might have stopped working. */
async function attemptManualSell(mint) {
  const position = db.prepare("SELECT * FROM positions WHERE mint = ? AND status = 'open'").get(mint);
  if (!position) return { ok: false, reason: 'no open position for this mint' };
  const priceInfo = await dexscreener.getTokenPriceUsd(mint);
  if (!priceInfo) return { ok: false, reason: 'no live price data found for this mint' };
  await sellFraction(position, 1, 'manual sell', priceInfo.priceUsd, null);
  return { ok: true, symbol: position.symbol };
}

function closePosition(position, reason) {
  db.prepare("UPDATE positions SET status = 'closed', remaining_amount_sol = 0 WHERE id = ?").run(position.id);
}

async function sellFraction(position, fractionOfOriginal, reason, currentPriceUsd, currentScore) {
  const desiredAmount = position.original_amount_sol * fractionOfOriginal;
  const amountSol = Math.min(desiredAmount, position.remaining_amount_sol);
  if (amountSol <= 0) return;
  const newRemaining = Math.max(0, position.remaining_amount_sol - amountSol);

  // Atomic reservation, claimed BEFORE calling executor.sell - real bug found
  // live: overlapping exit-poll ticks (see index.js's scheduleInterval fix)
  // each read the same stale remaining_amount_sol and independently sold the
  // same "70% of original" slice, repeatedly, because neither's read ever
  // reflected the other's write. Confirmed live as one position selling 36
  // times in ~13 minutes instead of once, always at the exact same amount.
  // This UPDATE only matches if remaining_amount_sol is still what we think
  // it is; if a concurrent call already moved it, this claims zero rows and
  // we abort BEFORE moving any (paper, later real) money - not after.
  const claim = db.prepare('UPDATE positions SET remaining_amount_sol = ? WHERE id = ? AND remaining_amount_sol = ?')
    .run(newRemaining, position.id, position.remaining_amount_sol);
  if (claim.changes === 0) {
    logger.warn('Skipped a sell - position state changed since it was read (overlapping tick, now guarded)', {
      mint: position.mint, symbol: position.symbol, reason,
    });
    return;
  }

  const result = await executor.sell({ amountSol, priceUsd: currentPriceUsd, entryPriceUsd: position.entry_price_usd });
  position.remaining_amount_sol = newRemaining;

  recordTrade({
    mint: position.mint, name: position.name, symbol: position.symbol, side: 'sell', fraction: fractionOfOriginal,
    amountSol, priceUsd: result.filledPriceUsd, score: currentScore, reason, realizedPnlSol: result.realizedPnlSol,
  });

  logger.info('Position partial/full sell', {
    mint: position.mint, symbol: position.symbol, amountSol, remaining: newRemaining, reason, realizedPnlSol: result.realizedPnlSol,
  });

  const fullyClosed = newRemaining <= 0.0000001;
  if (fullyClosed) closePosition(position, reason);

  // Real gap found (user noticed a sell with zero notification): entry alerts
  // were built from day one, but nothing ever told the user when a position
  // actually sold - trades were only visible by asking. Lazy require avoids a
  // circular dependency (telegramBot.js requires positions.js at top level).
  const pnlSign = result.realizedPnlSol >= 0 ? '+' : '';
  require('./telegramBot').sendAlert(
    [
      `${result.realizedPnlSol >= 0 ? '💰' : '🔻'} Sold ${(fractionOfOriginal * 100).toFixed(0)}% of $${position.symbol} — ${reason}`,
      `Amount: ${amountSol.toFixed(4)} SOL — P&L: ${pnlSign}${result.realizedPnlSol.toFixed(4)} SOL`,
      fullyClosed ? 'Position fully closed.' : `Remaining: ${newRemaining.toFixed(4)} SOL still open.`,
    ].join('\n'),
  );
}

/**
 * Exit logic per spec Section 9 - two independent fixed-fraction-of-original
 * ladders (bearish score/volume-drop, bullish take-profit), plus two
 * immediate full-close overrides (insider sell, stop-loss) that fire
 * regardless of ladder state. See plan doc for why this reading of the
 * spec's table (two sequences, not one flat list) was chosen.
 */
async function evaluateExit(position, liveToken, liveScoreResult) {
  if (position.status !== 'open') return;

  const changePct = ((liveToken.priceUsd - position.entry_price_usd) / position.entry_price_usd) * 100;
  const peakChangePct = Math.max(position.peak_change_pct, changePct);
  if (peakChangePct !== position.peak_change_pct) {
    db.prepare('UPDATE positions SET peak_change_pct = ? WHERE id = ?').run(peakChangePct, position.id);
    position.peak_change_pct = peakChangePct;
  }

  // Immediate full-close override
  if (changePct <= config.stopLossPct) {
    await sellFraction(position, 1, `stop-loss (${changePct.toFixed(1)}%)`, liveToken.priceUsd, liveScoreResult.score);
    return;
  }

  const ageMinutes = (Date.now() - position.opened_at) / 60000;
  if (ageMinutes >= position.max_hold_minutes) {
    await sellFraction(position, 1, `max hold reached (${ageMinutes.toFixed(0)}min)`, liveToken.priceUsd, liveScoreResult.score);
    return;
  }

  // Bullish take-profit ladder (fixed fractions of ORIGINAL size)
  if (!position.tp3_fired && changePct >= config.takeProfitTier3Pct) {
    db.prepare('UPDATE positions SET tp1_fired=1, tp2_fired=1, tp3_fired=1 WHERE id=?').run(position.id);
    position.tp1_fired = position.tp2_fired = position.tp3_fired = 1;
    await sellFraction(position, 1, `take-profit tier 3 (+${changePct.toFixed(0)}%) - selling remainder`, liveToken.priceUsd, liveScoreResult.score);
    return;
  }
  if (!position.tp2_fired && changePct >= config.takeProfitTier2Pct) {
    db.prepare('UPDATE positions SET tp1_fired=1, tp2_fired=1 WHERE id=?').run(position.id);
    position.tp1_fired = position.tp2_fired = 1;
    await sellFraction(position, config.takeProfitTier2SellFraction, `take-profit tier 2 (+${changePct.toFixed(0)}%)`, liveToken.priceUsd, liveScoreResult.score);
    return;
  }
  if (!position.tp1_fired && changePct >= config.takeProfitTier1Pct) {
    db.prepare('UPDATE positions SET tp1_fired=1 WHERE id=?').run(position.id);
    position.tp1_fired = 1;
    await sellFraction(position, config.takeProfitTier1SellFraction, `take-profit tier 1 (+${changePct.toFixed(0)}%)`, liveToken.priceUsd, liveScoreResult.score);
    return;
  }

  // Bearish hype-dying ladder - only relevant while no take-profit has fired
  // (a position that's already banking gains is judged by the ladder above).
  if (position.tp1_fired) return;

  // Grace period - see config.js's bearishExitGraceSeconds comment for the
  // real data behind this. Stop-loss/take-profit/max-hold above are NOT
  // gated by this - only the score/volume ladder, which is what was firing
  // near-instantly on live data.
  if (ageMinutes * 60 < config.bearishExitGraceSeconds) return;

  if (!position.score_exit_fired && liveScoreResult.score < config.scoreExitThreshold) {
    db.prepare('UPDATE positions SET score_exit_fired=1 WHERE id=?').run(position.id);
    position.score_exit_fired = 1;
    await sellFraction(position, 0.7, `hype score dropped below ${config.scoreExitThreshold} (now ${liveScoreResult.score})`, liveToken.priceUsd, liveScoreResult.score);
    return;
  }
  if (position.score_exit_fired && !position.volume_exit_fired && liveScoreResult.volumeRatio < config.volumeExitMultiplier) {
    db.prepare('UPDATE positions SET volume_exit_fired=1 WHERE id=?').run(position.id);
    position.volume_exit_fired = 1;
    await sellFraction(position, 1, `volume dropped below ${config.volumeExitMultiplier}x average`, liveToken.priceUsd, liveScoreResult.score);
  }
}

module.exports = {
  attemptEntry,
  evaluateExit,
  getOpenPositions,
  getOpenPositionCount,
  recordTrade,
  isPaused,
  pause,
  resume,
  resetSession,
  attemptManualBuy,
  attemptManualSell,
};
