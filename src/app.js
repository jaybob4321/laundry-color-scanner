/**
 * App controller and state machine (blueprint §11):
 *   Home → Camera | FileDecode → Crop/Analyze → Results → Correction/Reference → Results
 * Browser Back behaves like Cancel. Late decode/worker replies after
 * navigation are ignored. Scan images are transient and released on exit.
 */
import { APP_CONFIG } from './app-config.js';
import { getConfiguredProvider } from './ai/client.js';
import { DetectorClient } from './detector-client.js';
import { createCalibration, isCalibrationUsable } from './detection/calibration.js';
import { DETECTOR_VERSION } from './detection/pipeline.js';
import { clampRoi, defaultRoi, roisOverlap } from './geometry.js';
import { groupingVersion, resolveGroupingRules } from './grouping.js';
import { decodeImageFile, extractRegion, releaseCanvas } from './image-input.js';
import { createPwa } from './pwa.js';
import { createPaletteIndex, validateProfileSet } from './references.js';
import { isValid, validateGroupingSettings } from './schema.js';
import { openStorage } from './storage.js';
import { createAIReviewController } from './ui/ai-review.js';
import { createCameraScreen } from './ui/camera-screen.js';
import { createCorrectionScreen } from './ui/correction-screen.js';
import { createCropScreen } from './ui/crop-screen.js';
import { $, announce, confirmDialog, decorateIcons, toast } from './ui/dom.js';
import { createHomeScreen } from './ui/home-screen.js';
import { errorMessage } from './ui/messages.js';
import { createReferenceScreen } from './ui/reference-screen.js';
import { createResultsScreen } from './ui/results-screen.js';
import { createSettingsScreen } from './ui/settings-screen.js';
import { createId } from './util/ids.js';

const params = new URLSearchParams(location.search);
const DEFAULT_GROUPING = Object.freeze({ familyGroups: {}, colorOverrides: {} });

const app = {
  appConfig: APP_CONFIG,
  detectorVersion: DETECTOR_VERSION,
  config: null,
  palette: null,
  storage: null,
  detector: null,
  pwa: null,
  ai: null,
  aiEnabled: false,
  settings: { grouping: { ...DEFAULT_GROUPING }, debug: false },
  curatedProfiles: [],
  screens: {},
  state: {
    screen: null,
    image: null,
    roi: null,
    patch: null,
    patchEnabled: false,
    calibration: null,
    liveCalibration: null,
    result: null,
    debug: null,
    uncalibrated: null,
    showUncalibrated: false,
    correction: null,
    profiles: [],
  },
};

// ---------- derived helpers used by screens ----------

app.rules = ({ standard = false } = {}) => resolveGroupingRules(app.config.grouping, standard ? null : app.settings.grouping, app.palette);
app.groupingVersion = () => groupingVersion(app.rules());
app.debugEnabled = () => APP_CONFIG.debugAvailable && (app.settings.debug || params.get('debug') === '1');

// ---------- navigation ----------

let suppressPop = false;

app.go = (name, screenParams = {}) => {
  const from = app.state.screen;
  if (from && from !== name) app.screens[from]?.leave?.(name);
  app.state.screen = name;
  for (const section of document.querySelectorAll('main > section[data-screen]')) section.hidden = section.dataset.screen !== name;
  document.body.dataset.activeScreen = name;
  if (name === 'home') {
    if (history.state?.lcs === 'app') {
      suppressPop = true;
      history.back();
    }
  } else if (history.state?.lcs !== 'app') {
    history.pushState({ lcs: 'app' }, '');
  }
  app.screens[name].enter?.(screenParams);
};

window.addEventListener('popstate', () => {
  if (suppressPop) {
    suppressPop = false;
    return;
  }
  // Browser Back = Cancel for whatever is on screen.
  if (busy) {
    busy.cancel();
  } else if (app.state.screen && app.state.screen !== 'home') {
    app.screens[app.state.screen].cancel?.();
  }
  if (app.state.screen !== 'home' && history.state?.lcs !== 'app') history.pushState({ lcs: 'app' }, '');
});

// ---------- busy overlay ----------

let busy = null;

function showBusy(text, onCancel) {
  busy = { cancel: onCancel };
  $('#busy-text').textContent = text;
  $('#busy-overlay').hidden = false;
  $('#btn-busy-cancel').focus();
}

function hideBusy() {
  busy = null;
  $('#busy-overlay').hidden = true;
}

$('#btn-busy-cancel').addEventListener('click', () => busy?.cancel());

// ---------- images ----------

const fileInput = $('#file-input');
let decodeToken = 0;

app.pickFile = () => {
  fileInput.value = '';
  fileInput.click();
};

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  const token = ++decodeToken;
  showBusy('Opening photo…', () => {
    decodeToken++;
    hideBusy();
  });
  try {
    const decoded = await decodeImageFile(file, app.config.input);
    if (token !== decodeToken) {
      releaseCanvas(decoded.canvas);
      return;
    }
    hideBusy();
    // A new upload never inherits a previous photo's or camera's calibration.
    app.clearLiveCalibration();
    app.setImage(
      { id: createId(), source: 'upload', canvas: decoded.canvas, width: decoded.width, height: decoded.height, cameraSessionId: null, torch: false, capturedAt: Date.now() },
      defaultRoi(decoded.width, decoded.height, 0.6),
    );
    app.go('crop');
  } catch (err) {
    if (token !== decodeToken) return;
    hideBusy();
    const message = errorMessage(err?.code ?? 'decode-failed');
    toast(message, { timeout: 8000 });
    announce(message);
  }
});

app.setImage = (image, roi) => {
  app.releaseImage();
  const s = app.state;
  s.image = image;
  s.roi = clampRoi(roi, image.width, image.height, { minPx: app.config.input.minRoiPixels, maxAspect: app.config.input.maxTargetAspect });
  s.patch = null;
  s.patchEnabled = false;
  s.calibration =
    image.source === 'camera' &&
    isCalibrationUsable(s.liveCalibration, { sourceId: image.id, cameraSessionId: image.cameraSessionId, torch: image.torch, now: image.capturedAt })
      ? s.liveCalibration
      : null;
};

app.releaseImage = () => {
  const s = app.state;
  if (s.image) releaseCanvas(s.image.canvas);
  Object.assign(s, { image: null, roi: null, patch: null, patchEnabled: false, calibration: null, result: null, debug: null, uncalibrated: null, showUncalibrated: false, correction: null });
};

app.clearLiveCalibration = () => {
  app.state.liveCalibration = null;
};

function currentCalibration() {
  const { calibration, image } = app.state;
  if (!calibration || !image) return null;
  return isCalibrationUsable(calibration, { sourceId: image.id, cameraSessionId: image.cameraSessionId, torch: image.torch, now: image.capturedAt })
    ? calibration
    : null;
}

// ---------- analysis ----------

/**
 * Run one analysis of the current image. Returns {output} | {error} | {canceled}.
 * `calibration: undefined` means "use the current calibration and re-measure
 * the white reference box if enabled".
 */
async function runAnalysis({ calibration: override } = {}) {
  const s = app.state;
  const image = s.image;
  let canceled = false;
  showBusy('Analyzing colors…', () => {
    canceled = true;
    app.detector.cancel();
    hideBusy();
  });
  try {
    let calibration = override !== undefined ? override : currentCalibration();
    if (override === undefined && s.patchEnabled && s.patch) {
      if (roisOverlap(s.patch, s.roi)) return { error: errorMessage('calibration-overlap') };
      const measurement = await app.detector.calibrate({ extract: () => extractRegion(image.canvas, s.patch, 256) });
      if (canceled) return { canceled: true };
      if (!measurement.ok) return { error: errorMessage(measurement.code) };
      calibration = createCalibration({
        measurement,
        sourceId: image.id,
        cameraSessionId: image.cameraSessionId,
        torch: image.torch,
        now: Date.now(),
        ttlMs: app.config.calibration.liveTtlMs,
      });
      s.calibration = calibration;
    }
    const roi = { ...s.roi };
    const output = await app.detector.analyze({
      extract: () => extractRegion(image.canvas, roi, app.config.input.cropMaxEdge),
      roi,
      source: image.source,
      calibration,
      debug: app.debugEnabled(),
    });
    if (canceled || app.state.image !== image) return { canceled: true };
    return { output };
  } catch (err) {
    if (canceled || err?.code === 'canceled' || err?.code === 'superseded') return { canceled: true };
    if (err?.code === 'version-mismatch') promptReload();
    console.error(err);
    return { error: errorMessage(err?.code ?? 'analysis-failed') };
  } finally {
    if (!canceled) hideBusy();
  }
}

function acceptResult(output) {
  Object.assign(app.state, { result: output.result, debug: output.debug, uncalibrated: null, showUncalibrated: false, correction: null });
}

app.analyzeCurrent = async () => {
  const outcome = await runAnalysis();
  if (outcome.output) {
    acceptResult(outcome.output);
    app.go('results');
  }
  return outcome;
};

app.showCalibrationComparison = async (show) => {
  if (show && !app.state.uncalibrated) {
    const outcome = await runAnalysis({ calibration: null });
    if (!outcome.output) {
      if (outcome.error) toast(outcome.error);
      return;
    }
    app.state.uncalibrated = outcome.output;
  }
  app.state.showUncalibrated = show;
  app.screens.results.render();
};

app.resetCalibration = async () => {
  Object.assign(app.state, { calibration: null, liveCalibration: null, patch: null, patchEnabled: false });
  const outcome = await runAnalysis({ calibration: null });
  if (outcome.output) {
    acceptResult(outcome.output);
    app.screens.results.render({ focus: true });
    toast('Calibration reset.');
  } else if (outcome.error) toast(outcome.error);
};

app.scanAnother = () => {
  if (app.state.image?.source === 'upload') app.pickFile();
  else app.go('camera');
};

function promptReload() {
  confirmDialog({ title: 'App updated', body: errorMessage('version-mismatch'), confirmText: 'Reload' }).then((ok) => {
    if (ok) location.reload();
  });
}

// ---------- settings, profiles, local data ----------

function configureDetector() {
  const profiles = [...app.curatedProfiles, ...app.state.profiles].filter((p) => p.status === 'approved');
  app.detector.configure({ profiles, groupingSettings: app.settings.grouping });
}

app.reloadProfiles = async () => {
  app.state.profiles = await app.storage.listProfiles().catch(() => []);
  configureDetector();
};

app.reloadSettings = async () => {
  const grouping = await app.storage.getSetting('grouping').catch(() => undefined);
  app.settings.grouping = grouping && isValid(validateGroupingSettings, grouping) ? { ...DEFAULT_GROUPING, ...grouping } : { ...DEFAULT_GROUPING };
  app.settings.debug = Boolean(await app.storage.getSetting('debug').catch(() => false));
  if (app.detector) configureDetector();
};

app.updateGroupingSettings = async (next) => {
  validateGroupingSettings(next);
  // Apply for this session even if it can't be saved (storage failures never block scanning).
  app.settings.grouping = { ...DEFAULT_GROUPING, ...next };
  configureDetector();
  app.screens.settings.render();
  await app.storage.setSetting('grouping', app.settings.grouping);
};

app.setDebug = async (on) => {
  app.settings.debug = Boolean(on);
  await app.storage.setSetting('debug', app.settings.debug);
};

app.deleteAllLocalData = async () => {
  await app.storage.deleteAll();
  app.settings = { grouping: { ...DEFAULT_GROUPING }, debug: false };
  app.state.profiles = [];
  app.state.correction = null;
  configureDetector();
};

// ---------- PWA status on Home ----------

function renderPwaStatus() {
  const pwa = app.pwa;
  const chip = $('#offline-status');
  const described = pwa.describe();
  chip.dataset.state = pwa.state.offline;
  chip.textContent = pwa.state.offline === 'ready' ? 'Offline ready' : pwa.state.offline === 'checking' ? 'Checking offline support…' : 'Online only';
  chip.title = described.text;
  $('#update-banner').hidden = !pwa.state.updateReady;
  $('#btn-install').hidden = !described.canInstall;
  $('#install-hint').hidden = !described.installHint;
  $('#install-hint-text').textContent = described.installHint ?? '';
  if (app.state.screen === 'settings') app.screens.settings.render();
}

// ---------- boot ----------

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function boot() {
  decorateIcons();
  try {
    const [config, palette, curated] = await Promise.all([
      fetchJson('data/detector-config.json'),
      fetchJson('data/colors.json'),
      fetchJson('data/reference-profiles.json').catch(() => null),
    ]);
    app.config = config;
    app.paletteJson = palette;
    app.palette = createPaletteIndex(palette);
    app.curatedProfiles = curated ? validateProfileSet(curated).profiles.filter((p) => p.status === 'approved') : [];
  } catch (err) {
    console.error(err);
    $('#privacy-note').textContent = 'The app couldn’t load its color data. Check your connection and reload.';
    $('#btn-scan').disabled = true;
    $('#btn-upload').disabled = true;
    return;
  }

  app.storage = await openStorage();
  await app.reloadSettings();
  app.state.profiles = await app.storage.listProfiles().catch(() => []);

  app.detector = new DetectorClient({ config: app.config, palette: app.paletteJson });
  try {
    await app.detector.start();
  } catch (err) {
    if (err?.code === 'version-mismatch') promptReload();
  }
  configureDetector();

  const provider = getConfiguredProvider(APP_CONFIG.ai, { allowMock: APP_CONFIG.debugAvailable, search: location.search });
  app.aiEnabled = Boolean(provider);
  app.ai = createAIReviewController(app, provider);

  app.pwa = createPwa({ onChange: renderPwaStatus, disabled: APP_CONFIG.debugAvailable && params.get('nosw') === '1' });
  app.screens = {
    home: createHomeScreen(app),
    camera: createCameraScreen(app),
    crop: createCropScreen(app),
    results: createResultsScreen(app),
    correction: createCorrectionScreen(app),
    reference: createReferenceScreen(app),
    settings: createSettingsScreen(app),
  };
  history.replaceState({ lcs: 'home' }, '');
  app.go('home');
  renderPwaStatus();
  app.pwa.init();
  document.documentElement.dataset.ready = 'true';
  if (APP_CONFIG.debugAvailable) window.__lcs = app; // developer inspection hook
}

window.addEventListener('unhandledrejection', (event) => console.error('Unhandled rejection', event.reason));
boot();
