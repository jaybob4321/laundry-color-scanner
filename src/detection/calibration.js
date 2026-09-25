/**
 * Optional white/neutral-reference calibration (blueprint §10).
 *
 * Diagonal white balancing in linear RGB from a matte white or neutral gray
 * patch under the same light. This removes a color cast; it does not
 * normalize exposure, recover clipped colors, or handle mixed illuminants.
 */
import { SRGB8_TO_LINEAR } from '../color/srgb-lab.js';
import { sampleGrid } from './sampling.js';

export const CALIBRATION_SCHEMA_VERSION = 1;

function median(values) {
  const sorted = Float64Array.from(values).sort();
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/**
 * Measure a neutral reference patch. Returns
 *   { ok: true, gains, referenceLinearRgb, metrics } or { ok: false, code, metrics }.
 */
export function measureNeutralReference(rgba, width, height, cfg, alphaMin = 250) {
  const samples = sampleGrid(rgba, width, height, {
    gridWidth: Math.min(cfg.gridSize, width),
    gridHeight: Math.min(cfg.gridSize, height),
    seed: 1,
    alphaMin,
  });
  const n = samples.validCount;
  const metrics = { sampleCount: n };
  if (n < cfg.minSamples) return { ok: false, code: 'calibration-too-few-samples', metrics };

  const enc = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const lin = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  let clipped = 0;
  let v = 0;
  for (let i = 0; i < samples.total; i++) {
    if (!samples.valid[i]) continue;
    let max = 0;
    let min = 255;
    for (let c = 0; c < 3; c++) {
      const value = samples.rgb[i * 3 + c];
      enc[c][v] = value;
      lin[c][v] = SRGB8_TO_LINEAR[value];
      if (value > max) max = value;
      if (value < min) min = value;
    }
    if (max >= 252 || max <= 3) clipped++;
    v++;
  }
  metrics.medianEncoded = enc.map(median);
  metrics.clippedFraction = clipped / n;
  const medLinear = lin.map(median);
  metrics.medianLinear = medLinear;
  metrics.madLinear = lin.map((values, c) => median(values.map((x) => Math.abs(x - medLinear[c]))));

  if (metrics.medianEncoded.some((m) => m < cfg.minMedianEncoded || m > cfg.maxMedianEncoded)) {
    return { ok: false, code: 'calibration-exposure', metrics };
  }
  if (metrics.clippedFraction >= cfg.maxClippedFraction) return { ok: false, code: 'calibration-clipped', metrics };
  if (metrics.madLinear.some((m) => m > cfg.maxMadLinear)) return { ok: false, code: 'calibration-uneven', metrics };

  const mean = (medLinear[0] + medLinear[1] + medLinear[2]) / 3;
  const gains = medLinear.map((m) => mean / m);
  metrics.gains = gains;
  if (gains.some((g) => !(g >= cfg.minGain && g <= cfg.maxGain))) {
    return { ok: false, code: 'calibration-gain-range', metrics };
  }
  return { ok: true, gains, referenceLinearRgb: medLinear, metrics };
}

/** Build the persisted Calibration record from a successful measurement. */
export function createCalibration({ measurement, sourceId, cameraSessionId = null, torch = false, now = Date.now(), ttlMs }) {
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    gains: [...measurement.gains],
    referenceLinearRgb: [...measurement.referenceLinearRgb],
    sourceId,
    cameraSessionId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    torch: Boolean(torch),
  };
}

/** Structural and range validation of a Calibration record. */
export function validateCalibration(cal, cfg) {
  if (!cal || typeof cal !== 'object') return { ok: false, reason: 'missing' };
  if (cal.schemaVersion !== CALIBRATION_SCHEMA_VERSION) return { ok: false, reason: 'schema' };
  if (!Array.isArray(cal.gains) || cal.gains.length !== 3) return { ok: false, reason: 'gains' };
  if (cal.gains.some((g) => !Number.isFinite(g) || g < cfg.minGain || g > cfg.maxGain)) return { ok: false, reason: 'gain-range' };
  if (!Array.isArray(cal.referenceLinearRgb) || cal.referenceLinearRgb.length !== 3) return { ok: false, reason: 'reference' };
  if (cal.referenceLinearRgb.some((v) => !Number.isFinite(v) || v <= 0 || v > 1)) return { ok: false, reason: 'reference-range' };
  if (typeof cal.sourceId !== 'string' || !cal.sourceId) return { ok: false, reason: 'source' };
  if (cal.cameraSessionId !== null && typeof cal.cameraSessionId !== 'string') return { ok: false, reason: 'session' };
  if (Number.isNaN(Date.parse(cal.createdAt)) || Number.isNaN(Date.parse(cal.expiresAt))) return { ok: false, reason: 'dates' };
  if (typeof cal.torch !== 'boolean') return { ok: false, reason: 'torch' };
  return { ok: true };
}

/**
 * A calibration applies to the frame it was measured from, or — for a live
 * camera calibration — to frames from the same camera session with the same
 * torch state until it expires. Never to a different upload.
 */
export function isCalibrationUsable(cal, { sourceId, cameraSessionId = null, torch = false, now = Date.now() }) {
  if (!cal) return false;
  if (cal.sourceId === sourceId) return true;
  return (
    cal.cameraSessionId !== null &&
    cal.cameraSessionId === cameraSessionId &&
    cal.torch === Boolean(torch) &&
    now < Date.parse(cal.expiresAt)
  );
}
