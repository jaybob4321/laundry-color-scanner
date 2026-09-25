/**
 * Detector worker (blueprint §2). All numeric processing happens here; the
 * main thread only captures, crops and renders.
 *
 * Messages in:
 *   {type:'configure', requestId, profiles, groupingSettings}
 *   {type:'analyze', requestId, rgba:ArrayBuffer, width, height, roi, sourceRoiPx,
 *    source, calibration, configVersion, paletteVersion, debug}
 *   {type:'calibrate', requestId, rgba:ArrayBuffer, width, height, configVersion}
 * Messages out:
 *   {type:'ready', configVersion, paletteVersion} | {type:'init-error', message}
 *   {type:'result', requestId, payload} | {type:'error', requestId, code, message}
 */
import { analyzePixels, createDetectorContext, measureCalibrationPatch } from '../detection/pipeline.js';

let config = null;
let palette = null;
let ctx = null;
let settings = { profiles: [], groupingSettings: null };

async function fetchJson(path) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const ready = (async () => {
  [config, palette] = await Promise.all([fetchJson('../../data/detector-config.json'), fetchJson('../../data/colors.json')]);
  ctx = createDetectorContext({ config, palette, ...settings });
  self.postMessage({ type: 'ready', configVersion: config.configVersion, paletteVersion: palette.paletteVersion });
})();
ready.catch((err) => self.postMessage({ type: 'init-error', message: String(err?.message ?? err) }));

function checkVersions(msg) {
  if (msg.configVersion !== config.configVersion || (msg.paletteVersion && msg.paletteVersion !== palette.paletteVersion)) {
    const err = new Error('Detector and app versions differ');
    err.code = 'version-mismatch';
    throw err;
  }
}

function transferablesOf(debug) {
  if (!debug) return [];
  return [debug.samplePositions, debug.sampleLabels, debug.artifactMask, debug.diagnosticLabels].filter(Boolean).map((a) => a.buffer);
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    await ready;
    switch (msg.type) {
      case 'configure': {
        // Fire-and-forget from the client; later messages see the new context.
        settings = { profiles: msg.profiles ?? [], groupingSettings: msg.groupingSettings ?? null };
        ctx = createDetectorContext({ config, palette, ...settings });
        break;
      }
      case 'analyze': {
        checkVersions(msg);
        const output = analyzePixels(
          {
            rgba: new Uint8ClampedArray(msg.rgba),
            width: msg.width,
            height: msg.height,
            roi: msg.roi,
            sourceRoiPx: msg.sourceRoiPx,
            source: msg.source,
            calibration: msg.calibration ?? null,
          },
          ctx,
          { debug: Boolean(msg.debug) },
        );
        self.postMessage({ type: 'result', requestId: msg.requestId, payload: output }, transferablesOf(output.debug));
        break;
      }
      case 'calibrate': {
        checkVersions(msg);
        const measurement = measureCalibrationPatch({ rgba: new Uint8ClampedArray(msg.rgba), width: msg.width, height: msg.height }, ctx);
        self.postMessage({ type: 'result', requestId: msg.requestId, payload: measurement });
        break;
      }
      default:
        throw Object.assign(new Error(`Unknown message ${msg.type}`), { code: 'invalid-input' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', requestId: msg.requestId, code: err?.code ?? 'internal', message: String(err?.message ?? err) });
  }
};
