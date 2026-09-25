import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_IDS, boundaryAlternatives, classifyGroup, groupForColor, groupLabel, groupingVersion, resolveGroupingRules,
} from '../../src/grouping.js';
import { createPaletteIndex } from '../../src/references.js';
import { loadConfig, loadPalette } from '../helpers.mjs';

const preset = loadConfig().grouping;
const palette = createPaletteIndex(loadPalette());
const rules = resolveGroupingRules(preset, null, palette);
const lab = (id) => palette.byId.get(id).lab;
const group = (id, r = rules) => groupForColor(lab(id), palette.byId.get(id).family, id, r).groupId;

test('all 11 requested groups exist with stable ids', () => {
  assert.deepEqual(GROUP_IDS, [
    'whites', 'lights', 'darks', 'reds-pinks', 'blues', 'greens', 'yellows-oranges', 'browns-beiges', 'grays', 'multicolor', 'other',
  ]);
  assert.equal(groupLabel('reds-pinks'), 'Reds / Pinks');
});

test('rules reproduce every seed default group', () => {
  for (const c of palette.colors) assert.equal(group(c.id), c.laundryGroup, c.id);
});

test('every group is reachable', () => {
  const seen = new Set(palette.colors.map((c) => group(c.id)));
  seen.add(classifyGroup({ patternStatus: 'multicolor' }, rules).groupId);
  assert.deepEqual([...seen].sort(), [...GROUP_IDS].sort());
});

test('rule precedence', () => {
  assert.equal(classifyGroup({ patternStatus: 'multicolor', recognized: true, lab: lab('white'), colorId: 'white' }, rules).groupId, 'multicolor');
  assert.deepEqual(classifyGroup({ patternStatus: 'ambiguous', recognized: true, lab: lab('navy'), colorId: 'navy' }, rules), { groupId: 'other', rule: 'needs-review' });
  assert.deepEqual(classifyGroup({ patternStatus: 'single', recognized: false, lab: lab('navy'), colorId: null }, rules), { groupId: 'other', rule: 'needs-review' });
  assert.equal(group('burgundy'), 'darks', 'darks (L<38) precede red family');
  assert.equal(group('light-pink'), 'reds-pinks', 'red family precedes lights');
  assert.equal(group('light-blue'), 'lights', 'lights precede family');
  assert.equal(group('off-white'), 'lights', 'C > 4 is not white');
  // Measured Lab decides, not the seed field: a very light navy match is not Darks.
  assert.equal(groupForColor([45, 4, -20], 'blue', 'navy', rules).groupId, 'blues');
});

test('per-color overrides beat measured-Lab rules; family mappings are configurable', () => {
  const custom = resolveGroupingRules(preset, { colorOverrides: { white: 'lights', navy: 'blues' }, familyGroups: { purple: 'darks' } }, palette);
  assert.deepEqual(groupForColor(lab('white'), 'neutral', 'white', custom), { groupId: 'lights', rule: 'override' });
  assert.equal(group('navy', custom), 'blues');
  assert.equal(group('purple', custom), 'darks');
  assert.notEqual(groupingVersion(custom), groupingVersion(rules));
  assert.equal(groupingVersion(resolveGroupingRules(preset, {}, palette)), groupingVersion(rules));
});

test('invalid stored settings are ignored rather than breaking scans', () => {
  const r = resolveGroupingRules(preset, { colorOverrides: { navy: 'nonsense', ghost: 'darks', red: 'multicolor' }, familyGroups: { alien: 'darks' } }, palette);
  assert.deepEqual(r.colorOverrides, {});
  assert.equal(r.familyGroups.alien, undefined);
});

test('boundary alternatives appear only when a nudge changes the group', () => {
  assert.deepEqual(boundaryAlternatives(lab('dark-gray'), 'dark-gray', rules), ['grays']); // L 37.3
  assert.deepEqual(boundaryAlternatives(lab('royal-blue'), 'royal-blue', rules), ['darks']); // L 38.9
  assert.deepEqual(boundaryAlternatives(lab('off-white'), 'off-white', rules), ['whites']); // C 4.15
  assert.deepEqual(boundaryAlternatives(lab('lavender'), 'lavender', rules), ['other']); // L 75.6
  assert.deepEqual(boundaryAlternatives(lab('gray'), 'gray', rules), []);
  // A red measured just under L 38 could equally sort as Reds / Pinks.
  assert.deepEqual(boundaryAlternatives([36.5, 43, 18], 'dark-red', rules), ['reds-pinks']);
  // Dark Red (L 34.4) and Burgundy (L 27.3) sit more than 2 units below 38: no flag.
  assert.deepEqual(boundaryAlternatives(lab('dark-red'), 'dark-red', rules), []);
  assert.deepEqual(boundaryAlternatives(lab('burgundy'), 'burgundy', rules), []);
  const overridden = resolveGroupingRules(preset, { colorOverrides: { 'dark-gray': 'grays' } }, palette);
  assert.deepEqual(boundaryAlternatives(lab('dark-gray'), 'dark-gray', overridden), [], 'override pins the group');
});
