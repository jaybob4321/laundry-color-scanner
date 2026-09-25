/**
 * Quality, calibration and failure-path fixtures (blueprint §3, §10, §17, §19).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePixels, createDetectorContext, measureCalibrationPatch, DetectorError } from '../../src/detection/pipeline.js';
import { createCalibration } from '../../src/detection/calibration.js';
import { applyCast, solid, specks, transparentBorder, toInput } from '../fixtures/synthetic.mjs';
import { loadConfig, loadPalette } from '../helpers.mjs';

const config = loadConfig();
const palette = loadPalette();
const ctx = createDetectorContext({ config, palette });
const hex = (id) => palette.colors.find((c) => c.id === id).hex;
const analyze = (img, extra) => analyzePixels(toInput(img, extra), ctx).result;

function calibrateFrom(cardImg, sourceId = 'frame-1') {
  const m = measureCalibrationPatch(cardImg, ctx);
  assert.equal(m.ok, true, m.code);
  return createCalibration({ measurement: m, sourceId, now: Date.now(), ttlMs: config.calibration.liveTtlMs });
}

test('transparent edges are excluded, not composited onto black', () => {
  const r = analyze(transparentBorder(solid(hex('navy'), { noise: 2 }), 0.2));
  assert.equal(r.detectedColorId, 'navy');
  assert.ok(r.sampleCount < 4096 * 0.4 && r.sampleCount > 1024);
  assert.ok(!r.clusters.some((c) => c.matches[0].colorId === 'black'));
});

test('too few valid samples and too-small ROIs are hard failures', () => {
  assert.throws(() => analyze(transparentBorder(solid(hex('navy')), 0.4)), (e) => e instanceof DetectorError && e.code === 'too-few-samples');
  assert.throws(() => analyze(solid(hex('navy')), { sourceRoiPx: { width: 63, height: 400 } }), { code: 'roi-too-small' });
  assert.throws(() => analyze(solid(hex('navy')), { width: 10 }), { code: 'invalid-input' });
  assert.throws(() => analyze(solid(hex('navy')), { roi: { x: 0, y: 0, width: 2, height: 1 } }), { code: 'invalid-input' });
});

test('small specular highlights do not change the garment color', () => {
  const r = analyze(specks(solid(hex('navy'), { noise: 2 }), '#FFFFFF', { count: 25, size: 3 }));
  assert.equal(r.patternStatus, 'single');
  assert.equal(r.detectedColorId, 'navy');
  assert.equal(r.laundryGroup, 'darks');
});

test('large bright or dark areas are fabric, not artifacts', () => {
  const r = analyze(solid([2, 2, 2]));
  assert.equal(r.laundryGroup, 'darks');
  assert.equal(r.detectedColorId, 'black');
  assert.ok(r.qualityFlags.includes('near-clipping'));
  assert.ok(r.confidence <= 65);
});

test('warm-cast light gray is corrected by a white-card calibration', () => {
  const warm = [1.3, 1.0, 0.72];
  const garment = applyCast(solid(hex('light-gray'), { noise: 2 }), warm);
  const card = applyCast(solid([215, 215, 215], { width: 96, height: 96, noise: 1 }), warm);
  const uncalibrated = analyze(garment);
  assert.notEqual(uncalibrated.detectedColorId, 'light-gray', 'the cast misleads the uncalibrated scan');
  const calibrated = analyze(garment, { calibration: calibrateFrom(card) });
  assert.equal(calibrated.detectedColorId, 'light-gray');
  assert.ok(calibrated.qualityFlags.includes('calibrated'));
  assert.ok(calibrated.calibration && calibrated.calibration.gains[2] > 1);
  assert.ok(calibrated.confidence <= 95);
});

test('cool-cast beige is corrected by a gray-card calibration', () => {
  const cool = [0.8, 0.97, 1.28];
  const garment = applyCast(solid(hex('beige'), { noise: 2 }), cool);
  const card = applyCast(solid([150, 150, 150], { width: 96, height: 96, noise: 1 }), cool);
  const calibrated = analyze(garment, { calibration: calibrateFrom(card) });
  assert.ok(['beige', 'cream'].includes(calibrated.detectedColorId), calibrated.detectedColorId);
  assert.ok(['lights', 'browns-beiges'].includes(calibrated.laundryGroup));
});

test('calibration that newly clips >5% of the garment is discarded visibly', () => {
  const card = solid([120, 150, 200], { width: 96, height: 96 });
  const m = measureCalibrationPatch(card, ctx);
  // Colored card is rejected outright.
  assert.equal(m.ok, false);
  // A valid but strong correction applied to a near-white garment clips it.
  const cal = createCalibration({
    measurement: { gains: [1.45, 1.0, 0.8], referenceLinearRgb: [0.4, 0.58, 0.72] },
    sourceId: 'frame-1',
    now: Date.now(),
    ttlMs: 120000,
  });
  const r = analyze(solid([240, 240, 240], { noise: 2 }), { calibration: cal });
  assert.ok(r.qualityFlags.includes('calibration-discarded'));
  assert.equal(r.calibration, null);
  assert.ok(r.qualityMetrics.newlyClippedFraction > 0.05);
});

test('invalid calibration records are rejected', () => {
  assert.throws(() => analyze(solid(hex('navy')), { calibration: { schemaVersion: 1, gains: [9, 1, 1] } }), { code: 'invalid-calibration' });
});

test('reference-patch measurement guards its input', () => {
  assert.equal(measureCalibrationPatch(solid([200, 200, 200], { width: 10, height: 10 }), ctx).code, 'calibration-too-few-samples');
  assert.throws(() => measureCalibrationPatch({ rgba: new Uint8ClampedArray(3), width: 1, height: 1 }, ctx), { code: 'invalid-input' });
});

test('heavy noise still resolves the dominant color', () => {
  const r = analyze(solid(hex('burgundy'), { noise: 8 }));
  assert.ok(['burgundy', 'maroon'].includes(r.detectedColorId));
  assert.equal(r.laundryGroup, 'darks');
});
