/**
 * Laundry grouping with configurable, ordered rules (blueprint §7).
 *
 * `detectedColorId`, `family` and `laundryGroup` are separate: a navy garment
 * is blue-family and sorts with Darks. Rules evaluate the *measured* Lab of
 * the cluster, not the seed's static default group.
 *
 * Order:
 *   1. Confirmed multicolor -> multicolor
 *   2. Unrecognized / ambiguous -> other ("Needs review")
 *   3. Per-color override
 *   4. L >= 94 and C <= 4 -> whites
 *   5. L < 38 -> darks
 *   6. red family -> reds-pinks
 *   7. L >= 75 -> lights
 *   8. family mapping (neutral -> grays, purple -> other, ...)
 *
 * Color grouping is a sorting convention, not a claim about wash compatibility.
 */
import { canonicalJson, fnv1a } from './util/hash.js';

export const GROUPS = Object.freeze([
  { id: 'whites', label: 'Whites' },
  { id: 'lights', label: 'Lights' },
  { id: 'darks', label: 'Darks' },
  { id: 'reds-pinks', label: 'Reds / Pinks' },
  { id: 'blues', label: 'Blues' },
  { id: 'greens', label: 'Greens' },
  { id: 'yellows-oranges', label: 'Yellows / Oranges' },
  { id: 'browns-beiges', label: 'Browns / Beiges' },
  { id: 'grays', label: 'Grays' },
  { id: 'multicolor', label: 'Multicolor' },
  { id: 'other', label: 'Other' },
]);
export const GROUP_IDS = Object.freeze(GROUPS.map((g) => g.id));
export const FAMILIES = Object.freeze(['neutral', 'blue', 'green', 'yellow', 'orange', 'brown', 'red', 'purple']);

const GROUP_ID_SET = new Set(GROUP_IDS);

export function groupLabel(id) {
  return GROUPS.find((g) => g.id === id)?.label ?? id;
}

/**
 * Merge the versioned preset with user settings:
 *   settings = { familyGroups?: {family: groupId}, colorOverrides?: {colorId: groupId} }
 * Invalid entries are ignored so a bad stored setting cannot break scanning.
 */
export function resolveGroupingRules(preset, settings = null, paletteIndex = null) {
  const familyGroups = { ...preset.familyGroups };
  for (const [family, group] of Object.entries(settings?.familyGroups ?? {})) {
    if (FAMILIES.includes(family) && GROUP_ID_SET.has(group) && group !== 'multicolor') familyGroups[family] = group;
  }
  const colorOverrides = {};
  for (const [colorId, group] of Object.entries(settings?.colorOverrides ?? {})) {
    if ((!paletteIndex || paletteIndex.byId.has(colorId)) && GROUP_ID_SET.has(group) && group !== 'multicolor') {
      colorOverrides[colorId] = group;
    }
  }
  const families = {};
  if (paletteIndex) for (const c of paletteIndex.colors) families[c.id] = c.family;
  return Object.freeze({
    presetId: preset.presetId,
    presetName: preset.presetName,
    presetVersion: preset.presetVersion,
    whites: { ...preset.whites },
    darks: { ...preset.darks },
    lights: { ...preset.lights },
    boundary: { ...preset.boundary },
    familyGroups,
    colorOverrides,
    families,
  });
}

/** Rule version + hash of everything that can change an assignment. */
export function groupingVersion(rules) {
  const material = {
    whites: rules.whites,
    darks: rules.darks,
    lights: rules.lights,
    familyGroups: rules.familyGroups,
    colorOverrides: rules.colorOverrides,
  };
  return `${rules.presetVersion}#${fnv1a(canonicalJson(material))}`;
}

/** Rules 3–8 for a recognized color measured at `lab`. */
export function groupForColor(lab, family, colorId, rules) {
  const override = colorId ? rules.colorOverrides[colorId] : undefined;
  if (override) return { groupId: override, rule: 'override' };
  const L = lab[0];
  const C = Math.hypot(lab[1], lab[2]);
  if (L >= rules.whites.minL && C <= rules.whites.maxC) return { groupId: 'whites', rule: 'whites' };
  if (L < rules.darks.maxL) return { groupId: 'darks', rule: 'darks' };
  if (family === 'red') return { groupId: 'reds-pinks', rule: 'red-family' };
  if (L >= rules.lights.minL) return { groupId: 'lights', rule: 'lights' };
  return { groupId: rules.familyGroups[family] ?? 'other', rule: 'family' };
}

/** Full ordered classification (rules 1–8). */
export function classifyGroup({ patternStatus, recognized, lab, colorId }, rules) {
  if (patternStatus === 'multicolor') return { groupId: 'multicolor', rule: 'multicolor' };
  if (patternStatus === 'ambiguous' || !recognized || !colorId) return { groupId: 'other', rule: 'needs-review' };
  return groupForColor(lab, rules.families[colorId], colorId, rules);
}

/**
 * Groups reachable by nudging lightness ±deltaL or chroma ±deltaC. Non-empty
 * only when the measurement sits close enough to a threshold that crossing
 * it would actually change the group (blueprint §7 boundary flags).
 */
export function boundaryAlternatives(lab, colorId, rules) {
  const family = rules.families[colorId];
  const base = groupForColor(lab, family, colorId, rules).groupId;
  const [L, a, b] = lab;
  const C = Math.hypot(a, b);
  const { deltaL, deltaC } = rules.boundary;
  const probes = [
    [L - deltaL, a, b],
    [L + deltaL, a, b],
  ];
  for (const target of [C - deltaC, C + deltaC]) {
    const t = Math.max(0, target);
    if (C > 0) probes.push([L, (a * t) / C, (b * t) / C]);
    else probes.push([L, t, 0]);
  }
  const alternatives = new Set();
  for (const probe of probes) {
    const g = groupForColor(probe, family, colorId, rules).groupId;
    if (g !== base) alternatives.add(g);
  }
  return [...alternatives].sort();
}
