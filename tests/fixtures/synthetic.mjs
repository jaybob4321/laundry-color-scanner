/**
 * Deterministic synthetic garment images (blueprint §17 fixtures).
 * All generators return { rgba: Uint8ClampedArray, width, height }.
 */
import { SRGB8_TO_LINEAR, linearToSrgb } from '../../src/color/srgb-lab.js';
import { hexToRgb } from '../../src/color/srgb-lab.js';
import { mulberry32 } from '../../src/detection/sampling.js';

const toRgb = (c) => (typeof c === 'string' ? hexToRgb(c) : c);

export function blank(width, height) {
  return { rgba: new Uint8ClampedArray(width * height * 4), width, height };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Fill every pixel from fn(x, y) -> [r,g,b] (optionally [r,g,b,a]). */
export function paint(width, height, fn, { noise = 0, seed = 7 } = {}) {
  const img = blank(width, height);
  const rand = mulberry32(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = fn(x, y);
      const p = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) img.rgba[p + k] = Math.round(c[k] + (noise ? noise * gaussian(rand) : 0));
      img.rgba[p + 3] = c.length > 3 ? c[3] : 255;
    }
  }
  return img;
}

export function solid(color, { width = 256, height = 256, noise = 0, seed = 7 } = {}) {
  const rgb = toRgb(color);
  return paint(width, height, () => rgb, { noise, seed });
}

/**
 * Repeating stripes. `bands` = [{ color, size }] in pixels; sizes set the
 * area proportions (e.g. 52/43/5).
 */
export function stripes(bands, { width = 512, height = 512, orientation = 'vertical', noise = 0, seed = 7 } = {}) {
  const colors = bands.map((b) => toRgb(b.color));
  const period = bands.reduce((s, b) => s + b.size, 0);
  const lookup = [];
  bands.forEach((b, i) => {
    for (let k = 0; k < b.size; k++) lookup.push(i);
  });
  return paint(
    width,
    height,
    (x, y) => colors[lookup[(orientation === 'vertical' ? x : y) % period]],
    { noise, seed },
  );
}

export function checkerboard(a, b, cell, { width = 512, height = 512, noise = 0 } = {}) {
  const ca = toRgb(a);
  const cb = toRgb(b);
  return paint(width, height, (x, y) => ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? cb : ca), { noise });
}

/** Two side-by-side blocks; `split` is the left block's width fraction. */
export function blocks(a, b, { split = 0.5, width = 512, height = 512, noise = 0 } = {}) {
  const ca = toRgb(a);
  const cb = toRgb(b);
  return paint(width, height, (x) => (x < split * width ? ca : cb), { noise });
}

/** Scale a color's linear light by `factor` (exposure/illumination change). */
export function shade(color, factor) {
  return toRgb(color).map((v) => Math.round(linearToSrgb(Math.min(1, SRGB8_TO_LINEAR[v] * factor)) * 255));
}

/** Smooth illumination falloff across x from `from` to `to` times the base light. */
export function illuminationRamp(color, { from = 1.0, to = 0.3, width = 512, height = 512, noise = 0 } = {}) {
  const rgb = toRgb(color);
  const lin = rgb.map((v) => SRGB8_TO_LINEAR[v]);
  return paint(
    width,
    height,
    (x) => {
      const f = from + ((to - from) * x) / (width - 1);
      return lin.map((c) => Math.round(linearToSrgb(Math.min(1, c * f)) * 255));
    },
    { noise },
  );
}

/** Fabric with the right part in a hard-edged shadow. */
export function hardShadow(color, factor, { split = 0.5, width = 512, height = 512, noise = 0 } = {}) {
  return blocks(color, shade(color, factor), { split, width, height, noise });
}

/** Multiply linear RGB by per-channel gains (simulated color cast). */
export function applyCast(img, gains) {
  const out = blank(img.width, img.height);
  for (let p = 0; p < img.rgba.length; p += 4) {
    for (let k = 0; k < 3; k++) {
      out.rgba[p + k] = Math.round(linearToSrgb(Math.min(1, SRGB8_TO_LINEAR[img.rgba[p + k]] * gains[k])) * 255);
    }
    out.rgba[p + 3] = img.rgba[p + 3];
  }
  return out;
}

/** Make a border of the given fractional width fully transparent. */
export function transparentBorder(img, fraction) {
  const out = { ...img, rgba: new Uint8ClampedArray(img.rgba) };
  const bx = Math.round(img.width * fraction);
  const by = Math.round(img.height * fraction);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (x < bx || x >= img.width - bx || y < by || y >= img.height - by) out.rgba[(y * img.width + x) * 4 + 3] = 0;
    }
  }
  return out;
}

/** Scatter small square specks (e.g. specular highlights). */
export function specks(img, color, { count = 20, size = 3, seed = 11 } = {}) {
  const rgb = toRgb(color);
  const out = { ...img, rgba: new Uint8ClampedArray(img.rgba) };
  const rand = mulberry32(seed);
  for (let s = 0; s < count; s++) {
    const x0 = Math.floor(rand() * (img.width - size));
    const y0 = Math.floor(rand() * (img.height - size));
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        const p = (y * img.width + x) * 4;
        out.rgba[p] = rgb[0];
        out.rgba[p + 1] = rgb[1];
        out.rgba[p + 2] = rgb[2];
      }
    }
  }
  return out;
}

/** Wrap an image as a pipeline input covering the whole crop. */
export function toInput(img, overrides = {}) {
  return {
    rgba: img.rgba,
    width: img.width,
    height: img.height,
    roi: { x: 0, y: 0, width: 1, height: 1 },
    sourceRoiPx: { width: img.width, height: img.height },
    source: 'upload',
    calibration: null,
    ...overrides,
  };
}
