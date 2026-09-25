/**
 * Image decoding and pixel extraction (blueprint §3.4–3.6).
 *
 * - Decoding goes through the browser's color-managed pipeline into an sRGB
 *   canvas; Display-P3 or tagged images are converted, never reinterpreted.
 * - EXIF orientation is applied exactly once, by the browser's decoder
 *   (`image-orientation: from-image` is the platform default). We never
 *   rotate pixels ourselves.
 * - Only a bounded working copy (≤ workingMaxEdge) is kept while a scan is
 *   on screen; nothing is stored.
 */
import { roiToPixels } from './geometry.js';

export class InputError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'InputError';
    this.code = code;
    this.cause = cause;
  }
}

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 2D context explicitly in sRGB where the browser supports color spaces. */
export function context2d(canvas, { willReadFrequently = false } = {}) {
  return canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently }) ?? canvas.getContext('2d');
}

/** Free a canvas's backing store promptly (large canvases pressure iOS memory). */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function isHeic(file) {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name ?? '');
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new InputError('decode-failed'));
    img.src = url;
  });
}

/** createImageBitmap resize-on-decode, verified by checking the output size. */
async function decodeResized(file, width, height) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
    if (bitmap.width === width && bitmap.height === height) return bitmap;
    bitmap.close();
  } catch {
    // Unsupported options or decode failure: caller rejects the file.
  }
  return null;
}

/**
 * Decode an uploaded photo into a working sRGB canvas.
 * Resolves { canvas, width, height, originalWidth, originalHeight }.
 */
export async function decodeImageFile(file, inputCfg) {
  if (!file) throw new InputError('no-file');
  if (file.size > inputCfg.maxFileBytes) throw new InputError('file-too-large');
  if (file.type && !file.type.startsWith('image/')) throw new InputError('unsupported-format');
  const url = URL.createObjectURL(file);
  let bitmap = null;
  let img = null;
  try {
    img = await loadImage(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new InputError('decode-failed');
    const scale = Math.min(1, inputCfg.workingMaxEdge / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    let source = img;
    if (w * h > inputCfg.maxMegapixels * 1e6) {
      bitmap = await decodeResized(file, tw, th);
      if (!bitmap) throw new InputError('image-too-large');
      source = bitmap;
    }
    const canvas = createCanvas(tw, th);
    const ctx = context2d(canvas);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, tw, th);
    return { canvas, width: tw, height: th, originalWidth: w, originalHeight: h };
  } catch (err) {
    if (err instanceof InputError && err.code !== 'decode-failed') throw err;
    if (isHeic(file)) throw new InputError('unsupported-format-heic', err);
    if (err?.name === 'RangeError' || /memory/i.test(String(err?.message))) throw new InputError('out-of-memory', err);
    throw err instanceof InputError ? err : new InputError('decode-failed', err);
  } finally {
    bitmap?.close?.();
    if (img) img.src = '';
    URL.revokeObjectURL(url);
  }
}

/** Snapshot the current video frame at its native resolution. */
export function captureVideoFrame(video) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new InputError('camera-not-ready');
  const canvas = createCanvas(width, height);
  context2d(canvas).drawImage(video, 0, 0, width, height);
  return { canvas, width, height };
}

/**
 * Extract a normalized region as RGBA, downscaled so its longest edge is at
 * most maxEdge. Returns { rgba, width, height, sourcePx } where sourcePx is
 * the region's size in working-image pixels (used for the 64×64 minimum).
 */
export function extractRegion(sourceCanvas, roi, maxEdge) {
  const px = roiToPixels(roi, sourceCanvas.width, sourceCanvas.height);
  const scale = Math.min(1, maxEdge / Math.max(px.width, px.height));
  const width = Math.max(1, Math.round(px.width * scale));
  const height = Math.max(1, Math.round(px.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas, { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, px.x, px.y, px.width, px.height, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height, { colorSpace: 'srgb' });
  releaseCanvas(canvas);
  return { rgba: data.data, width, height, sourcePx: { width: px.width, height: px.height } };
}

/** Re-encode a region as JPEG (strips all metadata). Used only for AI review. */
export async function encodeRegionJpeg(sourceCanvas, roi, maxEdge, quality = 0.9) {
  const { rgba, width, height } = extractRegion(sourceCanvas, roi, maxEdge);
  const canvas = createCanvas(width, height);
  context2d(canvas).putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  releaseCanvas(canvas);
  if (!blob) throw new InputError('decode-failed');
  return blob;
}
