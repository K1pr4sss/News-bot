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
  // Cut from 25 after observing sustained GeckoTerminal 429s in production -
  // repeated "getNewPools failed" while the pending queue kept churning, i.e.
  // speculative rechecks starving the discovery poll that feeds everything.
  //
  // My earlier budget arithmetic (3/min discovery + 0.6/min trending + 16.7/min
  // pending = ~20/min, under the ~28/min the 2.1s spacing allows) was too
  // optimistic: the real limit from Railway's IP is evidently lower than the
  // documented ~30/min. At 12 per 90s this tick costs ~8/min and total demand
  // is ~12/min, with real headroom instead of theoretical headroom.
  //
  // Cycle time for a full 150-deep queue goes from ~9min to ~19min, which is
  // an acceptable trade: a slower recheck still finds a maturing token, but a
  // starved discovery poll never sees it at all.
  pendingRecheckBatchSize: Number(process.env.PENDING_RECHECK_BATCH_SIZE || 12),
  // Hard cap on the retry queue - see evaluator.evictPendingOverflow. Sized so
  // the full queue still cycles fast enough to matter: 150 / 25 per tick x 90s
  // is a ~9 minute cycle, giving each candidate ~6 rechecks inside the 60min
  // max age. Left unbounded it trended toward ~1,000 (arrival rate x max age),
  // where each candidate would get about one look in its entire lifetime.
  pendingCandidateMaxSize: Number(process.env.PENDING_CANDIDATE_MAX_SIZE || 150),
  // How long rejected candidates stay queryable (see db.js's rejections
  // table). 72h at the observed ~12 candidates/min is ~50k rows, a few MB -
  // long enough to answer a "should I loosen this filter" question against a
  // couple of days of real candidates, short enough not to grow the volume
  // without bound.
  rejectionRetentionHours: Number(process.env.REJECTION_RETENTION_HOURS || 72),
  trendingPollIntervalMs: Number(process.env.TRENDING_POLL_INTERVAL_MS || 5 * 60 * 1000),
  // Which trending WINDOWS to poll. The bot only ever polled GeckoTerminal's
  // default (24h), which live sampling showed to be nine-day-old coins with
  // zero live momentum - useless for a bot whose own data says it makes money
  // on things already moving. '5m' and '1h' are where coins running RIGHT NOW
  // appear; '24h' is kept because a genuinely big mover stays on it and it
  // costs one batched call. Empty string disables the extra windows.
  trendingDurations: (process.env.TRENDING_DURATIONS || '5m,1h,24h')
    .split(',').map((s) => s.trim()).filter(Boolean),
  redditPollIntervalMs: Number(process.env.REDDIT_POLL_INTERVAL_MS || 5 * 60 * 1000),
  // Halved from 10s. Real stop-loss fills average -28.2% against a -20% rule,
  // a 9.3 percentage-point overshoot, and part of that is simply the window
  // between checks - these tokens can travel 20%+ inside ten seconds.
  //
  // This only became cheap after exitTick stopped calling GeckoTerminal (see
  // index.js): the exit path is now one DexScreener call per open position, off
  // the rate-limited queue entirely, and with maxOpenPositions at 3 this is ~36
  // requests/min against DexScreener's ~300/min allowance.
  //
  // Honest caveat: unlike the breakeven stop and the sizing change, this one is
  // NOT validated against data - minute candles cannot resolve sub-minute fill
  // timing, so the backtest is blind to it. Shipped because it is cheap,
  // low-risk and directionally obvious, not because it was measured.
  exitPollIntervalMs: Number(process.env.EXIT_POLL_INTERVAL_MS || 5 * 1000),

  // --- Safety filters (spec Section 4) ---
  minLiquidityUsd: Number(process.env.MIN_LIQUIDITY_USD || 5000),
  // KEEP AT 15. Tested for removal on 2026-09-07 and the removal was wrong.
  //
  // The case for relaxing it was strong on paper: the MemeTrans ablation over
  // 41,470 migrated launches ranks holding concentration LAST among feature
  // families (-0.004 AUPRC removed alone, against -0.036 for market activity),
  // and 2,353 coins a day sit inside the new momentum band blocked by nothing
  // but this gate. Forward prices for 200 of them:
  //
  //     population                    n     EV    win   died
  //     band, passes this gate       49   +2.8%   22%   22%
  //     band, BLOCKED by this gate   33   +6.8%   42%   18%
  //
  // The blocked coins look better on every headline number. They are an
  // artifact. Median 1h volume among them is $716 against $21,447 for the ones
  // the gate admits - roughly 30x thinner - and the newly-admitted WINNERS are
  // thinner still than their own losers ($716 vs $2,557). The +40% prints are
  // happening on the deadest pools, which is precisely the liquidity-pool price
  // inflation signature: the median manipulation buy in that literature is $54,
  // and a print like that cannot be sold into.
  //
  // Apply any volume floor and the edge disappears, while the population this
  // gate already admits survives the same floor:
  //     newly admitted, any volume     n=33  +6.8%   train  +0.3 / test +12.8  agree
  //     newly admitted, vol >= $2k/h   n=14  +1.3%   train -17.1 / test +19.8  NO
  //     newly admitted, vol >= $10k/h  n= 9  -0.6%   train -15.9 / test +11.7  NO
  //     already admitted, vol >= $10k  n=32  +3.7%   train  +7.2 / test  +0.1  agree
  //
  // So this gate is doing real work, just not the work it was written for - it
  // is an accidental liquidity and quality proxy. The general lesson: any
  // future "widen the universe" change must be checked against a volume floor
  // first, because headline EV on thin pools is untradeable price prints.
  maxTopHolderPct: Number(process.env.MAX_TOP_HOLDER_PCT || 15),
  maxInsiderNetworkPct: Number(process.env.MAX_INSIDER_NETWORK_PCT || 30), // proxy for spec's "dev wallet actively selling" - coordinated-wallet dumping via RugCheck's clustering data
  maxTokenAgeMinutes: Number(process.env.MAX_TOKEN_AGE_MINUTES || 0), // 0 = disabled, per spec's "optional"

  // MINIMUM pool age. The strongest signal in the whole dataset, and the first
  // one found by asking the bot's OWN entry readings rather than replaying
  // third-party candles: entry_metrics is captured at the instant of the buy,
  // so there is no pool-matching, no rate limit and no reconstruction error.
  // (It was unreachable until /positions learned to serve closed rows.)
  //
  // 37 closed positions with entry readings, realised return on capital:
  //     pool age      n    mean      win
  //       0-10 min    5   -13.1%     20%
  //      10-30 min    9   -29.7%     11%
  //      30-60 min   10   -24.9%     10%
  //      60-180min    2    -1.0%     50%
  //     180+   min   11    +2.1%     36%
  // As a floor rather than a bucket: >=45min keeps 14 trades at -1.2%, >=60min
  // keeps 13 at +1.6%, against a -15.2% baseline across all 37.
  //
  // What it removes is the tail. Of the 14 trades a 30-minute floor would have
  // skipped, 12 lost - including NVDA at -101.4%, the worst single trade the
  // bot has made, whose pool was 18 minutes old when it was bought and which
  // gapped from +7.6% to -99.7% in two candles. Only one skipped trade was a
  // real winner (PENNY, +49.3%).
  //
  // HONEST LIMIT: this is not "profitable in both halves". At a 60-minute floor
  // the earlier half is still -8.7% and only the later half is +8.1%, on 5 and
  // 8 trades. What survives out-of-sample is the DIRECTION (older is better,
  // consistently) and the mechanism (a pool that has already traded for an hour
  // has survived the window where launch rugs happen), not the profit. It is
  // also the conservative kind of wrong: the gate only ever removes trades, so
  // if it turns out to be noise the cost is fewer trades, not larger losses.
  //
  // 45 rather than 60 because the frequency cost compounds - a 60-minute floor
  // keeps roughly a third of entries - and 45 captures nearly the whole effect.
  minPoolAgeMinutes: Number(process.env.MIN_POOL_AGE_MINUTES || 45),

  // Hourly volume as a multiple of pool liquidity. Statistically the cleanest
  // of the consistent signals: split at the median (7.3x), the low half returns
  // -7.5% and the high half -22.1%, and unlike the age gate the two halves of
  // the sample AGREE on the level as well as the sign (-7% train / -8% test).
  //
  // Reads as a churn measure. A pool turning over its entire liquidity seven
  // times an hour is not being discovered, it is the same shallow float being
  // passed around - which is also why the other "hotness" readings all point
  // the same way: raw 1h volume (-15.1pp), buyers in the last hour (-10.5pp),
  // 5-minute price change (-11.3pp) and mention count (-6.1pp) each do WORSE in
  // their upper half, every one of them consistent across both halves.
  //
  // That cluster is the session's real finding: every measure of "this coin is
  // hot right now" is negatively related to what happens next. Buying the top
  // of the excitement is the strategy, and it is the thing that loses.
  maxVolumeToLiquidityRatio: Number(process.env.MAX_VOLUME_TO_LIQUIDITY_RATIO || 8),
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
  // DROPPED from 50 to 1, and paired with a ceiling. This is the counterfactual
  // result and it is the strongest replication of the session.
  //
  // The test: rejections rows with sole_reason='price' are coins that passed
  // EVERY other filter and were turned away only for momentum under 50%. That
  // is the exact population this gate creates, so racing them forward on the
  // same 120-minute window, the same +40/-35 rule and the same friction gives a
  // like-for-like comparison against what the bot actually bought.
  //
  //   h1 momentum      n    raceEV   died    train    test    agree
  //     < 0%          71     -2.7%    11%    +1.7%   -7.1%    NO
  //     0-15%         63     +5.4%    19%    +4.8%   +5.9%    YES
  //    15-30%         18     -6.6%    33%   -10.7%   -2.5%    yes (consistently losing)
  //    30-50%         21     -5.2%    29%    -9.6%   -1.2%    yes (consistently losing)
  //     50%+ (LIVE)  137     -5.9%    39%    -4.7%   -7.1%    yes (consistently losing)
  //
  // The gate the bot has been running is negative in BOTH halves. The 0-15%
  // band is positive in both, and the halves nearly agree on the level as well
  // as the sign (+4.8 / +5.9). Nothing else this session has replicated that
  // cleanly - five previous findings flipped sign on exactly this split.
  //
  // The death rate is the other half of it: 19% of the mild-momentum coins fall
  // below -80% within two hours, against 39% of the ones the bot buys. A coin
  // already up 50% in an hour is not an opportunity, it is the last buyer's
  // exit, and that is where the un-stoppable gaps live.
  //
  // Floor at 1 rather than 0 because the sub-zero bucket does NOT replicate
  // (+1.7 train, -7.1 test): a coin actively falling is a different animal from
  // a coin drifting up, and only the second one is supported by this data.
  minPriceMomentumH1Pct: Number(process.env.MIN_PRICE_MOMENTUM_H1_PCT || 1),

  // The ceiling is where the actual finding lives - see the table above. 15
  // rather than 25 because the 15-30% bucket is negative in both halves; the
  // wider band only looks good when a liquidity floor is bolted on, and that
  // combination has n=33 against n=63 here.
  //
  // HONEST LIMIT: +5.4% raw does not survive this account's friction. At the
  // 0.021 SOL position the balance currently supports, a round trip costs 11.5%
  // and the rule nets -6.1%; at 0.05 SOL it is -0.6%; at 0.10 SOL it is +1.4%.
  // The entry is fixable and now probably fixed. The account being too small to
  // pay for its own fees is a separate problem, and the answer to it is a
  // larger balance, never a larger fraction of a small one.
  maxPriceMomentumH1Pct: Number(process.env.MAX_PRICE_MOMENTUM_H1_PCT || 15),
  // Don't-chase guard. attemptEntry decides a candidate is worth buying using
  // the price attached at evaluation, then fetches a FRESH price to execute at
  // (correctly - see the stale-price fix). But nothing checked whether the
  // price had run away in between, and on this bot's candidates it routinely
  // has: measured across 13 real entries, fills averaged 5.7% ABOVE the market
  // bar's open on top of the 1% simulated slippage, 7 of 13 paid more than 2%
  // above, and 3 of 13 filled above the bar's HIGH entirely - a price that
  // never traded in that minute.
  //
  // On a bot whose total round-trip friction is already ~6%, paying another
  // 5.7% to get in is indefensible on its own terms, independently of whether
  // the strategy is profitable. It is also a chase-guard: if the price jumped
  // between deciding and executing, the move being bought has already happened.
  // Skipping costs one candidate; buying costs the spread every time.
  //
  // Note this bounds the price only in the UP direction - a candidate that got
  // cheaper since evaluation is not blocked, since that is the good case.
  maxEntryPriceDriftPct: Number(process.env.MAX_ENTRY_PRICE_DRIFT_PCT || 3),

  // --- Scoring (spec Section 5) ---
  scoreAlertThreshold: Number(process.env.SCORE_ALERT_THRESHOLD || 40),
  socialMentionWindowMinutes: Number(process.env.SOCIAL_MENTION_WINDOW_MINUTES || 5),
  volumeSpikeMultiplierHigh: Number(process.env.VOLUME_SPIKE_MULTIPLIER_HIGH || 2),
  volumeSpikeMultiplierMax: Number(process.env.VOLUME_SPIKE_MULTIPLIER_MAX || 5),

  // --- Entry logic (spec Section 8) ---
  entryVolumeSpikeMultiplier: Number(process.env.ENTRY_VOLUME_SPIKE_MULTIPLIER || 2),

  // --- Sizing (spec Section 6) ---
  // CUT BACK from 0.12. The 0.12 was mine and it was wrong, for a reason worth
  // recording because it is subtle: the friction argument below is CORRECT in
  // isolation and still silently assumed a positive edge. Position size does
  // not change the sign of an edge, it multiplies it. Against a negative one,
  // sizing up is not "reducing friction", it is losing faster.
  //
  // What the realised trades actually say, all 75 closed round trips, return
  // measured on capital deployed so sizes are comparable:
  //     mean -10.5% per trade, sd 22.6%, 95% CI [-15.6%, -5.4%]
  // That interval EXCLUDES ZERO. This is not a small sample being unlucky; at
  // n=75 the strategy is significantly unprofitable. Every earlier verdict
  // ("no edge", "the exits were mismatched") was argued from backtests. This
  // one is from what the bot did with its own money.
  //
  // And the loss side has a tail no stop can cut, because price gaps THROUGH
  // the stop inside a single minute. NVDA, 2026-09-06: +7.6% at t-1min, then
  // one bar from 9.9e-4 to 2.0e-5 and -99.7% the next - the "stop-loss" filled
  // at -99.7%, cost 0.0708 SOL (more than the position itself, once fees are
  // attributed) and was 64% of that whole era's losses in one trade. Across 45
  // trades with clean candles the price falls below -80% within two hours in
  // 38% of them.
  //
  // Bootstrapping the real return distribution over 400 compounding trades:
  //     size    median outcome    P(lose 90%+ of the account)
  //      2%       0.43x                    0%
  //      5%       0.12x                   22%
  //      8%       0.03x                  100%
  //     12%       0.005x                 100%   <- what it was running
  // 12% of THIS distribution is certain ruin. Even on a hypothetical +8% edge
  // the growth-optimal size is 6-12% and p10 falls below break-even past 12%,
  // so 12% was never the right answer in either world.
  //
  // 5% is chosen to survive long enough to answer the entry question, not to
  // maximise anything. A deliberate revert, not a new theory.
  sizeTier1Pct: Number(process.env.SIZE_TIER1_PCT || 0.05), // score 40-55
  // Lowered from 0.05 because at 5% sizing that floor halts the bot outright:
  // clearing it needs a 1.0 SOL balance and the balance is 0.46. The bot was
  // roughly three losing trades from freezing itself - a self-inflicted stop
  // that would have ended data collection rather than any actual risk.
  //
  // The friction the old floor defended against is real and has NOT gone away:
  // at 0.023 SOL (5% of the current balance) a round trip pays ~8.7% in flat
  // fees plus ~2% slippage. But that is a symptom of the paper BALANCE being
  // small, not of the size FRACTION being small, and the fix is a bigger
  // balance, not a bigger fraction of a small one. Sizing up to outrun a fixed
  // fee is exactly what produced the ruin arithmetic above.
  minPositionSol: Number(process.env.MIN_POSITION_SOL || 0.015),
  // FLATTENED to match tier 1. These tiers encode "bet more when the score is
  // higher", and the score does not earn that: across 45 trades with clean
  // forward candles, the higher-score band is the WORSE one, and consistently
  // so in both halves of the sample.
  //     score 0-45   n=15   died 27%   mean realised  -5.8%   (train -6% / test -6%)
  //     score 45-55  n=26   died 42%   mean realised -15.2%   (train -9% / test -19%)
  // Scaling size with an anti-predictive signal is a leveraged bet on being
  // wrong. Until the score is shown to rank outcomes in the right order, every
  // tier gets the same fraction.
  sizeTier2Pct: Number(process.env.SIZE_TIER2_PCT || 0.05), // score 55-70
  sizeTier3Pct: Number(process.env.SIZE_TIER3_PCT || 0.05), // score 70+
  maxTradePct: Number(process.env.MAX_TRADE_PCT || 0.05),
  holdMinutesTier1: Number(process.env.HOLD_MINUTES_TIER1 || 120),
  holdMinutesTier2: Number(process.env.HOLD_MINUTES_TIER2 || 240),
  holdMinutesTier3: Number(process.env.HOLD_MINUTES_TIER3 || 720), // "until hype drops" - generous ceiling, not unbounded

  // --- Exit logic (spec Section 9) ---
  // Widened from -20%, and this is the ONLY exit parameter in this file that
  // has survived out-of-sample testing (2026-09-06).
  //
  // Context for why that matters: ~30 exit configurations had been tuned
  // against the same 108 positions, and when finally split train/test
  // (earlier half vs later half) EVERY single-exit threshold was positive on
  // train and negative on test - the train-best was the test-worst. Those
  // backtests were measuring which half of the data was being looked at.
  //
  // Stop width is different. Racing target-vs-stop on real price paths, asking
  // only which is reached FIRST (pessimistically resolving each candle's low
  // before its high), the shape is nearly identical in both halves:
  //     stop    trainEV  testEV   trainWin  testWin
  //     -15%     -6.5     -5.8      30%       31%
  //     -20%     -2.7     -3.2      42%       41%   <- what this was
  //     -25%     -0.5     -0.5      50%       50%
  //     -30%     +4.8     +4.0      61%       60%
  //     -40%     +9.8    +15.2      72%       79%
  // Train and test agree at every level. That is a real effect rather than the
  // sign-flipping noise the take-profit thresholds showed.
  //
  // The mechanism is simple once seen: these tokens routinely travel 20-30%
  // on noise, so a -20% stop is inside the noise band and gets hit before the
  // move it was waiting for can develop. It also explains why TIGHTENING the
  // stop to -15% or -12% tested worse - that was moving further into the noise.
  //
  // -35% rather than -40% deliberately: real fills overshoot the level by ~9
  // percentage points (measured), so a -35% rule fills near -44%, which is
  // still inside the validated positive region. Setting -40% would fill near
  // -49% and leave it.
  //
  // COST, stated plainly: each individual loss is now ~75% larger. At 8%
  // sizing that is ~2.8% of balance per losing trade against ~1.6% before, and
  // with 3 concurrent positions ~8.4% of balance at risk. The expectancy is
  // better; the ride is rougher.
  stopLossPct: Number(process.env.STOP_LOSS_PCT || -35),
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
  // DISABLED (0). It was right for the population it was written against and
  // is wrong for the one the bot now buys, which is a clean illustration of why
  // an exit rule cannot be evaluated apart from the entry that feeds it.
  //
  // What it looked like live, the first 13 exits after the momentum band
  // shipped: ELEVEN were thesis cuts, zero stops, zero take-profits. Most fired
  // on positions that were essentially flat - -0.1%, -0.5%, -0.6%, -1.1%,
  // -1.4%, -1.6%, -1.6% - each one paying a full round trip of friction to
  // close a trade that had not yet done anything. The only position that
  // survived to its 120-minute cap returned +20%.
  //
  // Against the band's own forward paths, net of 4% friction:
  //     live rule (cut at 10min if <= 0%)     -3.7%   (train -2.6 / test -4.9)
  //     one-shot checkpoint at 10min          -3.1%   (train -2.6 / test -3.5)
  //     checkpoint at 30min                   -4.6%
  //     checkpoint at 60min                   -3.4%
  //     NO cut, 120min cap                    -2.0%   (train -0.6 / test -3.5)
  //     NO cut, 240min cap                    -2.0%
  // Removing it beats every checkpoint variant, and agrees across both halves.
  //
  // Why the reversal is coherent rather than embarrassing: the rule was tuned
  // when minPriceMomentumH1Pct was 50, so every position was a blow-off that
  // either ripped inside ten minutes or was already dead. Ten minutes of
  // nothing was real evidence there. The 1-15% band is the opposite by
  // construction - deeper pools, slower coins, 19% death rate instead of 39% -
  // and ten minutes of nothing is just ten minutes.
  //
  // Set to a positive number to re-enable. Do NOT re-enable without re-testing
  // against whatever entry population is live at the time.
  thesisCutAfterMinutes: Number(process.env.THESIS_CUT_AFTER_MINUTES || 0),
  thesisCutBelowPct: Number(process.env.THESIS_CUT_BELOW_PCT || 0),
  // Deliberately NOT added: a trailing stop. It was the obvious next idea and
  // peak_change_pct was already being tracked for it, but it tested WORSE in
  // every pairing (+0.089 -> +0.049 ungated; no meaningful gain gated) - these
  // tokens retrace violently enough that a trail exits runners that then
  // recover. The fixed take-profit ladder below beat it. Don't re-add it
  // without new data that actually contradicts this.
  // Once a take-profit tier has banked real gains, never let the remainder
  // turn into a loss. This closes the single worst hole in the payoff
  // arithmetic: the ladder sells only 50% at +30%, so a coin that WORKS and
  // then reverses nets about -1% of position, because the unsold half rides to
  // a stop that really fills at -28%. Two live examples: phantom took +48% then
  // stopped at -44.3% for a net loss; UMI took +30% and +62% then stopped at
  // -29%. Both were correct calls that paid nothing.
  //
  // Validated over the 108 real positions with price history, pessimistic
  // intrabar ordering: +0.0889 -> +0.1006 SOL and 26% -> 29% win rate. Note
  // this is the OPPOSITE of tightening the stop generally, which tested worse
  // (SL -15 gave +0.027, SL -12 gave +0.046) - the gain comes specifically from
  // protecting positions that have already proven themselves, not from cutting
  // everything sooner.
  breakevenAfterTakeProfit: process.env.BREAKEVEN_AFTER_TAKE_PROFIT !== 'false',
  // Slightly above entry rather than exactly at it, so the protected exit still
  // covers its own slippage instead of scratching. +5% and 0% tested within
  // 0.0002 SOL of each other, so this is not a tuned parameter.
  breakevenStopPct: Number(process.env.BREAKEVEN_STOP_PCT || 0),
  // The ladder is gone: every tier now closes the WHOLE position, so whichever
  // level is reached first is a single clean exit.
  //
  // Why, from a race test on real price paths with realistic friction modelled
  // (stop fills overshooting by the measured ~9pp, 1% slippage per leg, and the
  // FLAT fee per leg), split train/test:
  //     config      trainEV  testEV
  //     +30/-20      -2.9     -2.6    <- what this bot has been running
  //     +30/-35      +4.9     +1.5
  //     +40/-35      +7.5     +4.3    <- shipped
  //     +40/-40      +6.8     +5.2
  //     +50/-35      -2.9     -4.1
  //     +60/-40      -2.2     -4.2
  // Every config agrees in SIGN across both halves, and +40% is the peak at
  // every stop level while everything at +50% and above is negative in both.
  // That is a stable shape rather than a lucky cell - which matters, because
  // the previous take-profit study flipped sign out-of-sample and had to be
  // thrown away entirely.
  //
  // The counter-intuitive part is worth stating: "let winners run" is actively
  // WRONG on this data. Targets above +40% lose in both halves. Reaching +50%
  // is rare enough that waiting for it forfeits the far more common +40%.
  //
  // The old 30/60/100 ladder also left an unsold remainder that the breakeven
  // stop then gave back at -13%, -11% and even -99% on real overnight trades -
  // a 5s-polled market stop cannot fill at its level on gapping tokens. One
  // exit removes that exposure and saves a fee leg at the same time.
  takeProfitTier1Pct: Number(process.env.TAKE_PROFIT_TIER1_PCT || 40),
  takeProfitTier2Pct: Number(process.env.TAKE_PROFIT_TIER2_PCT || 60),
  takeProfitTier3Pct: Number(process.env.TAKE_PROFIT_TIER3_PCT || 100),
  takeProfitTier1SellFraction: Number(process.env.TAKE_PROFIT_TIER1_SELL_FRACTION || 1),
  takeProfitTier2SellFraction: Number(process.env.TAKE_PROFIT_TIER2_SELL_FRACTION || 1),
  takeProfitTier3SellFraction: Number(process.env.TAKE_PROFIT_TIER3_SELL_FRACTION || 1),

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
  // THE single most damaging pattern in the bot's entire history, found by
  // reviewing all 145 positions at once rather than a slice (2026-09-05).
  //
  // Outcome by how many times the SAME mint had already been bought:
  //     attempt 1   n=64  P&L -0.031  win 25%
  //     attempt 2   n=15  P&L -0.097  win  0%
  //     attempt 3   n= 9  P&L -0.043  win 11%
  //     attempt 4   n= 5  P&L -0.020  win  0%
  //     attempt 5   n= 5  P&L -0.026  win  0%
  //     attempt 6+  n=47  P&L -0.203  win  0%
  // 81 re-buys produced ONE winner between them. OTC was bought 20 times and
  // never won; fone 19 times, never won; Pumpooor 18 times, won once.
  //
  // Capping at one position per mint would have moved the account from -0.420
  // to -0.031 SOL - 93% of the entire loss - and lifted the win rate from 12%
  // to 25%, while cutting 419 trade legs to 183. That second number matters as
  // much as the first: total flat fees are 0.419 SOL against a total loss of
  // 0.420, so the fixed per-leg fee is not A cost here, it is essentially THE
  // cost, and re-buying the same coin is what generates the legs.
  //
  // lossRebuyCooldownMinutes (20min) was aimed at this and is far too weak -
  // 58 of the 81 re-buys happened within 60 minutes of the previous close. It
  // stays as a secondary guard; this is the real one.
  //
  // Set to 0 to disable. Raising it above 1 is not supported by the data.
  maxPositionsPerMintPerDay: Number(process.env.MAX_POSITIONS_PER_MINT_PER_DAY || 1),
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
  // Lowered from 5 to hold total exposure flat while sizeTier1Pct rises
  // (5 x 5% = 25% before, 3 x 8% = 24% now). Also shortens the exit tick's
  // per-cycle work, which is the thing standing between a stop being breached
  // and it actually firing.
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS || 3),

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
