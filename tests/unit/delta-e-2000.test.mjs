import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deltaE2000, deltaE2000Lab, deltaE76Lab, getDistanceMethod } from '../../src/color/delta-e-2000.js';
import { assertClose, loadPalette } from '../helpers.mjs';

// Supplementary test data, Sharma, Wu & Dalal (2005), Table 1: L1 a1 b1 L2 a2 b2 ΔE00.
const SHARMA_PAIRS = [
  [50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
  [50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
  [50.0, 2.8361, -74.02, 50.0, 0.0, -82.7485, 3.4412],
  [50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -1.1848, -84.8006, 50.0, 0.0, -82.7485, 1.0],
  [50.0, -0.9009, -85.5211, 50.0, 0.0, -82.7485, 1.0],
  [50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669],
  [50.0, -1.0, 2.0, 50.0, 0.0, 0.0, 2.3669],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0009, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.001, 7.1792],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0011, 7.2195],
  [50.0, 2.49, -0.001, 50.0, -2.49, 0.0012, 7.2195],
  [50.0, -0.001, 2.49, 50.0, 0.0009, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.001, -2.49, 4.8045],
  [50.0, -0.001, 2.49, 50.0, 0.0011, -2.49, 4.7461],
  [50.0, 2.5, 0.0, 50.0, 0.0, -2.5, 4.3065],
  [50.0, 2.5, 0.0, 73.0, 25.0, -18.0, 27.1492],
  [50.0, 2.5, 0.0, 61.0, -5.0, 29.0, 22.8977],
  [50.0, 2.5, 0.0, 56.0, -27.0, -3.0, 31.903],
  [50.0, 2.5, 0.0, 58.0, 24.0, 15.0, 19.4535],
  [50.0, 2.5, 0.0, 50.0, 3.1736, 0.5854, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2972, 0.0, 1.0],
  [50.0, 2.5, 0.0, 50.0, 1.8634, 0.5757, 1.0],
  [50.0, 2.5, 0.0, 50.0, 3.2592, 0.335, 1.0],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

test('blueprint smoke pair', () => {
  assertClose(deltaE2000Lab([50, 2.6772, -79.7751], [50, 0, -82.7485]), 2.0425, 1e-4);
});

test('all 34 published CIEDE2000 pairs within 0.0001 (both argument orders)', () => {
  SHARMA_PAIRS.forEach(([L1, a1, b1, L2, a2, b2, expected], i) => {
    assertClose(deltaE2000(L1, a1, b1, L2, a2, b2), expected, 1e-4, `pair ${i + 1}`);
    assertClose(deltaE2000(L2, a2, b2, L1, a1, b1), expected, 1e-4, `pair ${i + 1} reversed`);
  });
});

test('identical colors yield exactly zero', () => {
  for (const c of loadPalette().colors) assert.equal(deltaE2000Lab(c.lab, c.lab), 0, c.id);
  assert.equal(deltaE2000(0, 0, 0, 0, 0, 0), 0);
});

test('symmetry and finiteness across the palette', () => {
  const colors = loadPalette().colors;
  for (const p of colors) {
    for (const q of colors) {
      const d = deltaE2000Lab(p.lab, q.lab);
      assert.ok(Number.isFinite(d) && d >= 0);
      assertClose(d, deltaE2000Lab(q.lab, p.lab), 1e-9, `${p.id}/${q.id}`);
    }
  }
});

test('zero-chroma handling: achromatic pairs reduce to a lightness difference', () => {
  // With a = b = 0 for both, ΔE00 = |ΔL| / SL.
  const L1 = 30, L2 = 40;
  const Lbar = (L1 + L2) / 2;
  const SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  assertClose(deltaE2000(L1, 0, 0, L2, 0, 0), 10 / SL, 1e-12);
  // One achromatic, one chromatic must still be finite and positive.
  assert.ok(deltaE2000(50, 0, 0, 50, 0, 10) > 0);
});

test('hue wrap: colors straddling 0°/360° are close, not 360° apart', () => {
  const d = deltaE2000(50, 20, -0.5, 50, 20, 0.5);
  assert.ok(d < 1, `expected small difference across the wrap, got ${d}`);
});

test('ΔE76 is Euclidean', () => {
  assert.equal(deltaE76Lab([0, 0, 0], [3, 4, 12]), 13);
});

test('distance registry', () => {
  assert.equal(getDistanceMethod('ciede2000'), deltaE2000Lab);
  assert.equal(getDistanceMethod('cie76'), deltaE76Lab);
  assert.throws(() => getDistanceMethod('rgb'));
});
