/**
 * Heuristic match confidence (blueprint §9).
 *
 * The number is NOT a calibrated probability of correctness. UI copy:
 * "Based on color similarity and image quality; lighting can change the result."
 *
 *   fit       = exp(-(d1/10)^2)
 *   margin    = clamp((d2-d1)/6)          d2 = next different canonical ID
 *   compact   = exp(-(spreadMedianDE00/8)^2)
 *   stability = 1 - clamp(DE00(repSeed1, closestRepSeed2)/8)
 *   quality   = 1 - .35*clamp((nearBlack+nearWhite)/.5)   per-cluster fractions
 *   score     = round(100*(.35fit + .20margin + .15compact + .15stability + .15quality))
 *
 * Caps are applied after weighting.
 */

export const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function scoreComponents({ d1, d2, spread, stabilityDistance, nearBlackFraction, nearWhiteFraction }, cfg) {
  return {
    fit: Math.exp(-((d1 / cfg.fitScale) ** 2)),
    margin: Number.isFinite(d2) ? clamp01((d2 - d1) / cfg.marginScale) : 1,
    compact: Math.exp(-((spread / cfg.compactScale) ** 2)),
    stability: Number.isFinite(stabilityDistance) ? 1 - clamp01(stabilityDistance / cfg.stabilityScale) : 0,
    quality: 1 - cfg.qualityPenalty * clamp01((nearBlackFraction + nearWhiteFraction) / cfg.qualityClipScale),
  };
}

export function weightedScore(components, weights) {
  const raw =
    weights.fit * components.fit +
    weights.margin * components.margin +
    weights.compact * components.compact +
    weights.stability * components.stability +
    weights.quality * components.quality;
  return Math.round(100 * raw);
}

/** Apply every cap; report the ones that actually lowered the score. */
export function applyCaps(score, caps) {
  let result = score;
  for (const cap of caps) result = Math.min(result, cap.max);
  const applied = caps.filter((cap) => cap.max < score).map((cap) => cap.id);
  return { score: result, applied };
}

/** Caps shared by color and group scores. */
export function baseCaps({ calibrated, clipFraction, d1 }, caps) {
  const list = [calibrated ? { id: 'calibrated', max: caps.calibrated } : { id: 'uncalibrated', max: caps.uncalibrated }];
  if (clipFraction > caps.nearClippingFraction) list.push({ id: 'near-clipping', max: caps.nearClipping });
  if (d1 > caps.poorFitAbove) list.push({ id: 'poor-fit', max: caps.poorFit });
  return list;
}

export function confidenceLabel(score, labels) {
  if (score === null || score === undefined) return null;
  if (score >= labels.high) return 'High';
  if (score >= labels.moderate) return 'Moderate';
  return 'Low';
}
