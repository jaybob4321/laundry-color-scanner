/**
 * Camera screen: live rear-camera preview with a centered target, Capture,
 * Flash (torch, only when advertised), Calibrate (live white reference) and
 * Cancel. Tracks stop whenever the screen is left or the page is hidden.
 */
import { CameraError, openCamera, setTorch, stopCamera } from '../camera.js';
import { createCalibration } from '../detection/calibration.js';
import { centeredSquare, viewRectToSourceRoi } from '../geometry.js';
import { captureVideoFrame, context2d, createCanvas, extractRegion, releaseCanvas } from '../image-input.js';
import { assessFrame } from '../live-feedback.js';
import { createId } from '../util/ids.js';
import { $, announce } from './dom.js';
import { errorMessage } from './messages.js';

const TARGET_FRACTION = 0.6;

export function createCameraScreen(app) {
  const video = $('#camera-video');
  const stage = $('#camera-stage');
  const target = $('#camera-target');
  const captureBtn = $('#btn-capture');
  const torchBtn = $('#btn-torch');
  const calibrateBtn = $('#btn-calibrate');
  const instruction = $('#camera-instruction');
  const feedback = $('#camera-feedback');
  const calChip = $('#camera-calibration');
  const message = $('#camera-message');

  let camera = null;
  let opening = null;
  let calibrating = false;
  let busy = false;
  let feedbackTimer = 0;
  let chipTimer = 0;
  let active = false;
  const probe = createCanvas(32, 32);

  const targetRect = () => centeredSquare({ width: stage.clientWidth, height: stage.clientHeight }, TARGET_FRACTION);

  function layoutTarget() {
    const r = targetRect();
    Object.assign(target.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
  }
  new ResizeObserver(layoutTarget).observe(stage);

  function sourceRoi() {
    return viewRectToSourceRoi(
      targetRect(),
      { width: stage.clientWidth, height: stage.clientHeight },
      { width: video.videoWidth, height: video.videoHeight },
      { fit: 'cover' },
    );
  }

  function showMessage(code) {
    message.hidden = false;
    $('#camera-message-title').textContent = code === 'permission-denied' ? 'Camera access blocked' : 'Camera unavailable';
    $('#camera-message-text').textContent = errorMessage(code);
    captureBtn.disabled = true;
    calibrateBtn.disabled = true;
    torchBtn.hidden = true;
    announce(errorMessage(code));
  }

  function setCalibrating(on) {
    calibrating = on;
    calibrateBtn.setAttribute('aria-pressed', String(on));
    target.dataset.mode = on ? 'calibrate' : '';
    captureBtn.dataset.mode = on ? 'calibrate' : '';
    captureBtn.setAttribute('aria-label', on ? 'Set white reference' : 'Capture');
    instruction.textContent = on
      ? 'Aim the target at a matte white or gray card in the same light, then tap the button.'
      : 'Fill the target with fabric; avoid skin and background.';
  }

  function updateCalibrationChip() {
    clearInterval(chipTimer);
    const cal = app.state.liveCalibration;
    if (!cal) {
      calChip.hidden = true;
      return;
    }
    const tick = () => {
      const left = Math.max(0, Date.parse(cal.expiresAt) - Date.now());
      if (!left) {
        app.clearLiveCalibration();
        updateCalibrationChip();
        announce('Calibration expired.');
        return;
      }
      const s = Math.ceil(left / 1000);
      calChip.textContent = `Calibrated · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · Recalibrate if lighting changes`;
    };
    calChip.hidden = false;
    tick();
    chipTimer = setInterval(tick, 1000);
  }

  function startFeedback() {
    clearInterval(feedbackTimer);
    const { intervalMs, gridSize } = app.config.liveFeedback;
    probe.width = gridSize;
    probe.height = gridSize;
    const ctx = context2d(probe, { willReadFrequently: true });
    feedbackTimer = setInterval(() => {
      if (!camera || busy || !video.videoWidth || document.hidden) return;
      const roi = sourceRoi();
      ctx.drawImage(
        video,
        roi.x * video.videoWidth,
        roi.y * video.videoHeight,
        roi.width * video.videoWidth,
        roi.height * video.videoHeight,
        0,
        0,
        gridSize,
        gridSize,
      );
      const { status, message: text } = assessFrame(ctx.getImageData(0, 0, gridSize, gridSize).data, gridSize, gridSize);
      if (feedback.dataset.status !== status) {
        feedback.dataset.status = status;
        feedback.textContent = text;
      }
    }, intervalMs);
  }

  async function open() {
    if (opening) return opening;
    message.hidden = true;
    captureBtn.disabled = true;
    feedback.textContent = '';
    opening = (async () => {
      try {
        const cam = await openCamera();
        if (!active) {
          stopCamera(cam);
          return;
        }
        camera = cam;
        video.srcObject = cam.stream;
        await video.play().catch(() => {});
        torchBtn.hidden = !cam.torchSupported;
        torchBtn.setAttribute('aria-pressed', 'false');
        captureBtn.disabled = false;
        calibrateBtn.disabled = false;
        startFeedback();
      } catch (err) {
        showMessage(err instanceof CameraError ? err.code : 'camera-failed');
      } finally {
        opening = null;
      }
    })();
    return opening;
  }

  function close() {
    clearInterval(feedbackTimer);
    stopCamera(camera);
    camera = null;
    video.srcObject = null;
  }

  async function capture() {
    if (busy || !camera) return;
    busy = true;
    captureBtn.disabled = true;
    try {
      const roi = sourceRoi();
      if (calibrating) {
        await calibrateFromLive(roi);
        return;
      }
      const frame = captureVideoFrame(video);
      const image = {
        id: createId(),
        source: 'camera',
        canvas: frame.canvas,
        width: frame.width,
        height: frame.height,
        cameraSessionId: camera.sessionId,
        torch: camera.torch,
        capturedAt: Date.now(),
      };
      close();
      app.setImage(image, roi);
      app.go('crop', { autoAnalyze: true });
    } catch (err) {
      announce(errorMessage(err?.code ?? 'camera-failed'));
    } finally {
      busy = false;
      if (camera) captureBtn.disabled = false;
    }
  }

  async function calibrateFromLive(roi) {
    const frame = captureVideoFrame(video);
    try {
      const measurement = await app.detector.calibrate({ extract: () => extractRegion(frame.canvas, roi, 256) });
      if (!measurement.ok) {
        feedback.textContent = errorMessage(measurement.code);
        announce(errorMessage(measurement.code));
        return;
      }
      app.state.liveCalibration = createCalibration({
        measurement,
        sourceId: `live-${createId()}`,
        cameraSessionId: camera.sessionId,
        torch: camera.torch,
        now: Date.now(),
        ttlMs: app.config.calibration.liveTtlMs,
      });
      setCalibrating(false);
      updateCalibrationChip();
      feedback.textContent = 'White reference set. Now aim at the garment.';
      announce('Calibrated. Now aim the target at the garment and capture.');
    } finally {
      releaseCanvas(frame.canvas);
    }
  }

  captureBtn.addEventListener('click', capture);
  $('#btn-camera-cancel').addEventListener('click', () => app.go('home'));
  $('#btn-camera-retry').addEventListener('click', () => open());
  $('#btn-camera-upload').addEventListener('click', () => app.pickFile());
  $('#btn-camera-upload-alt').addEventListener('click', () => app.pickFile());
  calibrateBtn.addEventListener('click', () => {
    if (app.state.liveCalibration && !calibrating) {
      app.clearLiveCalibration();
      updateCalibrationChip();
    }
    setCalibrating(!calibrating);
  });
  torchBtn.addEventListener('click', async () => {
    if (!camera?.torchSupported) return;
    const next = !camera.torch;
    try {
      await setTorch(camera, next);
      torchBtn.setAttribute('aria-pressed', String(next));
      // A torch change alters the light: any live calibration no longer applies.
      if (app.state.liveCalibration) {
        app.clearLiveCalibration();
        updateCalibrationChip();
        announce('Flash changed. Calibration cleared.');
      }
    } catch {
      torchBtn.hidden = true;
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!active) return;
    if (document.hidden) {
      close();
      // Backgrounding ends the camera session's calibration (blueprint §10).
      app.clearLiveCalibration();
      updateCalibrationChip();
    } else open();
  });

  return {
    enter() {
      active = true;
      setCalibrating(false);
      layoutTarget();
      updateCalibrationChip();
      open();
    },
    leave() {
      active = false;
      clearInterval(chipTimer);
      close();
      // A new camera session gets a new id, so its calibration can't carry over.
      app.clearLiveCalibration();
    },
    cancel() {
      if (calibrating) setCalibrating(false);
      else app.go('home');
    },
  };
}
