/**
 * sRGB <-> linear RGB <-> CIE XYZ <-> CIELAB conversions (blueprint §4).
 *
 * Every Lab value in this application is CIELAB relative to the D65 white
 * point with the CIE 1931 2° observer ("CIELAB-D65-2deg"). This is NOT CSS
 * `lab()`, which is D50-relative. Swatches are always rendered from sRGB.
 *
 * Analysis keeps full floating-point precision; only serialized seed values
 * and on-screen numbers are rounded.
 */

export const COLOR_SPACE_ID = 'CIELAB-D65-2deg';
export const D65_WHITE = Object.freeze([0.95047, 1.0, 1.08883]);

const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

// IEC 61966-2-1 sRGB primaries, D65 white. Row-major.
const RGB_TO_XYZ = Object.freeze([
  0.4124564, 0.3575761, 0.1804375,
  0.2126729, 0.7151522, 0.0721750,
  0.0193339, 0.1191920, 0.9503041,
]);
const XYZ_TO_RGB = Object.freeze(invert3x3(RGB_TO_XYZ));

/** Decode one sRGB-encoded channel in [0,1] to linear light. */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Encode one linear channel in [0,1] to sRGB. Used for display only. */
export function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** 256-entry linearization table for uncalibrated 8-bit pixels. */
export const SRGB8_TO_LINEAR = (() => {
  const table = new Float64Array(256);
  for (let v = 0; v < 256; v++) table[v] = srgbToLinear(v / 255);
  return table;
})();

function labF(t) {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

function labFInverse(f) {
  const f3 = f * f * f;
  return f3 > LAB_EPSILON ? f3 : (116 * f - 16) / LAB_KAPPA;
}

/**
 * Linear RGB (each nominally 0..1) -> Lab. Writes into `out` at `offset`
 * so hot loops can fill a Float64Array without allocating.
 */
export function linearRgbToLab(r, g, b, out = [0, 0, 0], offset = 0) {
  const x = (RGB_TO_XYZ[0] * r + RGB_TO_XYZ[1] * g + RGB_TO_XYZ[2] * b) / D65_WHITE[0];
  const y = RGB_TO_XYZ[3] * r + RGB_TO_XYZ[4] * g + RGB_TO_XYZ[5] * b;
  const z = (RGB_TO_XYZ[6] * r + RGB_TO_XYZ[7] * g + RGB_TO_XYZ[8] * b) / D65_WHITE[2];
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  out[offset] = 116 * fy - 16;
  out[offset + 1] = 500 * (fx - fy);
  out[offset + 2] = 200 * (fy - fz);
  return out;
}

/** 8-bit sRGB integers -> Lab via the lookup table. */
export function srgb8ToLab(r, g, b, out = [0, 0, 0], offset = 0) {
  return linearRgbToLab(SRGB8_TO_LINEAR[r], SRGB8_TO_LINEAR[g], SRGB8_TO_LINEAR[b], out, offset);
}

/** [r,g,b] in 0..255 (integers or not) -> [L,a,b]. */
export function rgbToLab(rgb) {
  const [r, g, b] = rgb;
  if (isByte(r) && isByte(g) && isByte(b)) return srgb8ToLab(r, g, b, [0, 0, 0]);
  return linearRgbToLab(srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255), [0, 0, 0]);
}

/** Lab -> linear RGB (unclamped; out-of-gamut values may fall outside 0..1). */
export function labToLinearRgb(lab) {
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = labFInverse(fx) * D65_WHITE[0];
  const y = labFInverse(fy);
  const z = labFInverse(fz) * D65_WHITE[2];
  return [
    XYZ_TO_RGB[0] * x + XYZ_TO_RGB[1] * y + XYZ_TO_RGB[2] * z,
    XYZ_TO_RGB[3] * x + XYZ_TO_RGB[4] * y + XYZ_TO_RGB[5] * z,
    XYZ_TO_RGB[6] * x + XYZ_TO_RGB[7] * y + XYZ_TO_RGB[8] * z,
  ];
}

/** Linear RGB -> clamped, rounded 8-bit sRGB for display. */
export function linearRgbToSrgb8(r, g, b) {
  return [encodeByte(r), encodeByte(g), encodeByte(b)];
}

/** Lab -> clamped 8-bit sRGB (display approximation for out-of-gamut colors). */
export function labToRgb(lab) {
  const [r, g, b] = labToLinearRgb(lab);
  return linearRgbToSrgb8(r, g, b);
}

export function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) throw new TypeError(`Invalid hex color: ${hex}`);
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb) {
  return '#' + rgb.map((v) => clampByte(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function labChroma(lab) {
  return Math.hypot(lab[1], lab[2]);
}

/** CIELAB hue angle in degrees, normalized to [0, 360). */
export function labHueDegrees(lab) {
  if (lab[1] === 0 && lab[2] === 0) return 0;
  let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  if (h < 0) h += 360;
  return h >= 360 ? h - 360 : h;
}

function encodeByte(c) {
  const clamped = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return Math.round(linearToSrgb(clamped) * 255);
}

function clampByte(v) {
  return Math.min(255, Math.max(0, Math.round(v)));
}

function isByte(v) {
  return Number.isInteger(v) && v >= 0 && v <= 255;
}

function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}
