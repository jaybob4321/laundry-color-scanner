/**
 * Crop/review: the captured or uploaded image with a movable fabric target
 * and an optional white-reference box (same-frame calibration, §10).
 * Camera captures analyze the default target immediately; uploads always
 * let the user confirm the target first (§11).
 */
import { $, announce, clear } from './dom.js';
import { numericFields, RegionEditor } from './region-editor.js';

export function createCropScreen(app) {
  const stage = $('#crop-stage');
  const box = $('#crop-image');
  const errorEl = $('#crop-error');
  const patchBtn = $('#btn-toggle-patch');
  const patchHint = $('#patch-hint');
  const numeric = $('#numeric-crop-fields');
  let garment = null;
  let patch = null;
  let returnTo = 'home';

  function layout() {
    const image = app.state.image;
    if (!image) return;
    const s = Math.min(stage.clientWidth / image.width, stage.clientHeight / image.height);
    box.style.width = `${Math.floor(image.width * s)}px`;
    box.style.height = `${Math.floor(image.height * s)}px`;
  }
  new ResizeObserver(layout).observe(stage);

  function showError(text) {
    errorEl.textContent = text ?? '';
    errorEl.hidden = !text;
  }

  function renderNumeric() {
    clear(numeric);
    const g = numericFields(garment, 'Fabric target');
    garment.onChange = (roi) => {
      app.state.roi = roi;
      g.sync(roi);
      showError(null);
    };
    numeric.append(g.element);
    if (patch) {
      const p = numericFields(patch, 'White reference');
      patch.onChange = (roi) => {
        app.state.patch = roi;
        p.sync(roi);
        showError(null);
      };
      numeric.append(p.element);
    }
  }

  function setPatch(enabled) {
    const image = app.state.image;
    app.state.patchEnabled = enabled;
    patchBtn.setAttribute('aria-pressed', String(enabled));
    patchBtn.lastChild.textContent = enabled ? 'Remove white reference' : 'Add white reference';
    patchHint.hidden = !enabled;
    patch?.remove();
    patch = null;
    if (enabled) {
      const side = Math.min(image.width, image.height) * 0.18;
      app.state.patch ??= { x: 0.03, y: 1 - 0.03 - side / image.height, width: side / image.width, height: side / image.height };
      patch = new RegionEditor({
        container: box,
        imageSize: image,
        roi: app.state.patch,
        kind: 'patch',
        label: 'White reference',
        description: 'Place on a matte white or gray card. Arrow keys move it; Shift plus arrow keys resize it.',
        minPx: app.config.input.minPatchPixels,
        maxAspect: app.config.input.maxTargetAspect,
      });
    } else {
      // Removing the reference drops any calibration measured from this frame.
      if (app.state.calibration?.sourceId === image.id) app.state.calibration = null;
    }
    renderNumeric();
  }

  patchBtn.addEventListener('click', () => setPatch(!app.state.patchEnabled));
  $('#btn-crop-analyze').addEventListener('click', () => analyze());
  $('#btn-crop-cancel').addEventListener('click', () => cancel());
  $('#btn-crop-retake').addEventListener('click', () => {
    if (app.state.image?.source === 'camera') app.go('camera');
    else app.pickFile();
  });

  async function analyze() {
    showError(null);
    const outcome = await app.analyzeCurrent();
    if (outcome?.error) {
      showError(outcome.error);
      announce(outcome.error);
    }
  }

  function cancel() {
    if (returnTo === 'results' && app.state.result) {
      app.state.roi = app.state.result.roi;
      app.go('results');
    } else if (app.state.image?.source === 'camera') app.go('camera');
    else app.go('home');
  }

  return {
    enter(params = {}) {
      const image = app.state.image;
      returnTo = params.returnTo ?? 'home';
      showError(params.error ?? null);
      $('#btn-crop-retake').textContent = image.source === 'camera' ? 'Retake' : 'Choose another';
      clear(box);
      image.canvas.setAttribute('aria-hidden', 'true');
      box.append(image.canvas);
      layout();
      garment = new RegionEditor({
        container: box,
        imageSize: image,
        roi: app.state.roi,
        kind: 'garment',
        label: 'Fabric',
        description: 'Fabric target. Arrow keys move it; Shift plus arrow keys resize it.',
        minPx: app.config.input.minRoiPixels,
        maxAspect: app.config.input.maxTargetAspect,
      });
      app.state.roi = garment.roi;
      patch = null;
      setPatch(Boolean(app.state.patchEnabled));
      if (params.autoAnalyze) analyze();
      else garment.el.focus({ preventScroll: true });
    },
    leave() {
      garment?.remove();
      patch?.remove();
      garment = null;
      patch = null;
    },
    cancel,
  };
}
