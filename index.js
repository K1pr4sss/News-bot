const express = require('express');
const config = require('./lib/config');
const logger = require('./lib/logger');
const db = require('./lib/db');
const jupiter = require('./lib/jupiter');
const jupiterTokens = require('./lib/jupiterTokens');
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

// ?status=closed|all (default: open) and ?limit=N.
//
// Every position records entry_metrics - a JSON blob of liquidityUsd,
// volumeH1Usd, buyersH1/sellersH1, buySellRatio, volumePerTraderUsd and the
// m5/h1/h6/h24 price changes, captured at the moment of the buy. That is the
// single richest feature set the bot owns for the question that matters (what
// distinguishes a trade that works from one that dies) and it was unreachable,
// because only OPEN positions were ever served and the interesting ones are
// all closed. Reconstructing those features afterwards means replaying
// third-party candles against a rate limit, which is both slower and less
// accurate than the reading the bot took at the time.
app.get('/positions', (req, res) => {
  const status = req.query.status;
  if (!status || status === 'open') return res.json(positions.getOpenPositions());
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM positions ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM positions WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit);
  res.json(rows);
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
    // The one that actually answers "which filter is costing us trades" -
    // rejectionReasons above double-counts every candidate that failed more
    // than one filter, so a big number there doesn't mean that filter is the
    // binding constraint. See stats.recordRejection.
    soleRejectionReasons: stats.soleRejectionReasons,
    nearMisses: stats.nearMisses,
    pendingCandidates: evaluator.getPendingCount(),
    // Candidates the strategy WANTED and did not get - cleared every filter,
    // scored high enough to alert, then refused at the entry stage. Distinct
    // from rejectionReasons, which is candidates the strategy decided against.
    entryFailures: stats.entryFailures,
    recentEntryFailures: stats.recentEntryFailures,
    autoBuyPaused: positions.isPaused(),
    minMentionCount: config.minMentionCount,
    scoreAlertThreshold: config.scoreAlertThreshold,
    telegram: telegramUserClient.getStatus(),
  });
});

// Live, on-demand proof for "is Telegram actually working right now" -
// separate from /diagnostics' telegram.getStatus(), which only reflects
// captures already made this process. Queries each tracked group fresh.
// Real rejected candidates with the VALUES that rejected them - the data that
// makes "should I loosen filter X" a measurable question instead of a
// prospective experiment. ?sole=1 returns only single-blocker rows, which are
// the only ones a threshold change would actually convert into trades.
app.get('/rejections', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  // ?before=<id> pages backwards. Without it this endpoint could only ever
  // show the newest 2,000 rows, and rejections are written fast enough that
  // 2,000 rows is under two hours - so the 72 hours the table actually retains
  // were unreachable. The counterfactual that matters most (how do the coins
  // the momentum gate turned away actually perform?) needs candidates old
  // enough to have forward prices, which is exactly what the newest rows are
  // not. ?sole filters to single-reason rejections, which are the only ones
  // that isolate one gate's effect.
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = req.query.sole
    ? db.prepare('SELECT * FROM rejections WHERE sole_reason IS NOT NULL AND id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
    : db.prepare('SELECT * FROM rejections WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit);
  res.json(rows);
});

// "Are all the socials actually tracked?" - previously unanswerable without
// reading logs. Every mention source fails CLOSED (returns 0 mentions) when it
// is unconfigured, out of quota, out of prepaid credit, or erroring - which is
// byte-for-byte identical to "nobody is talking about this coin". Since the
// entry gate requires at least one real mention, a silently dead source
// narrows the funnel invisibly. This makes each one state its own health.
app.get('/sources', (req, res) => {
  const yt = youtube.getStatus();
  const tw = twitter.getStatus();
  const fc = farcaster.getStatus();
  const tg = telegramUserClient.getStatus();
  res.json({
    note: 'every source degrades to 0 mentions rather than erroring - check configured/lastSuccessAt, not just the count',
    mentionSources: {
      telegramAlphaGroups: {
        configured: tg.configured, connected: tg.connected, trackedGroups: tg.trackedGroups, recentMessageCount: tg.recentMessageCount,
      },
      youtube: yt,
      xTwitter: tw,
      farcaster: fc,
      googleAlerts: { configured: config.googleAlertsRssUrls.length > 0, feedCount: config.googleAlertsRssUrls.length },
      reddit: { configured: !!(config.redditClientId && config.redditClientSecret) },
    },
    // The sentiment category is worth 10 points and reads positiveRatio, which
    // ONLY Reddit produces. With Reddit unconfigured it is permanently 0, so
    // the real ceiling is 90/100 while the 40/55/70 sizing bands are still
    // calibrated against 100.
    scoringCeiling: {
      nominalMax: 100,
      sentimentReachable: !!(config.redditClientId && config.redditClientSecret),
      effectiveMax: (config.redditClientId && config.redditClientSecret) ? 100 : 90,
    },
    entryGate: { minMentionCount: config.minMentionCount, scoreAlertThreshold: config.scoreAlertThreshold },
    // The execution-cost gate is the one input here that is measured rather
    // than inferred, so its health matters differently from the others: when
    // Jupiter is unreachable this gate does not fail loudly, it stops refusing
    // anything, and the bot silently goes back to trading blind on cost. `ok`
    // counts successful quotes, so a rising `failed` with a flat `ok` is the
    // shape to watch for.
    executionCost: jupiter.getStatus(),
    // Recorded-only enrichment - see lib/jupiterTokens.js. gated:false is the
    // point: if this ever starts gating, that was a deliberate decision made
    // against forward data, not a drift.
    tokenIntel: jupiterTokens.getStatus(),
  });
});

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

/**
 * Polls every configured trending WINDOW, not just GeckoTerminal's 24h default
 * (see geckoterminal.getTrendingPools). The short windows are where coins that
 * are running right now show up - the profile the entry data says actually
 * makes money - and nothing else in this bot could see them: new_pools is
 * 2-minute-old tokens that no safety filter passes, and the 24h list is
 * nine-day-old coins with no live momentum.
 *
 * Cost is one extra batched call per window per tick, ~0.4/min at the default
 * 5-minute interval - negligible against the ~25/min GeckoTerminal budget, and
 * nothing like the per-token flood that had to be removed on 2026-09-02.
 * Deduped across windows so a coin trending on several doesn't get evaluated
 * (and rate-limited against) several times per tick.
 */
async function trendingTick() {
  try {
    const seen = new Set();
    const pools = [];
    for (const duration of config.trendingDurations) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await geckoterminal.getTrendingPools(duration);
      for (const p of batch) if (!seen.has(p.mint)) { seen.add(p.mint); pools.push(p); }
    }
    logger.debug('Trending tick', { windows: config.trendingDurations.length, uniqueCandidates: pools.length });
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
  // Keeps the rejections table bounded. At the observed ~12 candidates/min
  // this is roughly 17k rows/day, so the retention window is what stops the
  // Railway volume filling up over weeks.
  scheduleInterval(async () => {
    const cutoff = Date.now() - config.rejectionRetentionHours * 3600 * 1000;
    const { changes } = db.prepare('DELETE FROM rejections WHERE created_at < ?').run(cutoff);
    if (changes) logger.info('Pruned old rejection rows', { deleted: changes, retentionHours: config.rejectionRetentionHours });
  }, 3600 * 1000);

  app.listen(config.port, () => logger.info(`HTTP server listening on :${config.port}`));
}

start();
