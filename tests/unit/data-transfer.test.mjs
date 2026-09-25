import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, ImportError, MAX_IMPORT_BYTES, planImport } from '../../src/data-transfer.js';
import { createDetectorContext, analyzePixels } from '../../src/detection/pipeline.js';
import { solid, toInput } from '../fixtures/synthetic.mjs';
import { loadConfig, loadPalette } from '../helpers.mjs';

const ctx = createDetectorContext({ config: loadConfig(), palette: loadPalette() });
const result = analyzePixels(toInput(solid('#682D40', { width: 96, height: 96 })), ctx).result;

const correction = (id) => ({
  schemaVersion: 1,
  id,
  createdAt: '2026-09-25T10:00:00.000Z',
  original: result,
  corrected: { colorId: 'maroon', laundryGroup: 'darks', patternStatus: 'single' },
  note: '',
  usedForLearning: false,
});
const profile = (id) => ({
  schemaVersion: 1, id, colorId: 'navy', lab: [19, 4, -21], spreadMedianDE00: 1, source: 'user', status: 'approved',
  captureCondition: 'neutral', colorSpace: 'CIELAB-D65-2deg', detectorVersion: '1.0.0', createdAt: '2026-09-25T10:00:00.000Z', sampleCount: 3000,
});

const exportText = (overrides = {}) =>
  JSON.stringify({
    ...buildExport({ corrections: [correction('c1'), correction('c2')], profiles: [profile('p1')], settings: { grouping: { colorOverrides: { navy: 'blues' } } }, appVersion: '1.0.0' }),
    ...overrides,
  });

test('export is versioned and contains no image data', () => {
  const payload = JSON.parse(exportText());
  assert.equal(payload.format, 'laundry-color-scanner-export');
  assert.equal(payload.schemaVersion, 1);
  assert.ok(!/data:image|rgba|base64/i.test(JSON.stringify(payload)));
});

test('import plan validates records, skips duplicates and counts everything', () => {
  const plan = planImport(exportText(), { existingCorrectionIds: new Set(['c2']) });
  assert.deepEqual(plan.counts, { corrections: { add: 1, duplicate: 1, invalid: 0 }, profiles: { add: 1, duplicate: 0, invalid: 0 } });
  assert.deepEqual(plan.corrections.map((c) => c.id), ['c1']);
  assert.deepEqual(plan.settings, { grouping: { colorOverrides: { navy: 'blues' } } });
});

test('invalid records are skipped, not imported', () => {
  const bad = { ...correction('c3'), usedForLearning: true };
  const nan = { ...profile('p2'), lab: [null, 0, 0] };
  const text = exportText({ corrections: [bad, correction('c4'), correction('c4')], profiles: [nan] });
  const plan = planImport(text);
  assert.deepEqual(plan.counts.corrections, { add: 1, duplicate: 1, invalid: 1 });
  assert.deepEqual(plan.counts.profiles, { add: 0, duplicate: 0, invalid: 1 });
});

test('import rejects wrong formats, versions, oversize files and too many records', () => {
  assert.throws(() => planImport('not json'), (e) => e instanceof ImportError && e.code === 'not-json');
  assert.throws(() => planImport('{"format":"other"}'), { code: 'wrong-format' });
  assert.throws(() => planImport(exportText({ schemaVersion: 2 })), { code: 'unsupported-version' });
  assert.throws(() => planImport('{}', { byteLength: MAX_IMPORT_BYTES + 1 }), { code: 'too-large' });
  const many = exportText({ corrections: [], profiles: Array.from({ length: 5001 }, (_, i) => profile(`p${i}`)) });
  assert.throws(() => planImport(many, { byteLength: 1 }), { code: 'too-many-records' });
});
