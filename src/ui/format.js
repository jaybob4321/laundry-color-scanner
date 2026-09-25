/**
 * Pure display helpers shared by the results screen, debug view and tests.
 */

/**
 * Largest-remainder rounding: integer percentages that sum to exactly 100
 * (blueprint §8). Ties go to the earlier (larger) entry.
 */
export function largestRemainderPercentages(fractions) {
  const total = fractions.reduce((s, f) => s + f, 0);
  if (!(total > 0)) return fractions.map(() => 0);
  const exact = fractions.map((f) => (f / total) * 100);
  const floors = exact.map(Math.floor);
  let remaining = 100 - floors.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => [v - floors[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (remaining <= 0) break;
    floors[i]++;
    remaining--;
  }
  return floors;
}

/**
 * Components to show for a result: every cluster at or above the accent
 * threshold, plus an "Other colors" remainder. Minor clusters are never
 * dropped from the total, so percentages describe the whole target.
 */
export function componentBreakdown(clusters, minShownFraction) {
  const shown = clusters.filter((c, i) => i === 0 || c.fraction >= minShownFraction);
  const otherFraction = Math.max(0, 1 - shown.reduce((s, c) => s + c.fraction, 0));
  const percents = largestRemainderPercentages([...shown.map((c) => c.fraction), otherFraction]);
  const items = shown.map((cluster, i) => ({ cluster, percent: percents[i] }));
  const otherPercent = percents[percents.length - 1];
  return { items, otherPercent };
}

export function formatLab(lab, digits = 1) {
  return `L ${lab[0].toFixed(digits)}, a ${lab[1].toFixed(digits)}, b ${lab[2].toFixed(digits)}`;
}

export function formatRgb(rgb) {
  return rgb.join(', ');
}

export function formatDistance(d) {
  return Number.isFinite(d) ? d.toFixed(1) : '—';
}
