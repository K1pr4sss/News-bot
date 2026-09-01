require('dotenv').config();
const path = require('path');

const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  port: Number(process.env.PORT || 3100),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite'),

  // --- Discovery / enrichment cadence (per spec) ---
  discoveryPollIntervalMs: Number(process.env.DISCOVERY_POLL_INTERVAL_MS || 2 * 60 * 1000),
  // Real live data (2026-08-31): every rejected candidate was failing on
  // liquidity/top-holder% simultaneously - structurally guaranteed for a
  // pump.fun token seconds old (near-zero liquidity, creator holds ~100%
  // until real buyers show up). GeckoTerminal's new_pools list is a short
  // sliding window that a specific token ages off within minutes given how
  // many new pump.fun tokens launch per minute, so without an explicit
  // retry mechanism a young token gets checked once while structurally
  // unable to pass, then never looked at again once it's had time to
  // mature. Same root cause and fix as the old sniper bot's "aged_out"
  // rejection-reason bug. See pendingCandidatesTick in evaluator.js.
  pendingCandidateRecheckIntervalMs: Number(process.env.PENDING_CANDIDATE_RECHECK_INTERVAL_MS || 90 * 1000),
  pendingCandidateMaxAgeMinutes: Number(process.env.PENDING_CANDIDATE_MAX_AGE_MINUTES || 60),
  trendingPollIntervalMs: Number(process.env.TRENDING_POLL_INTERVAL_MS || 5 * 60 * 1000),
  redditPollIntervalMs: Number(process.env.REDDIT_POLL_INTERVAL_MS || 5 * 60 * 1000),
  exitPollIntervalMs: Number(process.env.EXIT_POLL_INTERVAL_MS || 10 * 1000),

  // --- Safety filters (spec Section 4) ---
  minLiquidityUsd: Number(process.env.MIN_LIQUIDITY_USD || 5000),
  maxTopHolderPct: Number(process.env.MAX_TOP_HOLDER_PCT || 15),
  maxInsiderNetworkPct: Number(process.env.MAX_INSIDER_NETWORK_PCT || 30), // proxy for spec's "dev wallet actively selling" - coordinated-wallet dumping via RugCheck's clustering data
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
  // Real pattern found in live trade data (2026-09-01): 10 of 12 closed
  // trades lost small amounts, 100% via the bearish score/volume ladder,
  // most held only 19-35 SECONDS. Root cause - a near-threshold entry
  // (score 43-45, just above the 40 cutoff) typically earns most of its
  // score from the volume-spike category, which is inherently a one-off
  // burst - literally the same spike that triggered the buy. By the very
  // next exit-tick poll (10s later), that burst has already faded, the
  // re-scored value crosses back under the exit threshold, and the
  // position dies before price has any real chance to move. This grace
  // period gates ONLY the bearish score/volume ladder (never stop-loss,
  // take-profit, or max-hold - those stay immediate, this isn't about
  // loosening real risk protection) so a genuine entry gets time to prove
  // itself instead of being killed by the exact signal that bought it.
  // Same fix shape as the old sniper bot's stopLossGraceSeconds, different
  // underlying bug (that one was stale reads, this is score-decay timing).
  bearishExitGraceSeconds: Number(process.env.BEARISH_EXIT_GRACE_SECONDS || 90),
  takeProfitTier1Pct: Number(process.env.TAKE_PROFIT_TIER1_PCT || 30),
  takeProfitTier2Pct: Number(process.env.TAKE_PROFIT_TIER2_PCT || 60),
  takeProfitTier3Pct: Number(process.env.TAKE_PROFIT_TIER3_PCT || 100),
  takeProfitTier1SellFraction: Number(process.env.TAKE_PROFIT_TIER1_SELL_FRACTION || 0.5),
  takeProfitTier2SellFraction: Number(process.env.TAKE_PROFIT_TIER2_SELL_FRACTION || 0.3),
  takeProfitTier3SellFraction: Number(process.env.TAKE_PROFIT_TIER3_SELL_FRACTION || 0.2),

  // --- Cooldown / anti-spam (spec Section 10) ---
  rebuyCooldownHours: Number(process.env.REBUY_COOLDOWN_HOURS || 24),
  // Hard floor, enforced in evaluator.js on top of the score/volume/filter
  // gates - a candidate can otherwise clear the score threshold purely off
  // volume-spike + trending-presence + socials-bonus points, with zero real
  // evidence anyone is actually talking about it. That's the same "cosmetic
  // signals, zero real conviction" failure mode the old sniper bot hit and
  // fixed (see project_solana_sniper_bot memory - hasStrongSignal). This bot
  // is explicitly a HYPE detector - user's own words: "coin has to be hyped
  // cant just see liquidity." Was 0 (soft/off) while only Reddit existed as
  // a mention source (never built) - now that Google Alerts/Telegram/YouTube
  // are live, 1 is a real floor: at least one actual mention from a real
  // source, not zero. Not the spec's literal 1000 - that only makes sense at
  // Twitter-firehose volume, which this bot doesn't have.
  minMentionCount: Number(process.env.MIN_MENTION_COUNT || 1),
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS || 5),

  // --- Paper trading ---
  paperTrading: process.env.PAPER_TRADING !== 'false', // defaults true - see plan doc, this stays true until the user explicitly funds a real wallet
  paperStartingBalanceSol: Number(process.env.PAPER_STARTING_BALANCE_SOL || 1.0),
  paperSlippagePct: Number(process.env.PAPER_SLIPPAGE_PCT || 1),
  // Flat network+priority fee simulated per trade leg, on top of slippage -
  // real Solana transactions cost real SOL regardless of trade size (the old
  // sniper bot's own tuned values were 0.002-0.0025 SOL for priority fees
  // alone on top of the base network fee); paper trading was previously
  // free to execute, which made every result look slightly better than a
  // real trade would.
  paperFeeSol: Number(process.env.PAPER_FEE_SOL || 0.001),

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

  // YouTube Data API v3 (free key via console.cloud.google.com, no billing
  // needed for the default quota tier) - free daily quota is small (the
  // exact per-call cost wasn't confirmed live before shipping, docs gave
  // conflicting numbers), so this polls ONE fixed broad query on an interval
  // and caches results rather than searching per-candidate - watch actual
  // usage in Cloud Console and adjust the interval if it's cutting it close.
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  // Real free quota is 100 search.list calls/day - kept comfortably under
  // that (not exactly at it) so a burst of promising candidates in one day
  // can't accidentally exceed the real Google Cloud limit.
  youtubeDailyCallBudget: Number(process.env.YOUTUBE_DAILY_CALL_BUDGET || 80),

  // GetXAPI - a PAID, UNOFFICIAL third-party X/Twitter reseller (their own
  // docs say it "bypasses the need for Twitter's approval process" - not an
  // authorized data source). Live-tested 2026-09-01 with real obscure/hours-
  // old pump.fun tickers before shipping - genuinely returns real, current
  // results, not just noise on major coins. Real risk, not hypothetical: X
  // has a track record of shutting this whole category down with no notice
  // (killed all third-party clients in 2023, another crackdown on cheap
  // resellers in 2025) - kept fully optional and degrades to 0 like every
  // other source if the key is unset or credits run out, never a hard
  // dependency. Pre-paid credits, no card on file by default, so exhausting
  // the budget fails closed (0 contribution) rather than surprise-billing.
  getxapiApiKey: process.env.GETXAPI_API_KEY || '',
  // Real cost is ~$0.001/call (~20 tweets) - budget-capped the same way as
  // youtubeDailyCallBudget below (and for the same reason: only spend it on
  // candidates already looking promising, see evaluator.js, never on every
  // raw discovery candidate). Default kept low since it's real money, not a
  // free quota - $0.04/day even at the default cap.
  getxapiDailyCallBudget: Number(process.env.GETXAPI_DAILY_CALL_BUDGET || 40),

  // Farcaster via Neynar (dev.neynar.com) - genuinely free, official, no
  // ToS risk (unlike GetXAPI above), but a SEPARATE platform from X with a
  // much smaller crypto-native crowd - NOT a mirror of X, confirmed live
  // 2026-09-01 (a brand-new obscure pump.fun ticker had zero Farcaster
  // mentions, while an established term like "pump.fun" returned real,
  // current casts). Free tier's rate limit (300 req/min observed live on
  // the cast-search endpoint) comfortably covers this bot's polling volume,
  // so - unlike GetXAPI - no budget gating needed; included in both entry
  // scoring and exit re-scoring like Reddit/Google Alerts/Telegram.
  neynarApiKey: process.env.NEYNAR_API_KEY || '',

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
