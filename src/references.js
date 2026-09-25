/**
 * Reference color database and reference profiles (blueprint §6, §13, §14).
 *
 * The palette (data/colors.json) is the only place reference colors live.
 * Reference *profiles* are numeric Lab summaries of verified photos — never
 * the photos — and only `approved` profiles take part in matching.
 */
import { COLOR_SPACE_ID, hexToRgb } from './color/srgb-lab.js';
import { FAMILIES, GROUP_IDS } from './grouping.js';
import { validateProfile, ValidationError } from './schema.js';
import { canonicalJson, fnv1a } from './util/hash.js';

export const PROFILE_SCHEMA_VERSION = 1;

export function validatePalette(palette) {
  if (!palette || palette.schemaVersion !== 1) throw new ValidationError('palette.schemaVersion', 'unsupported');
  if (palette.colorSpace !== COLOR_SPACE_ID) throw new ValidationError('palette.colorSpace', `must be ${COLOR_SPACE_ID}`);
  if (typeof palette.paletteVersion !== 'string') throw new ValidationError('palette.paletteVersion', 'missing');
  if (!Array.isArray(palette.colors) || palette.colors.length === 0) throw new ValidationError('palette.colors', 'empty');
  const seen = new Set();
  palette.colors.forEach((c, i) => {
    const path = `palette.colors[${i}]`;
    if (typeof c.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) throw new ValidationError(`${path}.id`, 'invalid id');
    if (seen.has(c.id)) throw new ValidationError(`${path}.id`, `duplicate id ${c.id}`);
    seen.add(c.id);
    if (typeof c.name !== 'string' || !c.name) throw new ValidationError(`${path}.name`, 'missing');
    const rgb = hexToRgb(c.hex);
    if (!Array.isArray(c.rgb) || c.rgb.some((v, k) => v !== rgb[k])) throw new ValidationError(`${path}.rgb`, 'does not match hex');
    if (!Array.isArray(c.lab) || c.lab.length !== 3 || c.lab.some((v) => !Number.isFinite(v))) {
      throw new ValidationError(`${path}.lab`, 'invalid');
    }
    if (!GROUP_IDS.includes(c.laundryGroup)) throw new ValidationError(`${path}.laundryGroup`, 'unknown group');
    if (!FAMILIES.includes(c.family)) throw new ValidationError(`${path}.family`, 'unknown family');
    if (!Array.isArray(c.aliases) || c.aliases.some((a) => typeof a !== 'string')) throw new ValidationError(`${path}.aliases`, 'invalid');
  });
  return palette;
}

/** Validated, frozen lookup structure used by the matcher and the UI. */
export function createPaletteIndex(palette) {
  validatePalette(palette);
  const colors = palette.colors.map((c) =>
    Object.freeze({
      ...c,
      rgb: Object.freeze([...c.rgb]),
      lab: Object.freeze([...c.lab]),
      aliases: Object.freeze([...c.aliases]),
    }),
  );
  return Object.freeze({
    paletteVersion: palette.paletteVersion,
    colors: Object.freeze(colors),
    byId: new Map(colors.map((c) => [c.id, c])),
  });
}

/** Case-insensitive search over names, aliases and IDs; prefix matches first. */
export function searchColors(paletteIndex, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [...paletteIndex.colors];
  const scored = [];
  for (const c of paletteIndex.colors) {
    const labels = [c.name, ...c.aliases, c.id].map((s) => s.toLowerCase());
    let score = Infinity;
    for (const label of labels) {
      if (label === q) score = Math.min(score, -1);
      else if (label.startsWith(q)) score = Math.min(score, 0);
      else if (label.split(/[\s-]+/).some((w) => w.startsWith(q))) score = Math.min(score, 1);
      else if (label.includes(q)) score = Math.min(score, 2);
    }
    if (score < Infinity) scored.push([score, c]);
  }
  return scored.sort((x, y) => x[0] - y[0]).map(([, c]) => c);
}

export function approvedProfiles(profiles, paletteIndex) {
  return profiles.filter((p) => p.status === 'approved' && paletteIndex.byId.has(p.colorId));
}

/** Fingerprint of the approved profile set, recorded on every result. */
export function computeProfileSetVersion(profiles) {
  const approved = profiles
    .filter((p) => p.status === 'approved')
    .map((p) => [p.id, p.colorId, p.lab.map((v) => +v.toFixed(4))])
    .sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return approved.length ? `profiles-${approved.length}-${fnv1a(canonicalJson(approved))}` : 'none';
}

/** Validate a curated profile set file (data/reference-profiles.json). */
export function validateProfileSet(set) {
  if (!set || set.schemaVersion !== 1 || !Array.isArray(set.profiles)) {
    throw new ValidationError('profileSet', 'unsupported profile set');
  }
  set.profiles.forEach((p, i) => validateProfile(p, `profileSet.profiles[${i}]`));
  return set;
}

/**
 * Quality gates for saving a scan as a reference profile (blueprint §14).
 * Hard gates block saving entirely; soft gates allow a *pending* profile that
 * is not used for matching until it qualifies.
 */
export function evaluateProfileCandidate({ result, colorId, captureCondition, paletteIndex, existingProfiles, config, distance, now = Date.now(), makeId }) {
  const cfg = config.profiles;
  const primary = result.clusters[0];
  const seed = paletteIndex.byId.get(colorId);
  const metrics = result.qualityMetrics;
  const clipFraction = (metrics.nearBlackFraction ?? 0) + (metrics.nearWhiteFraction ?? 0);
  const seedDistance = seed ? distance(primary.lab, seed.lab) : Infinity;
  const active = existingProfiles.filter((p) => p.colorId === colorId && p.status === 'approved');

  const gates = [
    { id: 'known-color', hard: true, pass: Boolean(seed) },
    { id: 'single-color', hard: true, pass: result.patternStatus === 'single' && primary.fraction >= cfg.minLargestFraction, value: primary.fraction },
    { id: 'compact', hard: true, pass: primary.spreadMedianDE00 <= cfg.maxSpread, value: primary.spreadMedianDE00 },
    { id: 'clipping', hard: true, pass: clipFraction <= cfg.maxClippingFraction, value: clipFraction },
    {
      id: 'lighting',
      hard: false,
      pass: captureCondition === 'neutral' || (captureCondition === 'calibrated' && result.calibration !== null),
    },
    { id: 'seed-distance', hard: false, pass: seedDistance <= cfg.maxSeedDistance, value: seedDistance },
    { id: 'capacity', hard: false, pass: active.length < cfg.maxActivePerColor, value: active.length },
  ];
  const blocked = gates.some((g) => g.hard && !g.pass);
  const status = gates.every((g) => g.pass) ? 'approved' : 'pending';
  const duplicate = active.find((p) => distance(p.lab, primary.lab) < cfg.duplicateBelow) ?? null;

  const profile = blocked
    ? null
    : {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        id: makeId(),
        colorId,
        lab: [...primary.lab],
        spreadMedianDE00: primary.spreadMedianDE00,
        source: 'user',
        status,
        captureCondition,
        colorSpace: COLOR_SPACE_ID,
        detectorVersion: result.detectorVersion,
        createdAt: new Date(now).toISOString(),
        sampleCount: Math.max(1, Math.round(result.sampleCount * primary.fraction)),
      };
  return { blocked, status, gates, duplicate, seedDistance, profile };
}

/** Combine a new profile into a near-duplicate, weighting by sample count. */
export function combineProfiles(existing, incoming) {
  const total = existing.sampleCount + incoming.sampleCount;
  const w1 = existing.sampleCount / total;
  const w2 = incoming.sampleCount / total;
  return {
    ...existing,
    lab: existing.lab.map((v, i) => v * w1 + incoming.lab[i] * w2),
    spreadMedianDE00: existing.spreadMedianDE00 * w1 + incoming.spreadMedianDE00 * w2,
    sampleCount: total,
  };
}
