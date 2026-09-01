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
const positions = require('../lib/positions');
const evaluator = require('../lib/evaluator');

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
