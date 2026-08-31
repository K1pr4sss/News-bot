const config = require('./config');
const db = require('./db');
const executor = require('./executor');
const scoring = require('./scoring');
const walletTracker = require('./walletTracker');
const logger = require('./logger');

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
async function attemptEntry(token, scoreResult) {
  if (hasOpenPosition(token.mint)) return null;
  if (wasRecentlyBought(token.mint)) return null;
  if (getOpenPositionCount() >= config.maxOpenPositions) return null;

  const balance = executor.getBalanceSol();
  const tier = scoring.computeSizeTier(scoreResult.score);
  const amountSol = Math.min(balance * tier.pct, balance * config.maxTradePct);
  if (amountSol <= 0) return null;

  const result = await executor.buy({ amountSol, priceUsd: token.priceUsd });
  if (!result.success) {
    logger.warn('Paper buy failed', { mint: token.mint, error: result.error });
    return null;
  }

  db.prepare(`
    INSERT INTO positions (mint, name, symbol, entry_price_usd, original_amount_sol, remaining_amount_sol, entry_score, opened_at, max_hold_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(token.mint, token.name, token.symbol, result.filledPriceUsd, amountSol, amountSol, scoreResult.score, Date.now(), tier.holdMinutes);

  recordTrade({
    mint: token.mint, name: token.name, symbol: token.symbol, side: 'buy', amountSol,
    priceUsd: result.filledPriceUsd, score: scoreResult.score, reason: `entry (${tier.label} band)`,
  });

  logger.info('Position opened', {
    mint: token.mint, symbol: token.symbol, amountSol, score: scoreResult.score, sizeTier: tier.label,
  });
  return { mint: token.mint, amountSol, score: scoreResult.score, tier };
}

function closePosition(position, reason) {
  db.prepare("UPDATE positions SET status = 'closed', remaining_amount_sol = 0 WHERE mint = ?").run(position.mint);
}

async function sellFraction(position, fractionOfOriginal, reason, currentPriceUsd, currentScore) {
  const desiredAmount = position.original_amount_sol * fractionOfOriginal;
  const amountSol = Math.min(desiredAmount, position.remaining_amount_sol);
  if (amountSol <= 0) return;

  const result = await executor.sell({ amountSol, priceUsd: currentPriceUsd, entryPriceUsd: position.entry_price_usd });
  const remaining = Math.max(0, position.remaining_amount_sol - amountSol);
  db.prepare('UPDATE positions SET remaining_amount_sol = ? WHERE mint = ?').run(remaining, position.mint);
  position.remaining_amount_sol = remaining;

  recordTrade({
    mint: position.mint, name: position.name, symbol: position.symbol, side: 'sell', fraction: fractionOfOriginal,
    amountSol, priceUsd: result.filledPriceUsd, score: currentScore, reason, realizedPnlSol: result.realizedPnlSol,
  });

  logger.info('Position partial/full sell', {
    mint: position.mint, symbol: position.symbol, amountSol, remaining, reason, realizedPnlSol: result.realizedPnlSol,
  });

  if (remaining <= 0.0000001) closePosition(position, reason);
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
    db.prepare('UPDATE positions SET peak_change_pct = ? WHERE mint = ?').run(peakChangePct, position.mint);
    position.peak_change_pct = peakChangePct;
  }

  // Immediate full-close overrides
  if (walletTracker.checkAndConsumeBigSell(position.mint)) {
    await sellFraction(position, 1, 'insider wallet sold >50% of its position', liveToken.priceUsd, liveScoreResult.score);
    return;
  }
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
    db.prepare('UPDATE positions SET tp1_fired=1, tp2_fired=1, tp3_fired=1 WHERE mint=?').run(position.mint);
    position.tp1_fired = position.tp2_fired = position.tp3_fired = 1;
    await sellFraction(position, 1, `take-profit tier 3 (+${changePct.toFixed(0)}%) - selling remainder`, liveToken.priceUsd, liveScoreResult.score);
    return;
  }
  if (!position.tp2_fired && changePct >= config.takeProfitTier2Pct) {
    db.prepare('UPDATE positions SET tp1_fired=1, tp2_fired=1 WHERE mint=?').run(position.mint);
    position.tp1_fired = position.tp2_fired = 1;
    await sellFraction(position, config.takeProfitTier2SellFraction, `take-profit tier 2 (+${changePct.toFixed(0)}%)`, liveToken.priceUsd, liveScoreResult.score);
    return;
  }
  if (!position.tp1_fired && changePct >= config.takeProfitTier1Pct) {
    db.prepare('UPDATE positions SET tp1_fired=1 WHERE mint=?').run(position.mint);
    position.tp1_fired = 1;
    await sellFraction(position, config.takeProfitTier1SellFraction, `take-profit tier 1 (+${changePct.toFixed(0)}%)`, liveToken.priceUsd, liveScoreResult.score);
    return;
  }

  // Bearish hype-dying ladder - only relevant while no take-profit has fired
  // (a position that's already banking gains is judged by the ladder above).
  if (position.tp1_fired) return;

  if (!position.score_exit_fired && liveScoreResult.score < config.scoreExitThreshold) {
    db.prepare('UPDATE positions SET score_exit_fired=1 WHERE mint=?').run(position.mint);
    position.score_exit_fired = 1;
    await sellFraction(position, 0.7, `hype score dropped below ${config.scoreExitThreshold} (now ${liveScoreResult.score})`, liveToken.priceUsd, liveScoreResult.score);
    return;
  }
  if (position.score_exit_fired && !position.volume_exit_fired && liveScoreResult.volumeRatio < config.volumeExitMultiplier) {
    db.prepare('UPDATE positions SET volume_exit_fired=1 WHERE mint=?').run(position.mint);
    position.volume_exit_fired = 1;
    await sellFraction(position, 1, `volume dropped below ${config.volumeExitMultiplier}x average`, liveToken.priceUsd, liveScoreResult.score);
  }
}

module.exports = {
  attemptEntry, evaluateExit, getOpenPositions, getOpenPositionCount, recordTrade,
};
