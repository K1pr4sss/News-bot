const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./db');
const executor = require('./executor');
const positions = require('./positions');
const telegramUserClient = require('./telegramUserClient');
const dexscreener = require('./dexscreener');
const reddit = require('./reddit');
const googleAlerts = require('./googleAlerts');
const youtube = require('./youtube');
const twitter = require('./twitter');
const farcaster = require('./farcaster');
const coingecko = require('./coingecko');
const rugcheck = require('./rugcheck');
const birdeye = require('./birdeye');
const stats = require('./stats');
const { groupSellsIntoPositions, positionPnl } = require('./pnlStats');
const logger = require('./logger');

function fmtSol(n) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(4)} SOL`;
}

function fmtAge(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

// Single source of truth for /start, /help, and Telegram's native "/" menu.
const COMMANDS = [
  { cmd: 'start', usage: '/start', desc: 'Welcome message + this list' },
  { cmd: 'help', usage: '/help', desc: 'Same as /start' },
  { cmd: 'status', usage: '/status', desc: 'Bot stats: uptime, tokens scanned, alerts sent, discovery status' },
  { cmd: 'config', usage: '/config', desc: 'Current live thresholds, sizing, and exit-ladder settings' },
  { cmd: 'queue', usage: '/queue', desc: 'Last 10 alerts (score cleared threshold + filters)' },
  { cmd: 'reasons', usage: '/reasons', desc: 'Breakdown of why candidates got rejected' },
  { cmd: 'nearmiss', usage: '/nearmiss', desc: 'Last 15 tokens that got close but didn\'t alert' },
  { cmd: 'groups', usage: '/groups', desc: 'List Telegram groups currently feeding the social-velocity signal' },
  { cmd: 'addgroup', usage: '/addgroup <name>', desc: 'Track a Telegram group\'s messages (your account must already be a member)' },
  { cmd: 'removegroup', usage: '/removegroup <name>', desc: 'Stop tracking a Telegram group' },
  { cmd: 'balance', usage: '/balance', desc: 'Paper wallet balance' },
  { cmd: 'buy', usage: '/buy <mint> [amountSol]', desc: 'Manually paper-buy a specific token (skips score/filters - explicit override)' },
  { cmd: 'sell', usage: '/sell <mint>', desc: 'Force-sell the full remaining position for a mint' },
  { cmd: 'positions', usage: '/positions', desc: 'Open positions with live gain/loss + chart links' },
  { cmd: 'check', usage: '/check <mint> [symbol]', desc: 'Look up ANY coin (not just ones you hold): live price, RugCheck safety, and raw per-source mention counts - also proves each signal source is actually returning data' },
  { cmd: 'pnl', usage: '/pnl [all]', desc: 'Win/loss record + realized P&L since the last /resetsession ("/pnl all" = full history)' },
  { cmd: 'pause', usage: '/pause', desc: 'Stop new auto-buys (detection/alerts keep running)' },
  { cmd: 'resume', usage: '/resume', desc: 'Re-enable auto-buy after /pause' },
  { cmd: 'resetsession', usage: '/resetsession', desc: 'Reset paper balance to the starting amount + zero the /pnl window (asks for confirmation)' },
];
const COMMAND_LIST = COMMANDS.map((c) => `${c.usage} — ${c.desc}`);

let bot = null;

function start() {
  if (!config.telegramBotToken) {
    logger.warn('TELEGRAM_BOT_TOKEN not set - alerts/commands disabled');
    return;
  }
  bot = new TelegramBot(config.telegramBotToken, { polling: true });
  bot.setMyCommands(COMMANDS.map((c) => ({ command: c.cmd, description: c.desc })))
    .catch((err) => logger.warn('setMyCommands failed', { error: err.message }));

  // TELEGRAM_CHAT_ID isn't known until the user sends a first message - once
  // it's set, this stays silent for anyone else who happens to message the
  // bot (no id gets leaked to a stranger).
  if (!config.telegramChatId) {
    bot.on('message', (msg) => {
      logger.info('Telegram chat ID discovered', { chatId: msg.chat.id, from: msg.chat.username || msg.chat.first_name });
      bot.sendMessage(msg.chat.id, `Your chat ID: ${msg.chat.id}\n\nSend this to whoever's setting up the bot so they can set TELEGRAM_CHAT_ID.`);
    });
  }

  const isAuthorized = (msg) => !config.telegramChatId || String(msg.chat.id) === String(config.telegramChatId);
  const onText = (regex, handler) => {
    bot.onText(regex, (msg, match) => {
      if (!isAuthorized(msg)) {
        logger.warn('Ignored Telegram command from unauthorized chat', { chatId: msg.chat.id, text: msg.text });
        return;
      }
      handler(msg, match);
    });
  };

  onText(/^\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, [
      '👋 HypeBot v2',
      '',
      'Multi-signal hype detection (social/volume/trending/sentiment) for Solana, with a fully autonomous paper-trading engine.',
      `Mode: ${config.paperTrading ? '📝 PAPER TRADING (fake money)' : '🔴 LIVE'}`,
      '',
      'Commands:',
      ...COMMAND_LIST,
    ].join('\n'));
  });

  onText(/^\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, ['Commands:', ...COMMAND_LIST].join('\n'));
  });

  onText(/^\/status/, (msg) => {
    bot.sendMessage(msg.chat.id, [
      '📊 Bot Status',
      `Uptime: ${fmtAge(Date.now() - stats.startedAt)}`,
      `Mode: ${config.paperTrading ? 'paper' : 'LIVE'} — auto-buy ${positions.isPaused() ? '🔴 paused' : '🟢 active'}`,
      `Tokens scanned: ${stats.tokensScanned}`,
      `Pending re-checks (young tokens given time to mature): ${require('./evaluator').getPendingCount()}`,
      `Alerts sent (this run): ${stats.alertsSent}`,
      `Open positions: ${positions.getOpenPositionCount()}/${config.maxOpenPositions}`,
      `Paper balance: ${executor.getBalanceSol().toFixed(4)} SOL`,
    ].join('\n'));
  });

  onText(/^\/config/, (msg) => {
    bot.sendMessage(msg.chat.id, [
      '⚙️ Current Live Config',
      '',
      `Score alert threshold: ${config.scoreAlertThreshold}/100`,
      `Entry volume spike: >=${config.entryVolumeSpikeMultiplier}x`,
      `Min liquidity: $${config.minLiquidityUsd.toLocaleString()}`,
      `Max top holder: ${config.maxTopHolderPct}%`,
      'Missing socials: scoring bonus only (up to +15), not a hard reject',
      '',
      `Sizing: 40-55 -> ${(config.sizeTier1Pct * 100).toFixed(0)}%, 55-70 -> ${(config.sizeTier2Pct * 100).toFixed(0)}%, 70+ -> ${(config.sizeTier3Pct * 100).toFixed(0)}% of balance (cap ${(config.maxTradePct * 100).toFixed(0)}%)`,
      `Stop-loss: ${config.stopLossPct}%`,
      `Take-profit ladder: +${config.takeProfitTier1Pct}% sell ${(config.takeProfitTier1SellFraction * 100).toFixed(0)}%, +${config.takeProfitTier2Pct}% sell ${(config.takeProfitTier2SellFraction * 100).toFixed(0)}%, +${config.takeProfitTier3Pct}% sell remainder`,
      `Thesis cut: close fully if still <=${config.thesisCutBelowPct}% after ${config.thesisCutAfterMinutes}min (only while no take-profit has fired)`,
      `Momentum gate: ${config.minPriceMomentumH1Pct > 0 ? `require >=${config.minPriceMomentumH1Pct}% 1h price change` : 'disabled'}`,
      `Re-buy cooldown: ${config.rebuyCooldownHours}h`,
      `Max open positions: ${config.maxOpenPositions}`,
    ].join('\n'));
  });

  onText(/^\/queue/, (msg) => {
    const alerts = stats.recentAlerts.slice(-10).reverse();
    if (!alerts.length) {
      bot.sendMessage(msg.chat.id, 'No alerts sent yet (this run).');
      return;
    }
    bot.sendMessage(msg.chat.id, ['Last 10 alerts:', ...alerts.map((a) => `$${a.symbol} — ${a.score}/100 — ${a.mint}`)].join('\n'));
  });

  onText(/^\/reasons/, (msg) => {
    const r = stats.rejectionReasons;
    const total = Object.values(r).reduce((sum, n) => sum + n, 0);
    if (!total) {
      bot.sendMessage(msg.chat.id, 'No rejections logged yet (this run).');
      return;
    }
    const lines = ['🚫 Rejection Breakdown (this run)', ''];
    for (const [label, count] of Object.entries(r).sort((a, b) => b[1] - a[1])) {
      lines.push(`${label}: ${count} (${((count / total) * 100).toFixed(1)}%)`);
    }
    lines.push('', `Total: ${total}`);
    bot.sendMessage(msg.chat.id, lines.join('\n'));
  });

  onText(/^\/nearmiss/, (msg) => {
    const misses = stats.nearMisses;
    if (!misses.length) {
      bot.sendMessage(msg.chat.id, 'No near-misses logged yet (this run).');
      return;
    }
    const lines = misses.slice().reverse().map((m) => {
      const ago = Math.round((Date.now() - m.at) / 60000);
      return `$${m.symbol} — ${m.score}/100 (${m.reason}, ${ago}m ago) — ${m.mint}`;
    });
    bot.sendMessage(msg.chat.id, ['🔎 Recent near-misses:', '', ...lines].join('\n'));
  });

  onText(/^\/groups/, (msg) => {
    const groups = telegramUserClient.getTrackedGroups();
    if (!groups.length) {
      bot.sendMessage(msg.chat.id, 'No Telegram groups tracked. /addgroup <name> to add one (your account must already be a member).');
      return;
    }
    bot.sendMessage(msg.chat.id, [`👀 Tracked Telegram Groups (${groups.length})`, '', ...groups.map((g, i) => `${i + 1}. ${g}`)].join('\n'));
  });

  onText(/^\/addgroup (.+)/, (msg, match) => {
    const name = match[1].trim();
    telegramUserClient.addGroup(name);
    bot.sendMessage(msg.chat.id, `Added "${name}" to tracked groups. Make sure your account (the one used for TELEGRAM_USER_SESSION) is actually a member — messages only get scored if it is.`);
  });

  onText(/^\/removegroup (.+)/, (msg, match) => {
    const name = match[1].trim();
    telegramUserClient.removeGroup(name);
    bot.sendMessage(msg.chat.id, `Removed "${name}" from tracked groups.`);
  });

  onText(/^\/balance/, (msg) => {
    bot.sendMessage(msg.chat.id, `📝 Paper balance: ${executor.getBalanceSol().toFixed(4)} SOL (PAPER_TRADING=${config.paperTrading})`);
  });

  onText(/^\/buy(?:\s+(\S+))?(?:\s+([\d.]+))?/, async (msg, match) => {
    const mint = match[1];
    if (!mint) {
      bot.sendMessage(msg.chat.id, 'Usage: /buy <mint> [amountSol] — manually paper-buys a specific token, skipping score/filters (explicit override). Default size 0.05 SOL if omitted.');
      return;
    }
    const amountSol = match[2] ? parseFloat(match[2]) : 0.05;
    bot.sendMessage(msg.chat.id, `⏳ Buying $${mint.slice(0, 8)}... (${amountSol} SOL)...`);
    const result = await positions.attemptManualBuy(mint, amountSol);
    bot.sendMessage(msg.chat.id, result.ok
      ? `✅ Paper-bought ${result.amountSol.toFixed(4)} SOL of ${mint}`
      : `❌ Refused — ${result.reason}`);
  });

  onText(/^\/sell(?:\s+(\S+))?/, async (msg, match) => {
    const mint = match[1];
    if (!mint) {
      bot.sendMessage(msg.chat.id, 'Usage: /sell <mint> — force-sells the full remaining position for that mint. /positions to see what\'s open.');
      return;
    }
    const result = await positions.attemptManualSell(mint);
    bot.sendMessage(msg.chat.id, result.ok ? `✅ Sold $${result.symbol}` : `❌ ${result.reason}`);
  });

  onText(/^\/pause/, (msg) => {
    positions.pause();
    bot.sendMessage(msg.chat.id, '⏸️ Auto-buy paused (persisted — survives a restart). Detection/alerts keep running. /resume to re-enable.');
  });

  onText(/^\/resume/, (msg) => {
    const wasPaused = positions.isPaused();
    positions.resume();
    bot.sendMessage(msg.chat.id, wasPaused ? '▶️ Auto-buy resumed.' : 'Auto-buy was not paused.');
  });

  onText(/^\/resetsession(?:\s+(\S+))?/, (msg, match) => {
    const currentBalance = executor.getBalanceSol();
    const confirmArg = match[1];
    const expectedConfirm = currentBalance.toFixed(4);
    if (confirmArg !== expectedConfirm) {
      bot.sendMessage(msg.chat.id,
        `⚠️ This resets the paper balance to ${config.paperStartingBalanceSol} SOL and zeroes the /pnl window (trade history is kept — "/pnl all" still shows everything).\n` +
        `Current paper balance: ${currentBalance.toFixed(4)} SOL.\n\n` +
        `To confirm, send: /resetsession ${expectedConfirm}`);
      return;
    }
    positions.resetSession();
    bot.sendMessage(msg.chat.id, `🔄 Paper balance reset to ${config.paperStartingBalanceSol} SOL (was ${currentBalance.toFixed(4)}). /pnl history is untouched.`);
  });

  onText(/^\/positions/, async (msg) => {
    const open = positions.getOpenPositions();
    if (!open.length) {
      bot.sendMessage(msg.chat.id, `Auto-buy: ${positions.isPaused() ? '🔴 paused' : '🟢 active'}\n\nNo open positions.`);
      return;
    }
    const lines = [`Auto-buy: ${positions.isPaused() ? '🔴 paused' : '🟢 active'}`, ''];
    for (const p of open) {
      const priceInfo = await dexscreener.getTokenPriceUsd(p.mint).catch(() => null);
      const changePct = priceInfo ? ((priceInfo.priceUsd - p.entry_price_usd) / p.entry_price_usd) * 100 : null;
      const changeLabel = changePct === null ? 'checking...' : `${changePct >= 0 ? '+' : ''}${changePct.toFixed(0)}%`;
      lines.push(
        `$${p.symbol} — ${changeLabel} (peak +${p.peak_change_pct.toFixed(0)}%) — ${p.remaining_amount_sol.toFixed(4)}/${p.original_amount_sol.toFixed(4)} SOL, held ${fmtAge(Date.now() - p.opened_at)}`,
        `  Chart: https://dexscreener.com/solana/${p.mint}`,
      );
    }
    bot.sendMessage(msg.chat.id, lines.join('\n'));
  });

  onText(/^\/check\s+(\S+)(?:\s+(\S+))?/, async (msg, match) => {
    const mint = match[1];
    const term = match[2] || null;
    bot.sendMessage(msg.chat.id, `⏳ Checking ${mint.slice(0, 8)}...`);

    const [priceInfo, rugcheckReport, birdeyeOverview] = await Promise.all([
      dexscreener.getTokenPriceUsd(mint).catch(() => null),
      rugcheck.getFullReport(mint).catch(() => null),
      birdeye.getTokenOverview(mint).catch(() => null),
    ]);

    const lines = [`🔍 ${mint}`, ''];
    lines.push(priceInfo
      ? `Price: $${priceInfo.priceUsd} — Liquidity: $${Math.round(priceInfo.liquidityUsd).toLocaleString()}`
      : 'Price: no live data found (DexScreener has no pair for this mint)');

    if (rugcheckReport) {
      lines.push(
        `RugCheck: rugged=${rugcheckReport.rugged} — top holder ${rugcheckReport.topHolderPct?.toFixed(1) ?? '?'}% — insider-network ${rugcheckReport.insiderNetworkPct?.toFixed(1) ?? '?'}%`,
      );
    }
    lines.push(`Birdeye holder count: ${birdeyeOverview?.holderCount ?? (config.birdeyeApiKey ? 'no data' : 'not configured')}`);
    lines.push(`Trending keyword match: ${coingecko.matchesTrending(term || mint)}`, `Boosted on DexScreener: ${dexscreener.isBoosted(mint)}`);

    if (term) {
      const redditSignal = reddit.getSignal(term, 60);
      const alertsSignal = googleAlerts.getSignal(term, 60);
      const telegramSignal = telegramUserClient.getSignal(term, 60);
      const noSignal = { mentionCount: 0, sampleText: null };
      const [youtubeSignal, twitterSignal, farcasterSignal] = await Promise.all([
        youtube.searchMentionCount(term).catch(() => noSignal),
        twitter.searchMentionCount(term, 60).catch(() => noSignal),
        farcaster.getSignal(term, 60).catch(() => noSignal),
      ]);
      const sources = [
        ['Reddit', redditSignal, config.redditClientId],
        ['Google Alerts', alertsSignal, config.googleAlertsRssUrls.length],
        ['Telegram groups', telegramSignal, telegramUserClient.getTrackedGroups().length],
        ['YouTube (last 24h)', youtubeSignal, config.youtubeApiKey],
        ['X/Twitter, unofficial (uses real daily budget)', twitterSignal, config.getxapiApiKey],
        ['Farcaster', farcasterSignal, config.neynarApiKey],
      ];
      lines.push('', `Mentions in last 60min for "${term}" (proves each source is actually returning data, not just connected):`);
      for (const [label, signal, configured] of sources) {
        lines.push(`  ${label}: ${signal.mentionCount}${configured ? '' : ' (not configured)'}`);
        if (signal.sampleText) lines.push(`    📝 "${signal.sampleText.slice(0, 150)}"`);
      }
    } else {
      lines.push('', 'Tip: /check <mint> <symbol> to also see raw mention counts from Reddit/Google Alerts/Telegram.');
    }

    lines.push('', `Chart: https://dexscreener.com/solana/${mint}`);
    bot.sendMessage(msg.chat.id, lines.join('\n'));
  });

  onText(/^\/pnl(?:\s+(\S+))?/, (msg, match) => {
    const showAll = match[1]?.toLowerCase() === 'all';
    const statsResetAt = showAll ? null : Number(db.getMeta('statsResetAt') || 0);
    const sells = db.prepare(
      statsResetAt
        ? "SELECT * FROM trades WHERE side = 'sell' AND realized_pnl_sol IS NOT NULL AND created_at > ? ORDER BY id"
        : "SELECT * FROM trades WHERE side = 'sell' AND realized_pnl_sol IS NOT NULL ORDER BY id",
    ).all(...(statsResetAt ? [statsResetAt] : []));

    const currentBalance = executor.getBalanceSol();

    if (!sells.length) {
      bot.sendMessage(msg.chat.id, [
        `Paper balance: ${currentBalance.toFixed(4)} SOL`,
        statsResetAt ? 'No closed trades since the last /resetsession. /pnl all for full history.' : 'No closed trades yet.',
      ].join('\n'));
      return;
    }

    const positionsClosed = groupSellsIntoPositions(sells);
    const totalPnl = sells.reduce((sum, t) => sum + t.realized_pnl_sol, 0);
    const wins = positionsClosed.filter((p) => positionPnl(p) > 0).length;

    const lines = [
      '💰 Profit/Loss Summary',
      statsResetAt ? `Since reset: ${new Date(statsResetAt).toLocaleString()} (/pnl all for full history)` : '',
      '',
      `Paper balance: ${currentBalance.toFixed(4)} SOL`,
      `Closed positions: ${positionsClosed.length} (${wins}W / ${positionsClosed.length - wins}L — ${((wins / positionsClosed.length) * 100).toFixed(0)}% win rate)`,
      `Total realized P&L: ${fmtSol(totalPnl)}`,
      '',
      'Last 10:',
    ].filter(Boolean);
    for (const p of positionsClosed.slice(-10).reverse()) {
      const pnl = positionPnl(p);
      const lastSell = p.sells[p.sells.length - 1];
      const fillsNote = p.sells.length > 1 ? ` (${p.sells.length} fills)` : '';
      lines.push(`  $${p.symbol} — ${fmtSol(pnl)} (${lastSell.reason || 'closed'})${fillsNote}`);
    }
    bot.sendMessage(msg.chat.id, lines.join('\n'));
  });

  bot.on('polling_error', (err) => logger.error('Telegram polling error', { error: err.message }));

  logger.info('Telegram bot started');
}

function sendAlert(text) {
  if (!bot || !config.telegramChatId) return;
  bot.sendMessage(config.telegramChatId, text).catch((e) => logger.warn('Telegram sendMessage failed', { error: e.message }));
}

module.exports = { start, sendAlert };
