require('dotenv').config();
const fs = require('fs');
const path = require('path');

function loadWalletList() {
  const file = path.join(__dirname, '..', 'wallets.json');
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.insiderWallets) ? parsed.insiderWallets : [];
  } catch {
    return [];
  }
}

const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  port: Number(process.env.PORT || 3100),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite'),

  // --- Discovery / enrichment cadence (per spec) ---
  discoveryPollIntervalMs: Number(process.env.DISCOVERY_POLL_INTERVAL_MS || 2 * 60 * 1000),
  trendingPollIntervalMs: Number(process.env.TRENDING_POLL_INTERVAL_MS || 5 * 60 * 1000),
  redditPollIntervalMs: Number(process.env.REDDIT_POLL_INTERVAL_MS || 5 * 60 * 1000),
  walletPollIntervalMs: Number(process.env.WALLET_POLL_INTERVAL_MS || 60 * 1000),
  exitPollIntervalMs: Number(process.env.EXIT_POLL_INTERVAL_MS || 10 * 1000),

  // --- Safety filters (spec Section 4) ---
  minLiquidityUsd: Number(process.env.MIN_LIQUIDITY_USD || 5000),
  maxTopHolderPct: Number(process.env.MAX_TOP_HOLDER_PCT || 15),
  maxInsiderNetworkPct: Number(process.env.MAX_INSIDER_NETWORK_PCT || 30), // proxy for spec's "dev wallet actively selling" - coordinated-wallet dumping via RugCheck's clustering data
  requireSocials: process.env.REQUIRE_SOCIALS !== 'false',
  maxTokenAgeMinutes: Number(process.env.MAX_TOKEN_AGE_MINUTES || 0), // 0 = disabled, per spec's "optional"

  // --- Scoring (spec Section 5) ---
  scoreAlertThreshold: Number(process.env.SCORE_ALERT_THRESHOLD || 40),
  socialMentionWindowMinutes: Number(process.env.SOCIAL_MENTION_WINDOW_MINUTES || 5),
  volumeSpikeMultiplierHigh: Number(process.env.VOLUME_SPIKE_MULTIPLIER_HIGH || 2),
  volumeSpikeMultiplierMax: Number(process.env.VOLUME_SPIKE_MULTIPLIER_MAX || 5),

  // --- Entry logic (spec Section 8) ---
  entryVolumeSpikeMultiplier: Number(process.env.ENTRY_VOLUME_SPIKE_MULTIPLIER || 2),

  // --- Sizing (spec Section 6) ---
  sizeTier1Pct: Number(process.env.SIZE_TIER1_PCT || 0.05), // score 40-55
  sizeTier2Pct: Number(process.env.SIZE_TIER2_PCT || 0.10), // score 55-70
  sizeTier3Pct: Number(process.env.SIZE_TIER3_PCT || 0.15), // score 70+
  maxTradePct: Number(process.env.MAX_TRADE_PCT || 0.15),
  holdMinutesTier1: Number(process.env.HOLD_MINUTES_TIER1 || 120),
  holdMinutesTier2: Number(process.env.HOLD_MINUTES_TIER2 || 240),
  holdMinutesTier3: Number(process.env.HOLD_MINUTES_TIER3 || 720), // "until hype drops" - generous ceiling, not unbounded

  // --- Exit logic (spec Section 9) ---
  stopLossPct: Number(process.env.STOP_LOSS_PCT || -20),
  scoreExitThreshold: Number(process.env.SCORE_EXIT_THRESHOLD || 40),
  volumeExitMultiplier: Number(process.env.VOLUME_EXIT_MULTIPLIER || 1.5),
  takeProfitTier1Pct: Number(process.env.TAKE_PROFIT_TIER1_PCT || 30),
  takeProfitTier2Pct: Number(process.env.TAKE_PROFIT_TIER2_PCT || 60),
  takeProfitTier3Pct: Number(process.env.TAKE_PROFIT_TIER3_PCT || 100),
  takeProfitTier1SellFraction: Number(process.env.TAKE_PROFIT_TIER1_SELL_FRACTION || 0.5),
  takeProfitTier2SellFraction: Number(process.env.TAKE_PROFIT_TIER2_SELL_FRACTION || 0.3),
  takeProfitTier3SellFraction: Number(process.env.TAKE_PROFIT_TIER3_SELL_FRACTION || 0.2),
  insiderSellExitFraction: Number(process.env.INSIDER_SELL_EXIT_FRACTION || 0.5),

  // --- Cooldown / anti-spam (spec Section 10) ---
  rebuyCooldownHours: Number(process.env.REBUY_COOLDOWN_HOURS || 24),
  minMentionCount: Number(process.env.MIN_MENTION_COUNT || 0), // see config.js header note + plan doc: 0 (soft/off) until Twitter/Telegram exist; Reddit alone won't hit the spec's literal 1000
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS || 5),

  // --- Paper trading ---
  paperTrading: process.env.PAPER_TRADING !== 'false', // defaults true - see plan doc, this stays true until the user explicitly funds a real wallet
  paperStartingBalanceSol: Number(process.env.PAPER_STARTING_BALANCE_SOL || 1.0),
  paperSlippagePct: Number(process.env.PAPER_SLIPPAGE_PCT || 1),

  // --- Insider wallet tracking (spec Section 7) ---
  insiderWallets: loadWalletList(),
  insiderMinBuySol: Number(process.env.INSIDER_MIN_BUY_SOL || 0.5),
  insiderWindowMinutes: Number(process.env.INSIDER_WINDOW_MINUTES || 10),
  solscanApiKey: process.env.SOLSCAN_API_KEY || '', // free signup at pro-api.solscan.io - a data API, not the banned RPC-node-provider category

  // Birdeye (spec's "Insider / On-Chain" table) - optional, degrades to null
  // (not a blocked filter) without a key. Sign up at birdeye.so/dashboard.
  birdeyeApiKey: process.env.BIRDEYE_API_KEY || '',
  // Distinct from maxTopHolderPct (RugCheck, one wallet's % of supply) - a
  // token can pass that check with a clean top-holder% while still having
  // almost no real distribution (e.g. 6 wallets total). Only enforced when
  // Birdeye data is actually available.
  minHolderCount: Number(process.env.MIN_HOLDER_COUNT || 10),

  // --- Reddit (free OAuth "script" app - create at reddit.com/prefs/apps) ---
  redditClientId: process.env.REDDIT_CLIENT_ID || '',
  redditClientSecret: process.env.REDDIT_CLIENT_SECRET || '',
  redditUserAgent: process.env.REDDIT_USER_AGENT || 'solana-hype-bot/1.0',
  redditSubreddits: (process.env.REDDIT_SUBREDDITS || 'solana,SolanaMemeCoins,CryptoMoonShots,SolanaNFTs').split(','),

  // Google Alerts, delivered as RSS (see lib/googleAlerts.js) - no API key,
  // but the feed URL(s) have to be created manually since there's no API to
  // create an alert programmatically. Comma-separated if using more than one.
  googleAlertsRssUrls: (process.env.GOOGLE_ALERTS_RSS_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Telegram alpha-group scanning via the user's own account (MTProto/GramJS,
  // see lib/telegramUserClient.js). api_id/api_hash from my.telegram.org
  // (free, tied to a personal Telegram account); TELEGRAM_USER_SESSION comes
  // from the one-time interactive login in scripts/telegramLogin.js.
  telegramApiId: Number(process.env.TELEGRAM_API_ID || 0) || null,
  telegramApiHash: process.env.TELEGRAM_API_HASH || '',
  telegramUserSession: process.env.TELEGRAM_USER_SESSION || '',
  // Group titles/usernames (or chat IDs) to actually score messages from -
  // the account can be a member of other chats without them feeding the
  // pipeline. Managed live via the bot's /addgroup /removegroup /groups.
  telegramTrackedGroups: (process.env.TELEGRAM_TRACKED_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean),

  trendingKeywords: [
    'DOGE', 'PEPE', 'BONK', 'WOJAK', 'POPCAT', 'MEW', 'BRETT', 'TRUMP',
    'ELON', 'MUSK', 'CAT', 'FROG', 'MOON', 'AI', 'WIF', 'GOAT',
  ],
};

module.exports = config;
