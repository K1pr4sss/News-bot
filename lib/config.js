require('dotenv').config();
const path = require('path');

const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  port: Number(process.env.PORT || 3100),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite'),

  // --- Discovery / enrichment cadence (per spec) ---
  // Tightened from 2min after removing the per-token PumpPortal->GeckoTerminal
  // resolver (index.js's handlePumpPortalCreate, 2026-09-02) - that gave each
  // token its own ~30s-after-creation check but flooded GeckoTerminal's
  // shared rate-limited queue badly enough that almost nothing got evaluated
  // at all (14hrs of production data: 100% of rejections were pre-scoring
  // filter failures, zero ever reached scoring). This is the fix for the
  // coverage gap THAT removal opened up - getNewPools() is ONE batched call
  // regardless of how many tokens launched, so polling it every 20s instead
  // of every 2min costs ~3 calls/min (trivial against the ~30/min budget)
  // while getting close to the old per-token latency back, without the flood.
  discoveryPollIntervalMs: Number(process.env.DISCOVERY_POLL_INTERVAL_MS || 20 * 1000),
  // Deliberately SEPARATE from discoveryPollIntervalMs above, kept at the old
  // 2min value - a token sitting in GeckoTerminal's "new" window gets swept
  // up by every 20s discoveryTick poll, but a full re-evaluation costs a
  // fresh RugCheck + pumpfunApi + Birdeye call each time (see evaluator.js's
  // evaluateCandidate), not just the free GeckoTerminal batch call. Tying
  // this to the same tightened interval would trade the GeckoTerminal
  // overload just fixed for a Birdeye/RugCheck one instead - the ONLY thing
  // that needed to get faster was noticing a token exists, not re-scoring
  // one already seen moments ago.
  candidateReevaluateThrottleMs: Number(process.env.CANDIDATE_REEVALUATE_THROTTLE_MS || 2 * 60 * 1000),
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
  // How many pending candidates get a fresh GeckoTerminal lookup per tick.
  // Sized against the real budget, not guessed: GeckoTerminal's free tier is
  // ~30 req/min and geckoterminal.js spaces calls 2.1s apart, so ~28/min is
  // the ceiling for the WHOLE app. discoveryTick takes ~3/min and trendingTick
  // is negligible; exitTick now takes ZERO (it moved to DexScreener - see
  // index.js). That leaves roughly 25/min, and this tick runs every 90s, so 25
  // per batch stays comfortably inside budget while still rotating through a
  // deep queue. Unbounded, this loop scheduled ~160s of work every 90s at the
  // observed queue depth and could never drain - see pendingCandidatesTick.
  pendingRecheckBatchSize: Number(process.env.PENDING_RECHECK_BATCH_SIZE || 25),
  trendingPollIntervalMs: Number(process.env.TRENDING_POLL_INTERVAL_MS || 5 * 60 * 1000),
  redditPollIntervalMs: Number(process.env.REDDIT_POLL_INTERVAL_MS || 5 * 60 * 1000),
  exitPollIntervalMs: Number(process.env.EXIT_POLL_INTERVAL_MS || 10 * 1000),

  // --- Safety filters (spec Section 4) ---
  minLiquidityUsd: Number(process.env.MIN_LIQUIDITY_USD || 5000),
  maxTopHolderPct: Number(process.env.MAX_TOP_HOLDER_PCT || 15),
  maxInsiderNetworkPct: Number(process.env.MAX_INSIDER_NETWORK_PCT || 30), // proxy for spec's "dev wallet actively selling" - coordinated-wallet dumping via RugCheck's clustering data
  maxTokenAgeMinutes: Number(process.env.MAX_TOKEN_AGE_MINUTES || 0), // 0 = disabled, per spec's "optional"
  // The strongest predictor found in the 2026-09-05 review, and by a wide
  // margin the most surprising: the hype SCORE predicted essentially nothing
  // (score 65+ entries had the WORST forward returns of any band - 12.1%
  // median max gain vs 14.0% for score 40-47, no monotonic relationship at
  // 15/60/240min horizons), while raw price momentum already visible at buy
  // time predicted a lot. Splitting the bot's own real entries by how far the
  // coin had already moved in the 15min before the buy:
  //     flat (<15% run-up)   n=34  hit +30% just  9%   real P&L -0.143 SOL
  //     mild (15-50%)        n=11  hit +30%      45%   real P&L -0.001 SOL
  //     hot (50-150%)        n=10  hit +30%      60%   real P&L +0.032 SOL
  //     parabolic (>150%)    n= 9  hit +30%      67%   real P&L +0.059 SOL
  // Flat entries lost -0.195 SOL; already-moving entries made +0.078 SOL even
  // while the broken exit ladder was still in play. Buying breakouts beat
  // buying dips too (entries at/above the 15min high: +4.7% median 60min
  // outcome; entries below it: -9.8%).
  //
  // GeckoTerminal's pool payload has carried price_change_percentage.h1/.m5
  // this whole time - parsePool already extracted them and NOTHING read them.
  // This is that gate. Gated backtest: 44% win rate and 4.5% ROI vs 26% and
  // 1.2% ungated (fewer trades, much better ones), plus an upside the replay
  // structurally cannot measure - it can only replay coins the bot actually
  // bought, so it can't show the better coins that a freed-up open-position
  // slot would have caught instead.
  //
  // HONEST CAVEAT, do not treat this as settled: the winning bucket is n=16.
  // Five days of data, and many gate/exit combinations were compared before
  // this one was picked, so some of that edge is selection. The DIRECTION is
  // consistent across every variant tested; the exact 50 is not sacred.
  // Set to 0 to disable the gate entirely.
  minPriceMomentumH1Pct: Number(process.env.MIN_PRICE_MOMENTUM_H1_PCT || 50),

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
  // The score/volume "bearish ladder" that used to live here is GONE, and the
  // bearishExitGraceSeconds band-aid with it. Full post-mortem, from replaying
  // all 125 real positions against real GeckoTerminal minute OHLCV (2026-09-05):
  //
  //   - 112 of 125 positions (90%) died on that ladder, costing -0.443 SOL of
  //     the account's -0.268 SOL total. Only 5 positions ever reached a
  //     take-profit tier.
  //   - It was never a hype-death SIGNAL, it was a TIMER: 92% of score-exits
  //     fired within 30s of the grace period expiring (median 8.4s), i.e. on
  //     the first or second exit tick that was allowed to act.
  //   - Median score drop entry->exit was 33 points (48 -> 22). That is not
  //     hype dying inside 90 seconds on every single coin; it is the entry
  //     score being inflated by transient components (volume-spike is worth
  //     25 pts and is BY DEFINITION the one-off burst that triggered the buy)
  //     plus two real re-score bugs (see evaluator.js's getLiveTokenAndScore).
  //   - Entry threshold and exit threshold were the SAME number (40), so every
  //     position entered a median of 8 points above its own kill line.
  //
  // The ladder's INTENT - stop paying to find out on a position whose thesis
  // isn't working - is sound and is kept below. What changed is that it's now
  // grounded in PRICE rather than in a score that decays by construction. The
  // decisive difference is the "and it's actually losing" precondition: under
  // the old rule a position sitting at +25% still got killed by score decay.
  // Replayed over the same 108 positions that have real price history:
  //     old score ladder      -0.188 SOL, 14% win, 322 trade legs
  //     this price-based cut  +0.089 SOL, 26% win, 245 trade legs
  // Selling once here instead of the old 70%-then-30% two-step is worth a
  // further ~0.11 SOL on its own - see the friction note on paperFeeSol.
  thesisCutAfterMinutes: Number(process.env.THESIS_CUT_AFTER_MINUTES || 10),
  thesisCutBelowPct: Number(process.env.THESIS_CUT_BELOW_PCT || 0),
  // Deliberately NOT added: a trailing stop. It was the obvious next idea and
  // peak_change_pct was already being tracked for it, but it tested WORSE in
  // every pairing (+0.089 -> +0.049 ungated; no meaningful gain gated) - these
  // tokens retrace violently enough that a trail exits runners that then
  // recover. The fixed take-profit ladder below beat it. Don't re-add it
  // without new data that actually contradicts this.
  takeProfitTier1Pct: Number(process.env.TAKE_PROFIT_TIER1_PCT || 30),
  takeProfitTier2Pct: Number(process.env.TAKE_PROFIT_TIER2_PCT || 60),
  takeProfitTier3Pct: Number(process.env.TAKE_PROFIT_TIER3_PCT || 100),
  takeProfitTier1SellFraction: Number(process.env.TAKE_PROFIT_TIER1_SELL_FRACTION || 0.5),
  takeProfitTier2SellFraction: Number(process.env.TAKE_PROFIT_TIER2_SELL_FRACTION || 0.3),
  takeProfitTier3SellFraction: Number(process.env.TAKE_PROFIT_TIER3_SELL_FRACTION || 0.2),

  // --- Cooldown / anti-spam (spec Section 10) ---
  // Was 24h per the original spec - user asked to remove this after seeing
  // real alerts blocked by it (e.g. a coin re-scoring 65/100 got skipped
  // purely because it had been bought once already that day, per a real
  // "bought within the last 24h (re-buy cooldown)" alert). Set to 0
  // (disabled) rather than shortened - every OTHER gate still applies in
  // full on a re-entry (real mention required, score/volume/filters,
  // hasOpenPosition, max open positions), so a re-buy only happens if the
  // coin independently re-qualifies on its own current merits, not because
  // time alone passed. wasRecentlyBought's cutoff math (Date.now() - 0)
  // naturally degrades to "never blocks" at 0, no separate code path needed.
  rebuyCooldownHours: Number(process.env.REBUY_COOLDOWN_HOURS || 0),
  // The blanket cooldown above being off surfaced a real, narrower problem:
  // real trade data (2026-09-03) showed "Pumpooor" bought and re-bought 9
  // times in one hour, scoring 45-56 each time (just above the 40 floor),
  // losing a little almost every round trip to fees/slippage - net -0.011
  // SOL on one mediocre coin alone. Not a reason to bring the blanket
  // cooldown back (that blocked genuinely strong re-scores too, which is
  // what got it removed) - this targets specifically what went wrong: don't
  // let a mint that JUST lost money get immediately re-bought while whatever
  // made it lose is presumably still true. A coin that closed for a REAL
  // profit isn't covered by this at all - only losing exits start the timer.
  lossRebuyCooldownMinutes: Number(process.env.LOSS_REBUY_COOLDOWN_MINUTES || 20),
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
  //
  // FRICTION IS THE QUIET KILLER HERE, worth stating in numbers because it is
  // invisible in any per-trade view (2026-09-05 review of 125 real positions):
  //     deployed        8.60 SOL across 125 positions (avg 0.069 SOL each)
  //     flat fees       0.373 SOL   <- 373 legs at 0.001, the dominant cost
  //     slippage        0.172 SOL   <- 1% per leg
  //     TOTAL           0.545 SOL = 6.34% of all capital deployed
  //     gross P&L before friction: +0.277 SOL
  // The entry signal had genuine positive gross edge and friction ate all of
  // it and then some. At a 126-second median hold, every trade had to clear
  // ~6.3% just to break even. This is why the exit rework optimises for FEWER
  // LEGS as much as for better decisions, and why "more trades" is not
  // automatically better for this bot - each round trip costs real money even
  // when it's right. Any future change that increases trade or leg count has
  // to earn more than ~6% per trade to pay for itself.
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
  // User's explicit call: "hadesalphacalls" is a trusted, higher-quality
  // source and its mentions should count for more than an ordinary tracked
  // group's - one real call from there should carry more weight toward
  // both the score and the real-mention gate than a single generic mention.
  // Map of group name (case-insensitive, matched the same way trackedGroups
  // above is) -> weight multiplier; anything not listed defaults to 1x.
  // Comma-separated "group:weight" pairs so more can be added later without
  // a code change, e.g. TELEGRAM_GROUP_WEIGHTS=hadesalphacalls:3,othergroup:2
  telegramGroupWeights: Object.fromEntries(
    (process.env.TELEGRAM_GROUP_WEIGHTS || 'hadesalphacalls:3')
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [name, weight] = pair.split(':');
        return [name.trim().toLowerCase(), Number(weight) || 1];
      }),
  ),

  trendingKeywords: [
    'DOGE', 'PEPE', 'BONK', 'WOJAK', 'POPCAT', 'MEW', 'BRETT', 'TRUMP',
    'ELON', 'MUSK', 'CAT', 'FROG', 'MOON', 'AI', 'WIF', 'GOAT',
  ],
};

module.exports = config;
