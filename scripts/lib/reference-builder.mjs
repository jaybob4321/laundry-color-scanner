/**
 * Reference-photo preprocessing (blueprint §14). Runs the exact runtime
 * detector modules over curated photos and emits numeric profiles — never
 * the photos. Every record either yields a *pending* profile, a pattern
 * distribution for the report, or an explicit rejection; nothing is dropped
 * silently.
 *
 * Decoder: PNG only, and only plain sRGB (no iCCP / gAMA+cHRM without sRGB,
 * no eXIf orientation). Anything else is rejected with a reason so a
 * color-managed decoder can be chosen deliberately later.
 */
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { deltaE2000Lab } from '../../src/color/delta-e-2000.js';
import { createCalibration } from '../../src/detection/calibration.js';
import { analyzePixels, createDetectorContext, DetectorError, measureCalibrationPatch } from '../../src/detection/pipeline.js';
import { roiToPixels } from '../../src/geometry.js';
import { evaluateProfileCandidate } from '../../src/references.js';
import { decodePNG } from './png.mjs';

const LIGHTING = new Set(['neutral', 'calibrated', 'unknown']);

function fail(message) {
  throw new Error(message);
}

function checkRoi(roi, name) {
  if (!roi || ['x', 'y', 'width', 'height'].some((k) => typeof roi[k] !== 'number' || roi[k] < 0 || roi[k] > 1)) fail(`${name} must be a normalized {x,y,width,height}`);
  if (roi.x + roi.width > 1 || roi.y + roi.height > 1) fail(`${name} extends outside the image`);
}

export function decodeReferenceImage(path) {
  const ext = extname(path).toLowerCase();
  if (ext !== '.png') fail(`unsupported format ${ext || '(none)'}: export the photo as an sRGB PNG`);
  const image = decodePNG(readFileSync(path));
  const chunks = new Set(image.colorChunks);
  if (chunks.has('iCCP')) fail('embedded ICC profile: convert the photo to plain sRGB first');
  if (!chunks.has('sRGB') && (chunks.has('gAMA') || chunks.has('cHRM'))) fail('non-sRGB gamma/chromaticity tags: convert to sRGB first');
  if (chunks.has('eXIf')) fail('EXIF orientation metadata present: export an upright PNG without EXIF');
  return image;
}

/** Crop a normalized region and area-downscale to ≤ maxEdge (like the browser path). */
export function cropRegion(image, roi, maxEdge) {
  const px = roiToPixels(roi, image.width, image.height);
  const scale = Math.min(1, maxEdge / Math.max(px.width, px.height));
  const width = Math.max(1, Math.round(px.width * scale));
  const height = Math.max(1, Math.round(px.height * scale));
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let oy = 0; oy < height; oy++) {
    const y0 = px.y + Math.floor((oy * px.height) / height);
    const y1 = Math.max(y0 + 1, px.y + Math.floor(((oy + 1) * px.height) / height));
    for (let ox = 0; ox < width; ox++) {
      const x0 = px.x + Math.floor((ox * px.width) / width);
      const x1 = Math.max(x0 + 1, px.x + Math.floor(((ox + 1) * px.width) / width));
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * image.width + x) * 4;
          for (let c = 0; c < 4; c++) sum[c] += image.rgba[p + c];
          n++;
        }
      }
      const o = (oy * width + ox) * 4;
      for (let c = 0; c < 4; c++) rgba[o + c] = Math.round(sum[c] / n);
    }
  }
  return { rgba, width, height, sourcePx: { width: px.width, height: px.height } };
}

export function buildReferenceProfiles({ manifest, manifestDir, config, palette, existing = { profiles: [] }, now = Date.now() }) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.records)) fail('manifest must be {schemaVersion: 1, records: [...]}');
  const ctx = createDetectorContext({ config, palette, makeId: () => 'build', now: () => now });
  const report = { generatedAt: new Date(now).toISOString(), accepted: [], patterns: [], rejected: [] };
  const profiles = [];
  const seen = new Set();
  for (const record of manifest.records) {
    const entry = { id: record?.id, image: record?.image, colorId: record?.colorId };
    try {
      if (typeof record.id !== 'string' || !/^[a-z0-9-]+$/.test(record.id)) fail('id must be lowercase letters, digits and dashes');
      if (seen.has(record.id)) fail('duplicate id');
      seen.add(record.id);
      if (!ctx.paletteIndex.byId.has(record.colorId)) fail(`unknown colorId ${record.colorId}`);
      if (!LIGHTING.has(record.lighting)) fail('lighting must be neutral, calibrated or unknown');
      if (!record.license || !record.provenance) fail('license and provenance are required');
      checkRoi(record.garmentRoi, 'garmentRoi');
      if (record.neutralRoi) checkRoi(record.neutralRoi, 'neutralRoi');
      if (record.lighting === 'calibrated' && !record.neutralRoi) fail('calibrated lighting needs a neutralRoi');

      const image = decodeReferenceImage(resolve(manifestDir, record.image));
      let calibration = null;
      if (record.neutralRoi) {
        const measurement = measureCalibrationPatch(cropRegion(image, record.neutralRoi, 256), ctx);
        if (!measurement.ok) fail(`neutral reference rejected (${measurement.code})`);
        calibration = createCalibration({ measurement, sourceId: record.id, now, ttlMs: config.calibration.liveTtlMs });
      }
      const crop = cropRegion(image, record.garmentRoi, config.input.cropMaxEdge);
      const { result } = analyzePixels({ ...crop, sourceRoiPx: crop.sourcePx, roi: record.garmentRoi, source: 'upload', calibration }, ctx);
      entry.clusters = result.clusters.map((c) => ({ fraction: +c.fraction.toFixed(4), lab: c.lab.map((v) => +v.toFixed(3)), nearest: c.matches[0].colorId }));
      if (result.patternStatus !== 'single') {
        report.patterns.push({ ...entry, patternStatus: result.patternStatus });
        continue;
      }
      const evaluation = evaluateProfileCandidate({
        result,
        colorId: record.colorId,
        captureCondition: record.lighting,
        paletteIndex: ctx.paletteIndex,
        existingProfiles: [],
        config,
        distance: deltaE2000Lab,
        makeId: () => `curated-${record.id}`,
        now,
      });
      const failed = evaluation.gates.filter((g) => !g.pass).map((g) => g.id);
      if (evaluation.blocked) fail(`quality gates failed: ${failed.join(', ')}`);
      const profile = { ...evaluation.profile, source: 'curated', status: 'pending' };
      // Keep a curator's approval only if the measurement is unchanged.
      const previous = existing.profiles.find((p) => p.id === profile.id);
      if (previous?.status === 'approved' && deltaE2000Lab(previous.lab, profile.lab) < 0.5 && !failed.length) profile.status = 'approved';
      profiles.push(profile);
      report.accepted.push({
        ...entry,
        profileId: profile.id,
        status: profile.status,
        seedDistance: +evaluation.seedDistance.toFixed(2),
        needsPaletteReview: evaluation.seedDistance > config.profiles.maxSeedDistance,
        notQualifiedFor: failed,
      });
    } catch (err) {
      if (err instanceof DetectorError) report.rejected.push({ ...entry, reason: `detector: ${err.code}` });
      else report.rejected.push({ ...entry, reason: err.message });
    }
  }
  const manifestIds = new Set(profiles.map((p) => p.id));
  const kept = existing.profiles.filter((p) => !manifestIds.has(p.id) && !seen.has(p.id.replace(/^curated-/, '')));
  return {
    profileSet: {
      schemaVersion: 1,
      profileSetVersion: `curated-${new Date(now).toISOString().slice(0, 10)}-${kept.length + profiles.length}`,
      description: existing.description ?? 'Curator-approved numeric reference profiles (CIELAB-D65-2deg).',
      profiles: [...kept, ...profiles],
    },
    report,
  };
}

export function loadManifest(path) {
  return { manifest: JSON.parse(readFileSync(path, 'utf8')), manifestDir: dirname(resolve(path)) };
}
