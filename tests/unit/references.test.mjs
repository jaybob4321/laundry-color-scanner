import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  combineProfiles, computeProfileSetVersion, createPaletteIndex, evaluateProfileCandidate, searchColors, validatePalette,
} from '../../src/references.js';
import { deltaE2000Lab } from '../../src/color/delta-e-2000.js';
import { createDetectorContext, analyzePixels } from '../../src/detection/pipeline.js';
import { solid, stripes, toInput } from '../fixtures/synthetic.mjs';
import { loadConfig, loadPalette } from '../helpers.mjs';

const config = loadConfig();
const rawPalette = loadPalette();
const palette = createPaletteIndex(rawPalette);
const ctx = createDetectorContext({ config, palette: rawPalette });
let n = 0;
const makeId = () => `id-${++n}`;

test('palette validation', () => {
  assert.doesNotThrow(() => validatePalette(rawPalette));
  const clone = () => structuredClone(rawPalette);
  const dup = clone();
  dup.colors[1].id = dup.colors[0].id;
  assert.throws(() => validatePalette(dup), /duplicate/);
  const badHex = clone();
  badHex.colors[0].hex = '#000000';
  assert.throws(() => validatePalette(badHex), /match hex/);
  const badGroup = clone();
  badGroup.colors[0].laundryGroup = 'socks';
  assert.throws(() => validatePalette(badGroup));
  const d50 = clone();
  d50.colorSpace = 'CIELAB-D50';
  assert.throws(() => validatePalette(d50));
});

test('palette index is frozen and complete', () => {
  assert.equal(palette.colors.length, 57);
  assert.ok(Object.isFrozen(palette.colors[0]));
  assert.ok(palette.byId.has('faded-denim'));
  for (const c of palette.colors) {
    for (const key of ['name', 'hex', 'rgb', 'lab', 'laundryGroup', 'aliases']) assert.ok(key in c, `${c.id}.${key}`);
  }
});

test('color search covers names, aliases and word prefixes', () => {
  assert.equal(searchColors(palette, 'navy')[0].id, 'navy');
  assert.ok(searchColors(palette, 'grey').some((c) => c.id === 'gray'), 'alias Grey');
  assert.deepEqual(searchColors(palette, 'wine').map((c) => c.id).sort(), ['burgundy', 'dark-red']);
  assert.equal(searchColors(palette, 'blue')[0].id, 'blue');
  assert.equal(searchColors(palette, '').length, 57);
  assert.equal(searchColors(palette, 'zzz').length, 0);
});

test('profile gates: good neutral scan is approved; unknown lighting is pending', () => {
  const { result } = analyzePixels(toInput(solid('#2A3A5E', { noise: 2 })), ctx);
  const base = { result, colorId: 'navy', paletteIndex: palette, existingProfiles: [], config, distance: deltaE2000Lab, makeId };
  const ok = evaluateProfileCandidate({ ...base, captureCondition: 'neutral' });
  assert.equal(ok.blocked, false);
  assert.equal(ok.status, 'approved');
  assert.equal(ok.profile.colorSpace, 'CIELAB-D65-2deg');
  assert.equal(ok.profile.source, 'user');
  assert.ok(!('image' in ok.profile) && !('rgba' in ok.profile), 'numbers only, never pixels');
  const unknown = evaluateProfileCandidate({ ...base, captureCondition: 'unknown' });
  assert.equal(unknown.status, 'pending');
  const fakeCalibrated = evaluateProfileCandidate({ ...base, captureCondition: 'calibrated' });
  assert.equal(fakeCalibrated.status, 'pending', 'calibrated requires an actual calibration');
});

test('profile gates: multicolor is blocked; far-from-seed and full capacity are pending', () => {
  const multi = analyzePixels(toInput(stripes([{ color: '#101114', size: 24 }, { color: '#FFFFFF', size: 24 }])), ctx).result;
  const base = { colorId: 'navy', paletteIndex: palette, config, distance: deltaE2000Lab, makeId, captureCondition: 'neutral' };
  assert.equal(evaluateProfileCandidate({ ...base, result: multi, existingProfiles: [] }).blocked, true);

  const { result } = analyzePixels(toInput(solid('#3657AD', { noise: 2 })), ctx);
  const far = evaluateProfileCandidate({ ...base, result, colorId: 'navy', existingProfiles: [] });
  assert.equal(far.status, 'pending');
  assert.ok(far.seedDistance > 12);

  const navyScan = analyzePixels(toInput(solid('#202E4D', { noise: 2 })), ctx).result;
  const existing = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, colorId: 'navy', status: 'approved', lab: [19 + i, 5, -21] }));
  const full = evaluateProfileCandidate({ ...base, result: navyScan, existingProfiles: existing });
  assert.equal(full.status, 'pending');
  assert.ok(full.duplicate, 'near-duplicate of an existing profile is reported');
});

test('combining near-duplicate profiles weights by sample count', () => {
  const a = { id: 'a', lab: [20, 0, 0], spreadMedianDE00: 2, sampleCount: 300 };
  const b = { id: 'b', lab: [24, 4, -4], spreadMedianDE00: 4, sampleCount: 100 };
  const c = combineProfiles(a, b);
  assert.equal(c.id, 'a');
  assert.deepEqual(c.lab, [21, 1, -1]);
  assert.equal(c.spreadMedianDE00, 2.5);
  assert.equal(c.sampleCount, 400);
});

test('profile set version ignores non-approved profiles and order', () => {
  assert.equal(computeProfileSetVersion([]), 'none');
  const p = [
    { id: 'b', colorId: 'navy', status: 'approved', lab: [1, 2, 3] },
    { id: 'a', colorId: 'red', status: 'approved', lab: [4, 5, 6] },
    { id: 'c', colorId: 'red', status: 'pending', lab: [4, 5, 6] },
  ];
  assert.equal(computeProfileSetVersion(p), computeProfileSetVersion([p[1], p[0]]));
  assert.match(computeProfileSetVersion(p), /^profiles-2-[0-9a-f]{8}$/);
});
