import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalibration, isCalibrationUsable, measureNeutralReference, validateCalibration,
} from '../../src/detection/calibration.js';
import { SRGB8_TO_LINEAR } from '../../src/color/srgb-lab.js';
import { applyCast, paint, solid } from '../fixtures/synthetic.mjs';
import { assertClose, loadConfig } from '../helpers.mjs';

const cfg = loadConfig().calibration;
const warm = [1.25, 1.0, 0.78];
const cool = [0.82, 0.97, 1.22];

test('gains from a gray card under a warm cast neutralize it in linear light', () => {
  const card = applyCast(solid([170, 170, 170], { width: 64, height: 64 }), warm);
  const m = measureNeutralReference(card.rgba, card.width, card.height, cfg);
  assert.equal(m.ok, true, m.code);
  const [r, g, b] = m.referenceLinearRgb.map((v, i) => v * m.gains[i]);
  assertClose(r, g, 1e-9);
  assertClose(g, b, 1e-9);
});

test('calibration round trip recovers garment colors within 8-bit quantization', () => {
  for (const cast of [warm, cool]) {
    const card = applyCast(solid([200, 200, 200], { width: 64, height: 64 }), cast);
    const m = measureNeutralReference(card.rgba, 64, 64, cfg);
    assert.equal(m.ok, true, m.code);
    const garment = [120, 90, 60];
    const castGarment = applyCast(solid(garment, { width: 1, height: 1 }), cast).rgba;
    for (let k = 0; k < 3; k++) {
      const corrected = SRGB8_TO_LINEAR[castGarment[k]] * m.gains[k];
      // Relative to the (unnormalized) neutral: exposure is preserved, only the cast is removed.
      const expected = SRGB8_TO_LINEAR[garment[k]] * (m.gains[1] * cast[1]);
      assertClose(corrected, expected, 0.01, `channel ${k}`);
    }
  }
});

test('reference brightness is not normalized to white', () => {
  const card = solid([120, 120, 120], { width: 64, height: 64 });
  const m = measureNeutralReference(card.rgba, 64, 64, cfg);
  assert.equal(m.ok, true);
  m.gains.forEach((g) => assertClose(g, 1, 1e-12));
});

test('rejections: too few samples, exposure, clipping, uneven, colored reference', () => {
  const tiny = solid([200, 200, 200], { width: 12, height: 12 });
  assert.equal(measureNeutralReference(tiny.rgba, 12, 12, cfg).code, 'calibration-too-few-samples');
  const dark = solid([30, 30, 30], { width: 64, height: 64 });
  assert.equal(measureNeutralReference(dark.rgba, 64, 64, cfg).code, 'calibration-exposure');
  const clipped = paint(64, 64, (x, y) => (x < 8 && y < 16 ? [255, 255, 255] : [200, 200, 200])); // 3.1%
  assert.equal(measureNeutralReference(clipped.rgba, 64, 64, cfg).code, 'calibration-clipped');
  const uneven = paint(64, 64, (x) => (x < 32 ? [110, 110, 110] : [220, 220, 220]));
  assert.equal(measureNeutralReference(uneven.rgba, 64, 64, cfg).code, 'calibration-uneven');
  const colored = solid([120, 170, 230], { width: 64, height: 64 });
  assert.equal(measureNeutralReference(colored.rgba, 64, 64, cfg).code, 'calibration-gain-range');
});

test('calibration record validation and usability rules', () => {
  const card = solid([200, 200, 200], { width: 64, height: 64 });
  const measurement = measureNeutralReference(card.rgba, 64, 64, cfg);
  const now = Date.parse('2026-09-25T12:00:00Z');
  const live = createCalibration({ measurement, sourceId: 'live-1', cameraSessionId: 'cam-1', torch: false, now, ttlMs: cfg.liveTtlMs });
  assert.equal(validateCalibration(live, cfg).ok, true);
  assert.equal(live.expiresAt, '2026-09-25T12:02:00.000Z');

  assert.equal(isCalibrationUsable(live, { sourceId: 'frame-9', cameraSessionId: 'cam-1', torch: false, now: now + 60_000 }), true);
  assert.equal(isCalibrationUsable(live, { sourceId: 'frame-9', cameraSessionId: 'cam-1', torch: false, now: now + 121_000 }), false, 'expired');
  assert.equal(isCalibrationUsable(live, { sourceId: 'frame-9', cameraSessionId: 'cam-1', torch: true, now }), false, 'torch changed');
  assert.equal(isCalibrationUsable(live, { sourceId: 'frame-9', cameraSessionId: 'cam-2', torch: false, now }), false, 'camera switched');
  assert.equal(isCalibrationUsable(live, { sourceId: 'upload-3', cameraSessionId: null, now }), false, 'never applied to an upload');

  const sameFrame = createCalibration({ measurement, sourceId: 'upload-3', now, ttlMs: cfg.liveTtlMs });
  assert.equal(isCalibrationUsable(sameFrame, { sourceId: 'upload-3', now: now + 3_600_000 }), true, 'same frame');
  assert.equal(isCalibrationUsable(null, { sourceId: 'x' }), false);

  assert.equal(validateCalibration({ ...live, gains: [1, NaN, 1] }, cfg).ok, false);
  assert.equal(validateCalibration({ ...live, gains: [3, 1, 1] }, cfg).ok, false);
  assert.equal(validateCalibration({ ...live, schemaVersion: 2 }, cfg).ok, false);
  assert.equal(validateCalibration({ ...live, torch: 'no' }, cfg).ok, false);
});
