/**
 * Rear-camera access (blueprint §3.1, §11, §15). Video only — the microphone
 * is never requested. Tracks are stopped whenever the camera screen is left.
 */
import { createId } from './util/ids.js';

export class CameraError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'CameraError';
    this.code = code;
    this.cause = cause;
  }
}

const PREFERRED = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
};
const BASIC = { audio: false, video: true };

export function cameraSupported() {
  return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia);
}

function classify(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new CameraError('permission-denied', err);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CameraError('no-camera', err);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new CameraError('camera-busy', err);
    case 'SecurityError':
      return new CameraError('insecure-context', err);
    default:
      return new CameraError('camera-failed', err);
  }
}

/**
 * Open the camera, preferring the rear camera at 1280x720 and retrying with
 * basic constraints if the preferred ones are rejected. Permission errors
 * are not retried.
 */
export async function openCamera() {
  if (globalThis.isSecureContext === false) throw new CameraError('insecure-context');
  if (!cameraSupported()) throw new CameraError('unsupported');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(PREFERRED);
  } catch (err) {
    const classified = classify(err);
    if (classified.code === 'permission-denied' || classified.code === 'insecure-context') throw classified;
    try {
      stream = await navigator.mediaDevices.getUserMedia(BASIC);
    } catch (retryErr) {
      throw classify(retryErr);
    }
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CameraError('no-camera');
  }
  const capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
  return {
    stream,
    track,
    sessionId: createId(),
    torchSupported: Boolean(capabilities.torch),
    torch: false,
    facingMode: settings.facingMode ?? null,
  };
}

/** Continuous torch; only called when the track advertises torch support. */
export async function setTorch(camera, on) {
  await camera.track.applyConstraints({ advanced: [{ torch: Boolean(on) }] });
  camera.torch = Boolean(on);
}

export function stopCamera(camera) {
  if (!camera) return;
  for (const track of camera.stream.getTracks()) track.stop();
}
