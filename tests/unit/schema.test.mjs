import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValid, validateCorrection, validateProfile, validateScanResult, validateGroupingSettings } from '../../src/schema.js';
import { createDetectorContext, analyzePixels } from '../../src/detection/pipeline.js';
import { createId, UUID_PATTERN } from '../../src/util/ids.js';
import { solid, toInput } from '../fixtures/synthetic.mjs';
import { loadConfig, loadPalette } from '../helpers.mjs';

const ctx = createDetectorContext({ config: loadConfig(), palette: loadPalette() });
const scan = () => analyzePixels(toInput(solid('#682D40', { noise: 2 })), ctx).result;

test('pipeline results validate, including after a JSON round trip', () => {
  const result = scan();
  assert.doesNotThrow(() => validateScanResult(result));
  assert.doesNotThrow(() => validateScanResult(JSON.parse(JSON.stringify(result))));
});

test('scan result validation rejects NaN, Infinity, ranges and unknown versions', () => {
  const bad = (mutate) => {
    const r = structuredClone(scan());
    mutate(r);
    return isValid(validateScanResult, r);
  };
  assert.equal(bad(() => {}), true);
  assert.equal(bad((r) => (r.schemaVersion = 2)), false);
  assert.equal(bad((r) => (r.confidence = NaN)), false);
  assert.equal(bad((r) => (r.clusters[0].lab[0] = Infinity)), false);
  assert.equal(bad((r) => (r.clusters[0].fraction = 1.5)), false);
  assert.equal(bad((r) => (r.laundryGroup = 'socks')), false);
  assert.equal(bad((r) => (r.patternStatus = 'plaid')), false);
  assert.equal(bad((r) => (r.qualityMetrics.totalMs = -Infinity)), false);
  assert.equal(bad((r) => (r.roi.width = 2)), false);
  assert.equal(bad((r) => (r.confidenceKind = 'probability')), false);
  assert.equal(bad((r) => (r.clusters[0].rgb = [1.5, 2, 3])), false);
});

test('corrections and profiles', () => {
  const correction = {
    schemaVersion: 1,
    id: createId(),
    createdAt: new Date().toISOString(),
    original: scan(),
    corrected: { colorId: 'maroon', laundryGroup: 'darks', patternStatus: 'single' },
    note: '<img src=x onerror=alert(1)> stays text',
    usedForLearning: false,
  };
  assert.doesNotThrow(() => validateCorrection(correction));
  assert.equal(isValid(validateCorrection, { ...correction, usedForLearning: true }), false);
  assert.equal(isValid(validateCorrection, { ...correction, note: 'x'.repeat(501) }), false);
  assert.equal(isValid(validateCorrection, { ...correction, corrected: { ...correction.corrected, laundryGroup: 'nope' } }), false);
  assert.equal(isValid(validateCorrection, { ...correction, corrected: { colorId: null, laundryGroup: 'other', patternStatus: 'unknown' } }), true);

  const profile = {
    schemaVersion: 1, id: 'p', colorId: 'navy', lab: [19, 4, -21], spreadMedianDE00: 1.2, source: 'user', status: 'approved',
    captureCondition: 'neutral', colorSpace: 'CIELAB-D65-2deg', detectorVersion: '1.0.0', createdAt: new Date().toISOString(), sampleCount: 4000,
  };
  assert.doesNotThrow(() => validateProfile(profile));
  assert.equal(isValid(validateProfile, { ...profile, colorSpace: 'CIELAB-D50' }), false);
  assert.equal(isValid(validateProfile, { ...profile, status: 'live' }), false);
  assert.equal(isValid(validateProfile, { ...profile, sampleCount: 1.5 }), false);
});

test('grouping settings', () => {
  assert.equal(isValid(validateGroupingSettings, { colorOverrides: { navy: 'blues' }, familyGroups: { purple: 'darks' } }), true);
  assert.equal(isValid(validateGroupingSettings, { colorOverrides: { navy: 'socks' } }), false);
});

test('ids: randomUUID, getRandomValues fallback, Math.random fallback', () => {
  assert.match(createId(), UUID_PATTERN);
  const noUuid = { getRandomValues: (b) => globalThis.crypto.getRandomValues(b) };
  const ids = new Set(Array.from({ length: 200 }, () => createId(noUuid)));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, UUID_PATTERN);
  assert.match(createId({}), UUID_PATTERN);
  assert.match(createId(undefined), UUID_PATTERN);
});
