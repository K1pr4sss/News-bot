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
const walletTracker = require('./lib/walletTracker');
const telegramBot = require('./lib/telegramBot');
const positions = require('./lib/positions');
const evaluator = require('./lib/evaluator');
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
  // Give GeckoTerminal's own indexer a little time to pick up the pool before
  // trying to resolve it - see getPoolsForToken's own comment on why this is
  // best-effort. If it's not found yet, the next discoveryTick/new_pools poll
  // will pick this token up anyway once it has real trading data.
  setTimeout(async () => {
    try {
      const pools = await geckoterminal.getPoolsForToken(msg.mint);
      for (const token of pools) await evaluator.evaluateCandidate(token);
    } catch (err) {
      logger.debug('PumpPortal->GeckoTerminal resolve failed', { mint: msg.mint, error: err.message });
    }
  }, 30000);
}

function scheduleInterval(fn, intervalMs) {
  fn().catch((e) => logger.error('Scheduled tick failed', { error: e.message }));
  setInterval(() => fn().catch((e) => logger.error('Scheduled tick failed', { error: e.message })), intervalMs);
}

function start() {
  logger.info('HypeBot v2 starting', { paperTrading: config.paperTrading, port: config.port });

  coingecko.start();
  dexscreener.start();
  reddit.start();
  googleAlerts.start();
  walletTracker.start();
  telegramBot.start();

  pumpPortal = new PumpPortalStream({ onNewToken: handlePumpPortalCreate });
  pumpPortal.start();

  scheduleInterval(discoveryTick, config.discoveryPollIntervalMs);
  scheduleInterval(trendingTick, config.trendingPollIntervalMs);
  scheduleInterval(exitTick, config.exitPollIntervalMs);

  app.listen(config.port, () => logger.info(`HTTP server listening on :${config.port}`));
}

start();
