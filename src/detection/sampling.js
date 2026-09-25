/**
 * Stratified, deterministically jittered point sampling (blueprint §3.5).
 *
 * One source pixel per grid cell — never a cell average — so thin
 * black/white stripes stay black and white instead of blending to gray.
 * Sample positions are preserved for spatial diagnostics and debugging.
 */
import { SRGB8_TO_LINEAR, linearRgbToLab, linearRgbToSrgb8, srgb8ToLab } from '../color/srgb-lab.js';

/** Small, fast, deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Take one jittered pixel per cell of a gridWidth x gridHeight grid.
 * Pixels with alpha < alphaMin are invalid (never composited onto black).
 */
export function sampleGrid(rgba, width, height, { gridWidth, gridHeight = gridWidth, seed, alphaMin }) {
  if (!(width > 0 && height > 0)) throw new RangeError('Image has no pixels');
  if (rgba.length < width * height * 4) throw new RangeError('Pixel buffer is smaller than width x height');
  const total = gridWidth * gridHeight;
  const rgb = new Uint8Array(total * 3);
  const valid = new Uint8Array(total);
  const x = new Uint16Array(total);
  const y = new Uint16Array(total);
  const rand = mulberry32(seed);
  const cellW = width / gridWidth;
  const cellH = height / gridHeight;
  let validCount = 0;
  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const i = gy * gridWidth + gx;
      const px = Math.min(width - 1, Math.floor((gx + rand()) * cellW));
      const py = Math.min(height - 1, Math.floor((gy + rand()) * cellH));
      x[i] = px;
      y[i] = py;
      const p = (py * width + px) * 4;
      rgb[i * 3] = rgba[p];
      rgb[i * 3 + 1] = rgba[p + 1];
      rgb[i * 3 + 2] = rgba[p + 2];
      if (rgba[p + 3] >= alphaMin) {
        valid[i] = 1;
        validCount++;
      }
    }
  }
  return { gridWidth, gridHeight, total, rgb, valid, x, y, validCount, seed };
}

/**
 * Convert valid samples to Lab, optionally applying diagonal white-balance
 * gains in linear RGB (blueprint §10). Corrected linear values feed XYZ
 * directly — no second linearization.
 *
 * Returns compact arrays indexed by *valid* sample (0..n-1) plus the map
 * back to grid cells.
 */
export function samplesToLab(samples, gains = null) {
  const n = samples.validCount;
  const lab = new Float64Array(n * 3);
  const displayRgb = new Uint8Array(n * 3);
  const gridIndex = new Uint32Array(n);
  let newlyClipped = 0;
  let v = 0;
  for (let i = 0; i < samples.total; i++) {
    if (!samples.valid[i]) continue;
    const r8 = samples.rgb[i * 3];
    const g8 = samples.rgb[i * 3 + 1];
    const b8 = samples.rgb[i * 3 + 2];
    gridIndex[v] = i;
    if (!gains) {
      srgb8ToLab(r8, g8, b8, lab, v * 3);
      displayRgb[v * 3] = r8;
      displayRgb[v * 3 + 1] = g8;
      displayRgb[v * 3 + 2] = b8;
    } else {
      let r = SRGB8_TO_LINEAR[r8] * gains[0];
      let g = SRGB8_TO_LINEAR[g8] * gains[1];
      let b = SRGB8_TO_LINEAR[b8] * gains[2];
      if ((r > 1 && r8 < 255) || (g > 1 && g8 < 255) || (b > 1 && b8 < 255)) newlyClipped++;
      r = r > 1 ? 1 : r;
      g = g > 1 ? 1 : g;
      b = b > 1 ? 1 : b;
      linearRgbToLab(r, g, b, lab, v * 3);
      const enc = linearRgbToSrgb8(r, g, b);
      displayRgb[v * 3] = enc[0];
      displayRgb[v * 3 + 1] = enc[1];
      displayRgb[v * 3 + 2] = enc[2];
    }
    v++;
  }
  return { n, lab, displayRgb, gridIndex, newlyClippedFraction: n ? newlyClipped / n : 0 };
}
