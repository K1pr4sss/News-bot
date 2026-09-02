process.env.DB_PATH = ':memory:';
process.env.PAPER_STARTING_BALANCE_SOL = '1.0';

const test = require('node:test');
const assert = require('node:assert');
const rugcheck = require('../lib/rugcheck');
const pumpfunApi = require('../lib/pumpfunApi');
const birdeye = require('../lib/birdeye');
const coingecko = require('../lib/coingecko');
const dexscreener = require('../lib/dexscreener');
const reddit = require('../lib/reddit');
const googleAlerts = require('../lib/googleAlerts');
const telegramUserClient = require('../lib/telegramUserClient');
const geckoterminal = require('../lib/geckoterminal');
const positions = require('../lib/positions');
const evaluator = require('../lib/evaluator');
const db = require('../lib/db');
const telegramBot = require('../lib/telegramBot');

// Stub every external source evaluateCandidate touches - this test is about
// the real-mention gate specifically, not any one source's actual behavior.
const cleanRugcheck = {
  rugged: false, mintAuthorityActive: false, freezeAuthorityActive: false, topHolderPct: null, insiderNetworkPct: null,
};
rugcheck.getFullReport = async () => cleanRugcheck;
pumpfunApi.getSocials = async () => ({ count: 0 });
birdeye.getTokenOverview = async () => null;
coingecko.matchesTrending = () => true; // +10 trending pts, no mention needed
dexscreener.isBoosted = () => true; // +10 more trending pts (cap 20), no mention needed
// attemptEntry fetches a fresh price before buying (real bug fix - it used
// to trust the stale discovery-time token.priceUsd instead) - mocked at
// file scope, not per-test, so every test that reaches a real buy gets a
// consistent price regardless of node:test's execution order.
dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 1 });
reddit.getSignal = () => ({ mentionCount: 0 });
googleAlerts.getSignal = () => ({ mentionCount: 0 });
telegramUserClient.getSignal = () => ({ mentionCount: 0 });

function hypedLiquidToken(mint) {
  return {
    mint, name: 'Test', symbol: 'XYZ', priceUsd: 1, liquidityUsd: 50000,
    volumeH1Usd: 6000, volumeH24Usd: 0, // ratio 6000/1000 = 6x -> saturates volume score (25)
  };
}

function hasOpenPosition(mint) {
  return positions.getOpenPositions().some((p) => p.mint === mint);
}

test('a candidate clearing score/volume/filters purely on volume-spike + trending-presence is still rejected with zero real mentions (regression: minMentionCount existed in config but was never wired into the entry gate - a coin could get bought on pure on-chain price action with nobody actually talking about it)', async () => {
  await evaluator.evaluateCandidate(hypedLiquidToken('NOMENTIONS'));
  assert.strictEqual(hasOpenPosition('NOMENTIONS'), false);
});

test('the same shape of candidate DOES get bought once it clears the real-mention floor', async () => {
  googleAlerts.getSignal = () => ({ mentionCount: 1 });
  await evaluator.evaluateCandidate(hypedLiquidToken('WITHMENTION'));
  assert.strictEqual(hasOpenPosition('WITHMENTION'), true);
});

test('exit-side re-scoring reuses the entry-time socials bonus instead of dropping it to zero (regression: getLiveTokenAndScore was built before the socials scoring category existed, so every open position lost up to 15 real points on its very first exit-tick re-score for free, biasing the score-drop exit trigger toward firing early)', async () => {
  pumpfunApi.getSocials = async () => ({ count: 3 }); // +15 socials bonus at entry
  googleAlerts.getSignal = () => ({ mentionCount: 1 });
  await evaluator.evaluateCandidate(hypedLiquidToken('SOCIALSPERSIST'));
  const position = db.prepare("SELECT * FROM positions WHERE mint = 'SOCIALSPERSIST' AND status = 'open'").get();
  assert.strictEqual(position.entry_socials_count, 3, 'socials count from entry should be persisted on the position row');

  geckoterminal.getPoolsForToken = async () => [{ volumeH1Usd: 0, volumeH24Usd: 0 }];
  dexscreener.getTokenPriceUsd = async () => ({ priceUsd: 1 });
  const { scoreResult } = await evaluator.getLiveTokenAndScore(position);
  assert.ok(scoreResult.reasons.some((r) => r.includes('3 social links')), `expected the socials bonus to still apply on exit re-score, got reasons: ${JSON.stringify(scoreResult.reasons)}`);
});

test('a real alert names WHERE the hype was actually seen and includes the coin\'s own description, not just a raw score', async () => {
  pumpfunApi.getSocials = async () => ({ count: 0, description: 'a frog that trades better than you' });
  googleAlerts.getSignal = () => ({ mentionCount: 1 });
  telegramUserClient.getSignal = () => ({ mentionCount: 2 });

  let sentText = null;
  telegramBot.sendAlert = (text) => { sentText = text; };

  await evaluator.evaluateCandidate(hypedLiquidToken('WHYLINE'));

  assert.ok(sentText, 'expected an alert to have been sent');
  assert.ok(sentText.includes('"a frog that trades better than you"'), `expected the coin's own description in the alert, got: ${sentText}`);
  assert.ok(sentText.includes('Why:'), `expected a "Why:" line, got: ${sentText}`);
  assert.ok(sentText.includes('Telegram alpha groups'), `expected the actual contributing source named, got: ${sentText}`);
  assert.ok(sentText.includes('CoinGecko trending search'), `expected the specific trending source named, not just a count, got: ${sentText}`);
});

test('a real alert quotes an actual post verbatim (not an AI paraphrase), prioritizing Telegram/X over Google Alerts when both fired', async () => {
  pumpfunApi.getSocials = async () => ({ count: 0, description: '' });
  googleAlerts.getSignal = () => ({ mentionCount: 1, sampleText: 'Boring News Co: new memecoin launches on Solana' });
  telegramUserClient.getSignal = () => ({ mentionCount: 2, sampleText: 'yo this coin is actually the play, ape in now' });

  let sentText = null;
  telegramBot.sendAlert = (text) => { sentText = text; };

  await evaluator.evaluateCandidate(hypedLiquidToken('SAMPLEPOST'));

  assert.ok(sentText, 'expected an alert to have been sent');
  assert.ok(sentText.includes('yo this coin is actually the play, ape in now'), `expected the higher-priority Telegram sample quoted verbatim, got: ${sentText}`);
  assert.ok(sentText.includes('via Telegram alpha groups'), `expected the sample's source attributed, got: ${sentText}`);
  assert.ok(!sentText.includes('Boring News Co'), 'expected only ONE sample quoted (the higher-priority one), not both');
});
