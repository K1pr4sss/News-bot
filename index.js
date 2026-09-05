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

// Live, on-demand proof for "is Telegram actually working right now" -
// separate from /diagnostics' telegram.getStatus(), which only reflects
// captures already made this process. Queries each tracked group fresh.
app.get('/telegram-check', async (req, res) => {
  res.json(await telegramUserClient.checkFreshness());
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

/**
 * Price-only, and every open position checked CONCURRENTLY. Both of those are
 * deliberate, and both come from measured damage (2026-09-05).
 *
 * This used to call evaluator.getLiveTokenAndScore per position, which makes a
 * GeckoTerminal getPoolsForToken call on the shared ~30 req/min queue - and it
 * did so SEQUENTIALLY, so N open positions meant N x 2.1s of queue spacing
 * before the last one was even looked at, on top of whatever backlog
 * discovery/trending/pending had already put in front of it.
 *
 * What that cost, from the 7 real stop-losses: 5 of them were LATENCY, not
 * price gapping. UNSTABLE's low touched -20.8% and it sold 171s later at
 * -24.1%. Dark Arena breached -25.2% and sold 157s later at -90.8%.
 * Filling every stop at the actual -20% level instead of where they really
 * landed would have been worth 0.125 SOL - roughly HALF the account's entire
 * -0.268 SOL loss, from latency alone.
 *
 * The GeckoTerminal call is now unnecessary rather than merely expensive: the
 * old bearish score/volume ladder was the only exit rule that read the score,
 * and it's gone. Stop-loss, take-profit, max-hold and the thesis cut all key
 * on price and elapsed time only, and price comes from DexScreener, which is
 * not on that queue. So the whole risk path is now one fast independent HTTP
 * call per position, running in parallel - no shared queue, no head-of-line
 * blocking behind tokens nobody owns.
 */
async function exitTick() {
  try {
    const open = positions.getOpenPositions();
    if (!open.length) return;
    await Promise.all(open.map(async (position) => {
      try {
        const priceInfo = await dexscreener.getTokenPriceUsd(position.mint);
        if (!priceInfo) return;
        await positions.evaluateExit(position, { priceUsd: priceInfo.priceUsd });
      } catch (err) {
        // Per-position catch: one unreadable mint must not abort the exit
        // check for every OTHER open position in the same tick.
        logger.error('Exit check failed for a position', { mint: position.mint, error: err.message });
      }
    }));
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
