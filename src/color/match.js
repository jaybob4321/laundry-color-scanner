/**
 * Reference matching (blueprint §5).
 *
 * Every canonical color is scored by its minimum distance over the seed
 * anchor and any approved reference profiles (+penalty). Canonical IDs are
 * ranked (aliases are labels, never extra candidates) with exact ties broken
 * by ID. Only distances are reported — no invented percentages.
 */

export function rankCandidates(lab, paletteIndex, profiles, { distance, profilePenalty }) {
  const best = new Map();
  for (const color of paletteIndex.colors) {
    best.set(color.id, { colorId: color.id, distance: distance(lab, color.lab), source: 'seed' });
  }
  for (const profile of profiles) {
    const current = best.get(profile.colorId);
    if (!current) continue;
    const d = distance(lab, profile.lab) + profilePenalty;
    if (d < current.distance) best.set(profile.colorId, { colorId: profile.colorId, distance: d, source: 'profile' });
  }
  return [...best.values()].sort(compareCandidates);
}

function compareCandidates(x, y) {
  if (x.distance !== y.distance) return x.distance - y.distance;
  return x.colorId < y.colorId ? -1 : x.colorId > y.colorId ? 1 : 0;
}

/** Best match, runner-up distance, recognition and uncertainty flags. */
export function summarizeRanking(ranking, cfg) {
  const d1 = ranking[0].distance;
  const d2 = ranking.length > 1 ? ranking[1].distance : Infinity;
  return {
    bestId: ranking[0].colorId,
    d1,
    d2,
    recognized: d1 <= cfg.unrecognizedAbove,
    uncertain: d1 > cfg.uncertainAbove,
    top: ranking.slice(0, cfg.topMatches).map(({ colorId, distance, source }) => ({ colorId, distance, source })),
  };
}
