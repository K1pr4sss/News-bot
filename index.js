const express = require('express');
const config = require('./lib/config');
const logger = require('./lib/logger');
const db = require('./lib/db');
const executor = require('./lib/executor');
const geckoterminal = require('./lib/geckoterminal');
const coingecko = require('./lib/coingecko');
const dexscreener = require('./lib/dexscreener');
const reddit = require('./lib/reddit');
const googleAlerts = require('./lib/googleAlerts');
const telegramUserClient = require('./lib/telegramUserClient');
const youtube = require('./lib/youtube');
const twitter = require('./lib/twitter');
const farcaster = require('./lib/farcaster');
const telegramBot = require('./lib/telegramBot');
const positions = require('./lib/positions');
const evaluator = require('./lib/evaluator');
const stats = require('./lib/stats');
const PumpPortalStream = require('./lib/pumpPortalStream');

const app = express();

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    paperTrading: config.paperTrading,
    pumpPortalStatus: pumpPortal.status,
    openPositions: positions.getOpenPositionCount(),
    balanceSol: executor.getBalanceSol(),
  });
});

app.get('/stats', (req, res) => {
  const trades = db.prepare('SELECT COUNT(*) as c FROM trades').get().c;
  const sells = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(realized_pnl_sol),0) as pnl FROM trades WHERE side='sell'").get();
  res.json({
    totalTrades: trades,
    sellEvents: sells.c,
    totalRealizedPnlSol: sells.pnl,
    balanceSol: executor.getBalanceSol(),
    openPositions: positions.getOpenPositionCount(),
  });
});

app.get('/trades', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const rows = db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.get('/positions', (req, res) => {
  res.json(positions.getOpenPositions());
});

// "Why no alerts/buys" is unanswerable from /health+/stats alone - both only
// show OUTCOMES (trades, balance), not why candidates never became one.
// stats.js already tracked this in memory the whole time (rejectionReasons,
// nearMisses) but nothing ever exposed it over HTTP - only via Telegram's
// /reasons /nearmiss commands, which this session can't read directly.
app.get('/diagnostics', (req, res) => {
  res.json({
    uptimeMs: Date.now() - stats.startedAt,
    tokensScanned: stats.tokensScanned,
    alertsSent: stats.alertsSent,
    recentAlerts: stats.recentAlerts,
    rejectionReasons: stats.rejectionReasons,
    nearMisses: stats.nearMisses,
    pendingCandidates: evaluator.getPendingCount(),
    autoBuyPaused: positions.isPaused(),
    minMentionCount: config.minMentionCount,
    scoreAlertThreshold: config.scoreAlertThreshold,
    telegram: telegramUserClient.getStatus(),
  });
});

// TEMPORARY, one-off data correction - see project memory for the full
// investigation. The "pippo" trade (2026-09-02) recorded a buy at a stale
// discovery-time price ($0.0000245) that never matched the coin's real
// trading history; the real price at that exact buy timestamp (per
// GeckoTerminal's own 1-min candle) was ~$0.0000926, making the real move
// +11.8%, not the +331% the buggy entry price produced. User asked for the
// historical record corrected, not just flagged. Removed immediately after
// running once - this is not a standing capability.
app.get('/admin/fix-pippo-2026-09-03', (req, res) => {
  const mint = 'Gffw364rz4r93aYum3BHynoi5iw1gsq2m4P2Py6gpump';
  const buggyEntryPrice = 0.000024521174686288354; // the original stale-price bug's recorded value
  const correctedEntryPrice = 0.00009354004415180182; // real candle open at buy time * (1 + paperSlippagePct/100), same formula executor.buy() uses
  const correctedPnl = 0.010051196545560873; // recomputed via executor.sell()'s exact formula against the (already-correct) recorded exit price
  const correctedReason = 'take-profit tier 3 (+11.8%, corrected from a stale-price bug - real number, see project notes)';
  const balanceDelta = 0.29551950; // old buggy pnl (0.30557069875914633) minus corrected pnl - the exact fake-profit amount to remove from the current balance

  const buyRow = db.prepare("SELECT * FROM trades WHERE mint = ? AND side = 'buy'").get(mint);
  const sellRow = db.prepare("SELECT * FROM trades WHERE mint = ? AND side = 'sell'").get(mint);
  if (!buyRow || !sellRow) return res.status(404).json({ error: 'trades not found' });

  // Idempotency guard - this already ran once (price_usd corrected already);
  // re-running must fix the reason-string label without re-subtracting the
  // balance delta a second time, which would silently corrupt the balance.
  const alreadyApplied = Math.abs(buyRow.price_usd - buggyEntryPrice) > 1e-9;

  db.prepare('UPDATE trades SET price_usd = ? WHERE id = ?').run(correctedEntryPrice, buyRow.id);
  db.prepare('UPDATE trades SET realized_pnl_sol = ?, reason = ? WHERE id = ?').run(correctedPnl, correctedReason, sellRow.id);
  db.prepare('UPDATE positions SET entry_price_usd = ? WHERE mint = ?').run(correctedEntryPrice, mint);

  const walletBefore = db.prepare('SELECT balance_sol FROM paper_wallet WHERE id = 1').get();
  let newBalance = walletBefore.balance_sol;
  if (!alreadyApplied) {
    newBalance = walletBefore.balance_sol - balanceDelta;
    db.prepare('UPDATE paper_wallet SET balance_sol = ? WHERE id = 1').run(newBalance);
  }

  res.json({
    ok: true,
    alreadyApplied,
    correctedEntryPrice,
    correctedPnl,
    balanceBefore: walletBefore.balance_sol,
    balanceAfter: newBalance,
  });
});

let pumpPortal;

async function discoveryTick() {
  try {
    const pools = await geckoterminal.getNewPools();
    logger.debug('Discovery tick', { candidates: pools.length });
    for (const token of pools) {
      await evaluator.evaluateCandidate(token);
    }
  } catch (err) {
    logger.error('Discovery tick failed', { error: err.message });
  }
}

async function trendingTick() {
  try {
    const pools = await geckoterminal.getTrendingPools();
    for (const token of pools) {
      await evaluator.evaluateCandidate(token, { trendingPool: true });
    }
  } catch (err) {
    logger.error('Trending tick failed', { error: err.message });
  }
}

async function pendingTick() {
  try {
    await evaluator.pendingCandidatesTick();
  } catch (err) {
    logger.error('Pending-candidate retry tick failed', { error: err.message });
  }
}

async function exitTick() {
  try {
    const open = positions.getOpenPositions();
    for (const position of open) {
      const result = await evaluator.getLiveTokenAndScore(position);
      if (!result) continue;
      await positions.evaluateExit(position, result.liveToken, result.scoreResult);
    }
  } catch (err) {
    logger.error('Exit tick failed', { error: err.message });
  }
}

async function handlePumpPortalCreate(msg) {
  logger.info('PumpPortal new token', { mint: msg.mint, symbol: msg.symbol });
  // Real bug found via live diagnostics (2026-09-02): this used to fire its
  // own individual GeckoTerminal getPoolsForToken lookup per new token, 30s
  // after creation. PumpPortal alone produces dozens of tokens/minute under
  // real load - that's dozens of extra low-priority calls/minute competing
  // for the same ~30 req/min GeckoTerminal budget that pendingCandidatesTick
  // (one call per pending candidate, every 90s - already 20-30+/min on a
  // real pending queue) and exit-tick's now-prioritized position checks all
  // share. Real evidence this was saturating the whole pipeline: a 14-hour
  // production window logged only 36 total rejections, 100% of them on
  // liquidity/top-holder - i.e. NOTHING ever cleared filters to even reach
  // scoring, because candidates that would have matured never got a timely
  // re-check before aging out of the pending queue. discoveryTick already
  // polls GeckoTerminal's batch new_pools endpoint every 2 minutes and picks
  // up the same new tokens in ONE call regardless of how many launched -
  // this per-token resolve was redundant with that, not additive coverage,
  // and was the single biggest source of the overload. Detection now lags
  // by up to ~2min (one discoveryTick cycle) instead of ~30s, in exchange
  // for the whole pipeline actually being able to keep up.
}

// Self-scheduling (setTimeout-after-completion), NOT setInterval - real bug
// found live: setInterval fires on a fixed clock regardless of whether the
// previous call finished, and exitTick's own GeckoTerminal calls share the
// same rate-limited queue as discovery/trending/pending, which can back up
// well past the 10s exit interval under load. That let TWO overlapping
// exitTick calls run at once, each reading a position's flags/remaining
// amount BEFORE the other's sell had been written, each independently
// deciding to sell - confirmed live as a single RUPERT position selling
// "70% of original" 36 TIMES in a row instead of once. This alone doesn't
// fully close the gap (see positions.js's atomic flag-claim for the actual
// belt-and-suspenders fix), but it removes the root cause.
function scheduleInterval(fn, intervalMs) {
  const run = () => {
    fn().catch((e) => logger.error('Scheduled tick failed', { error: e.message }))
      .finally(() => setTimeout(run, intervalMs));
  };
  run();
}

function start() {
  logger.info('HypeBot v2 starting', { paperTrading: config.paperTrading, port: config.port });

  coingecko.start();
  dexscreener.start();
  reddit.start();
  googleAlerts.start();
  telegramUserClient.start();
  youtube.start();
  twitter.start();
  farcaster.start();
  telegramBot.start();

  pumpPortal = new PumpPortalStream({ onNewToken: handlePumpPortalCreate });
  pumpPortal.start();

  scheduleInterval(discoveryTick, config.discoveryPollIntervalMs);
  scheduleInterval(trendingTick, config.trendingPollIntervalMs);
  scheduleInterval(pendingTick, config.pendingCandidateRecheckIntervalMs);
  scheduleInterval(exitTick, config.exitPollIntervalMs);

  app.listen(config.port, () => logger.info(`HTTP server listening on :${config.port}`));
}

start();
