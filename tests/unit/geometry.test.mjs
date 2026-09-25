import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centeredSquare, clampRoi, defaultRoi, roiToPixels, roisOverlap, viewRectToSourceRoi } from '../../src/geometry.js';
import { assertClose } from '../helpers.mjs';

const close = (a, b, tol = 1e-9) => Object.keys(b).forEach((k) => assertClose(a[k], b[k], tol, k));

test('object-fit cover: landscape video in a portrait view (blueprint §3.3 formula)', () => {
  // 1280x720 source shown in a 390x844 phone view: s = max(390/1280, 844/720) = 1.1722
  const view = { width: 390, height: 844 };
  const source = { width: 1280, height: 720 };
  const s = Math.max(390 / 1280, 844 / 720);
  const offsetX = (1280 * s - 390) / 2;
  const rect = centeredSquare(view, 0.6);
  const roi = viewRectToSourceRoi(rect, view, source, { fit: 'cover' });
  close(roi, {
    x: (rect.x + offsetX) / s / 1280,
    y: rect.y / s / 720,
    width: rect.width / s / 1280,
    height: rect.height / s / 720,
  });
  // The visible square maps to a square in source pixels.
  assertClose(roi.width * 1280, roi.height * 720, 1e-9);
  // And it is centered in the source.
  assertClose(roi.x + roi.width / 2, 0.5, 1e-9);
  assertClose(roi.y + roi.height / 2, 0.5, 1e-9);
});

test('object-fit contain: letterboxed image', () => {
  const view = { width: 400, height: 400 };
  const source = { width: 800, height: 400 }; // drawn at 400x200, offset y = 100
  const roi = viewRectToSourceRoi({ x: 0, y: 100, width: 200, height: 200 }, view, source, { fit: 'contain' });
  close(roi, { x: 0, y: 0, width: 0.5, height: 1 });
});

test('mirroring flips x and clamping keeps the ROI inside the source', () => {
  const view = { width: 100, height: 100 };
  const source = { width: 100, height: 100 };
  close(viewRectToSourceRoi({ x: 10, y: 0, width: 20, height: 10 }, view, source, { mirrored: true }), { x: 0.7, y: 0, width: 0.2, height: 0.1 });
  close(viewRectToSourceRoi({ x: -50, y: -50, width: 100, height: 100 }, view, source), { x: 0, y: 0, width: 0.5, height: 0.5 });
});

test('default ROI is a centered square of 60% of the shorter side', () => {
  const roi = defaultRoi(1200, 900);
  assertClose(roi.width * 1200, 540, 1e-9);
  assertClose(roi.height * 900, 540, 1e-9);
  assertClose(roi.x + roi.width / 2, 0.5, 1e-12);
});

test('clampRoi enforces bounds, 64px minimum and max aspect', () => {
  close(clampRoi({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 1000, 1000), { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
  const tiny = clampRoi({ x: 0.5, y: 0.5, width: 0.01, height: 0.01 }, 1000, 500);
  assertClose(tiny.width * 1000, 64, 1e-9);
  assertClose(tiny.height * 500, 64, 1e-9);
  const wide = clampRoi({ x: 0, y: 0, width: 1, height: 0.1 }, 1000, 1000, { maxAspect: 4 });
  assertClose((wide.width * 1000) / (wide.height * 1000), 4, 1e-9);
});

test('roiToPixels rounds inside the image and never returns an empty rect', () => {
  assert.deepEqual(roiToPixels({ x: 0.25, y: 0.5, width: 0.5, height: 0.5 }, 100, 50), { x: 25, y: 25, width: 50, height: 25 });
  assert.deepEqual(roiToPixels({ x: 1, y: 1, width: 0, height: 0 }, 10, 10), { x: 9, y: 9, width: 1, height: 1 });
});

test('overlap detection', () => {
  assert.equal(roisOverlap({ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }), true);
  assert.equal(roisOverlap({ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.5, y: 0, width: 0.2, height: 0.2 }), false);
});
