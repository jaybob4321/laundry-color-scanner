/**
 * Runtime validation for persisted and imported records (blueprint §12).
 * Rejects NaN, Infinity, out-of-range values and unknown schema versions.
 * Validators throw ValidationError with a path; `isValid*` helpers wrap them.
 */
import { GROUP_IDS } from './grouping.js';

export class ValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'ValidationError';
    this.path = path;
  }
}

const GROUP_SET = new Set(GROUP_IDS);
const PATTERN_STATUSES = new Set(['single', 'multicolor', 'ambiguous']);
export const MAX_NOTE_LENGTH = 500;

function fail(path, message) {
  throw new ValidationError(path, message);
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  return value;
}

function string(value, path, { max = 200, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(path, 'expected a string');
  if (!allowEmpty && !value) fail(path, 'must not be empty');
  if (value.length > max) fail(path, `longer than ${max} characters`);
  return value;
}

function number(value, path, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  if (value < min || value > max) fail(path, `out of range [${min}, ${max}]`);
  return value;
}

function nullableNumber(value, path, min, max) {
  return value === null ? null : number(value, path, min, max);
}

function isoDate(value, path) {
  string(value, path, { max: 40 });
  if (Number.isNaN(Date.parse(value))) fail(path, 'expected an ISO date');
  return value;
}

function oneOf(value, allowed, path) {
  if (!allowed.has(value)) fail(path, `unexpected value ${JSON.stringify(value)}`);
  return value;
}

function schemaVersion(value, path) {
  if (value !== 1) fail(path, `unsupported schema version ${JSON.stringify(value)}`);
}

export function validateLab(lab, path = 'lab') {
  if (!Array.isArray(lab) || lab.length !== 3) fail(path, 'expected [L,a,b]');
  number(lab[0], `${path}[0]`, 0, 100.5);
  number(lab[1], `${path}[1]`, -200, 200);
  number(lab[2], `${path}[2]`, -200, 200);
  return lab;
}

export function validateRgb(rgb, path = 'rgb') {
  if (!Array.isArray(rgb) || rgb.length !== 3) fail(path, 'expected [r,g,b]');
  rgb.forEach((v, i) => {
    number(v, `${path}[${i}]`, 0, 255);
    if (!Number.isInteger(v)) fail(`${path}[${i}]`, 'expected an integer');
  });
  return rgb;
}

function validateRoi(roi, path) {
  object(roi, path);
  for (const key of ['x', 'y', 'width', 'height']) number(roi[key], `${path}.${key}`, 0, 1);
  if (roi.x + roi.width > 1.000001 || roi.y + roi.height > 1.000001) fail(path, 'extends outside the image');
}

export function validateCalibrationRecord(cal, path = 'calibration') {
  object(cal, path);
  schemaVersion(cal.schemaVersion, `${path}.schemaVersion`);
  if (!Array.isArray(cal.gains) || cal.gains.length !== 3) fail(`${path}.gains`, 'expected 3 gains');
  cal.gains.forEach((g, i) => number(g, `${path}.gains[${i}]`, 0.01, 100));
  if (!Array.isArray(cal.referenceLinearRgb) || cal.referenceLinearRgb.length !== 3) fail(`${path}.referenceLinearRgb`, 'expected 3 values');
  cal.referenceLinearRgb.forEach((v, i) => number(v, `${path}.referenceLinearRgb[${i}]`, 0, 1));
  string(cal.sourceId, `${path}.sourceId`);
  if (cal.cameraSessionId !== null) string(cal.cameraSessionId, `${path}.cameraSessionId`);
  isoDate(cal.createdAt, `${path}.createdAt`);
  isoDate(cal.expiresAt, `${path}.expiresAt`);
  if (typeof cal.torch !== 'boolean') fail(`${path}.torch`, 'expected a boolean');
  return cal;
}

function validateCluster(cluster, path) {
  object(cluster, path);
  validateLab(cluster.lab, `${path}.lab`);
  validateRgb(cluster.rgb, `${path}.rgb`);
  number(cluster.fraction, `${path}.fraction`, 0, 1);
  number(cluster.spreadMedianDE00, `${path}.spreadMedianDE00`, 0, 500);
  if (!Array.isArray(cluster.matches)) fail(`${path}.matches`, 'expected an array');
  cluster.matches.forEach((m, i) => {
    object(m, `${path}.matches[${i}]`);
    string(m.colorId, `${path}.matches[${i}].colorId`, { max: 80 });
    number(m.distance, `${path}.matches[${i}].distance`, 0, 1000);
    oneOf(m.source, new Set(['seed', 'profile']), `${path}.matches[${i}].source`);
  });
  nullableNumber(cluster.confidence, `${path}.confidence`, 0, 100);
  if (cluster.laundryGroup !== undefined) oneOf(cluster.laundryGroup, GROUP_SET, `${path}.laundryGroup`);
}

export function validateScanResult(result, path = 'result') {
  object(result, path);
  schemaVersion(result.schemaVersion, `${path}.schemaVersion`);
  string(result.id, `${path}.id`, { max: 80 });
  isoDate(result.createdAt, `${path}.createdAt`);
  for (const key of ['detectorVersion', 'configVersion', 'paletteVersion', 'groupingVersion', 'profileSetVersion']) {
    string(result[key], `${path}.${key}`, { max: 80 });
  }
  oneOf(result.source, new Set(['camera', 'upload']), `${path}.source`);
  validateRoi(result.roi, `${path}.roi`);
  if (result.calibration !== null) validateCalibrationRecord(result.calibration, `${path}.calibration`);
  if (!Array.isArray(result.clusters) || result.clusters.length < 1 || result.clusters.length > 10) {
    fail(`${path}.clusters`, 'expected 1..10 clusters');
  }
  result.clusters.forEach((c, i) => validateCluster(c, `${path}.clusters[${i}]`));
  if (result.detectedColorId !== null) string(result.detectedColorId, `${path}.detectedColorId`, { max: 80 });
  oneOf(result.patternStatus, PATTERN_STATUSES, `${path}.patternStatus`);
  oneOf(result.laundryGroup, GROUP_SET, `${path}.laundryGroup`);
  nullableNumber(result.confidence, `${path}.confidence`, 0, 100);
  nullableNumber(result.groupConfidence, `${path}.groupConfidence`, 0, 100);
  if (result.confidenceKind !== 'heuristic') fail(`${path}.confidenceKind`, 'must be "heuristic"');
  if (!Array.isArray(result.qualityFlags)) fail(`${path}.qualityFlags`, 'expected an array');
  result.qualityFlags.forEach((f, i) => string(f, `${path}.qualityFlags[${i}]`, { max: 60 }));
  number(result.sampleCount, `${path}.sampleCount`, 0, 1e6);
  object(result.qualityMetrics, `${path}.qualityMetrics`);
  for (const [k, v] of Object.entries(result.qualityMetrics)) number(v, `${path}.qualityMetrics.${k}`);
  return result;
}

export function validateCorrection(correction, path = 'correction') {
  object(correction, path);
  schemaVersion(correction.schemaVersion, `${path}.schemaVersion`);
  string(correction.id, `${path}.id`, { max: 80 });
  isoDate(correction.createdAt, `${path}.createdAt`);
  validateScanResult(correction.original, `${path}.original`);
  object(correction.corrected, `${path}.corrected`);
  if (correction.corrected.colorId !== null) string(correction.corrected.colorId, `${path}.corrected.colorId`, { max: 80 });
  oneOf(correction.corrected.laundryGroup, GROUP_SET, `${path}.corrected.laundryGroup`);
  oneOf(correction.corrected.patternStatus, new Set(['single', 'multicolor', 'unknown']), `${path}.corrected.patternStatus`);
  string(correction.note, `${path}.note`, { max: MAX_NOTE_LENGTH, allowEmpty: true });
  if (correction.usedForLearning !== false) fail(`${path}.usedForLearning`, 'must be false');
  return correction;
}

export function validateProfile(profile, path = 'profile') {
  object(profile, path);
  schemaVersion(profile.schemaVersion, `${path}.schemaVersion`);
  string(profile.id, `${path}.id`, { max: 80 });
  string(profile.colorId, `${path}.colorId`, { max: 80 });
  validateLab(profile.lab, `${path}.lab`);
  number(profile.spreadMedianDE00, `${path}.spreadMedianDE00`, 0, 500);
  oneOf(profile.source, new Set(['user', 'curated']), `${path}.source`);
  oneOf(profile.status, new Set(['pending', 'approved', 'disabled']), `${path}.status`);
  oneOf(profile.captureCondition, new Set(['neutral', 'calibrated', 'unknown']), `${path}.captureCondition`);
  if (profile.colorSpace !== 'CIELAB-D65-2deg') fail(`${path}.colorSpace`, 'must be CIELAB-D65-2deg');
  string(profile.detectorVersion, `${path}.detectorVersion`, { max: 40 });
  isoDate(profile.createdAt, `${path}.createdAt`);
  number(profile.sampleCount, `${path}.sampleCount`, 1, 1e7);
  if (!Number.isInteger(profile.sampleCount)) fail(`${path}.sampleCount`, 'expected an integer');
  return profile;
}

/** Settings stored under name 'grouping'. */
export function validateGroupingSettings(settings, path = 'grouping') {
  object(settings, path);
  for (const key of ['familyGroups', 'colorOverrides']) {
    if (settings[key] === undefined) continue;
    object(settings[key], `${path}.${key}`);
    for (const [k, v] of Object.entries(settings[key])) {
      string(k, `${path}.${key} key`, { max: 80 });
      oneOf(v, GROUP_SET, `${path}.${key}.${k}`);
    }
  }
  return settings;
}

export function isValid(validator, value) {
  try {
    validator(value);
    return true;
  } catch (err) {
    if (err instanceof ValidationError) return false;
    throw err;
  }
}
