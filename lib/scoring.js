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
 * 100-point rubric per the spec: social velocity 30 / volume spike 25 /
 * trending presence 20 / insider buy confirmation 15 / sentiment 10.
 */
function scoreToken(token) {
  const reasons = [];
  let score = 0;

  const mentionCount = token.mentionCount || 0;
  const socialPts = Math.min(30, Math.round((mentionCount / 20) * 30));
  if (socialPts > 0) reasons.push(`+${socialPts} social velocity (${mentionCount} mentions/${config.socialMentionWindowMinutes}min)`);
  score += socialPts;

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

  const buyerCount = token.insiderBuyerCount || 0;
  let insiderPts = 0;
  if (buyerCount >= 3) insiderPts = 15;
  else if (buyerCount === 2) insiderPts = 10;
  else if (buyerCount === 1) insiderPts = 5;
  if (insiderPts > 0) reasons.push(`+${insiderPts} insider buy confirmation (${buyerCount} wallet${buyerCount > 1 ? 's' : ''})`);
  score += insiderPts;

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
