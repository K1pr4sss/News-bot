const config = require('./config');

/**
 * 24h volume vs its own trailing hourly average, as a multiplier - the
 * "volume spike" signal from both the scoring rubric and the entry gate.
 * A pool too new to have a real 24h figure falls back to raw h1 volume
 * against a small fixed baseline so it isn't silently treated as 0.
 */
function computeVolumeSpikeRatio(token) {
  const h1 = token.volumeH1Usd || 0;
  const h24 = token.volumeH24Usd || 0;
  if (h24 > 0) {
    const avgHourly = h24 / 24;
    if (avgHourly <= 0) return h1 > 0 ? 5 : 0;
    return h1 / avgHourly;
  }
  return h1 / 1000; // brand-new pool with no 24h history yet - $1k/h as a nominal baseline
}

/**
 * Rubric per the spec minus insider buy confirmation (removed - user call,
 * not worth the Solscan/wallet-curation overhead for this bot): social
 * velocity 30 / volume spike 25 / trending presence 20 / sentiment 10 / has
 * socials 15. Max achievable score is 100.
 *
 * "Has socials" started as a hard reject filter (missing = instant
 * disqualification) but was moved here as a bonus after real rejection data
 * showed it was one of the two most common rejection reasons, and the old
 * sniper bot had already hit and fixed the identical over-strictness problem
 * (plenty of legit brand-new pump.fun tokens haven't added twitter/telegram/
 * website yet - that's a timing gap, not a red flag). Additive bonus rather
 * than a penalty subtracted from a full score, matching that same fix: a
 * token with zero socials still scores normally on every other category
 * instead of starting from a deficit.
 */
function scoreToken(token) {
  const reasons = [];
  let score = 0;

  const mentionCount = token.mentionCount || 0;
  const socialPts = Math.min(30, Math.round((mentionCount / 20) * 30));
  if (socialPts > 0) reasons.push(`+${socialPts} social velocity (${mentionCount} mentions/${config.socialMentionWindowMinutes}min)`);
  score += socialPts;

  const socialsCount = token.socialsCount || 0;
  const hasSocialsPts = Math.min(15, socialsCount * 5);
  if (hasSocialsPts > 0) reasons.push(`+${hasSocialsPts} has ${socialsCount} social link${socialsCount > 1 ? 's' : ''}`);
  score += hasSocialsPts;

  const volumeRatio = computeVolumeSpikeRatio(token);
  let volumePts = 0;
  if (volumeRatio >= config.volumeSpikeMultiplierMax) volumePts = 25;
  else if (volumeRatio >= config.volumeSpikeMultiplierHigh) {
    volumePts = Math.round(15 + ((volumeRatio - 2) / 3) * 10);
  }
  if (volumePts > 0) reasons.push(`+${volumePts} volume spike (${volumeRatio.toFixed(1)}x)`);
  score += volumePts;

  const matchCount = [token.matchedTrendingKeyword, token.matchedTrendingPool, token.isBoosted].filter(Boolean).length;
  const trendingPts = Math.min(20, matchCount * 10);
  if (trendingPts > 0) reasons.push(`+${trendingPts} trending presence (${matchCount} source${matchCount > 1 ? 's' : ''})`);
  score += trendingPts;

  let sentimentPts = 0;
  if (typeof token.positiveRatio === 'number') {
    sentimentPts = Math.round(token.positiveRatio * 10);
    reasons.push(`+${sentimentPts} sentiment (${Math.round(token.positiveRatio * 100)}% positive)`);
  }
  score += sentimentPts;

  return { score: Math.max(0, Math.min(100, score)), reasons, volumeRatio };
}

/** Sizing tier off the entry score, per spec Section 6. */
function computeSizeTier(score) {
  if (score >= 70) return { pct: config.sizeTier3Pct, holdMinutes: config.holdMinutesTier3, label: '70+' };
  if (score >= 55) return { pct: config.sizeTier2Pct, holdMinutes: config.holdMinutesTier2, label: '55-70' };
  return { pct: config.sizeTier1Pct, holdMinutes: config.holdMinutesTier1, label: '40-55' };
}

module.exports = { scoreToken, computeVolumeSpikeRatio, computeSizeTier };
