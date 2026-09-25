/**
 * Pure ROI geometry (blueprint §3.3). ROIs are always stored normalized to
 * the source image (0..1), never in CSS coordinates.
 */

/**
 * Map a rectangle drawn over a media element (CSS px, relative to the
 * element's box) to a normalized source ROI, for object-fit cover or contain.
 *   s = max (cover) | min (contain) of view/source scale
 *   offset = (source * s - view) / 2        (negative when letterboxed)
 *   sourceX = (overlayX + offsetX) / s
 */
export function viewRectToSourceRoi(rect, view, source, { fit = 'cover', mirrored = false } = {}) {
  const sx = view.width / source.width;
  const sy = view.height / source.height;
  const s = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const offsetX = (source.width * s - view.width) / 2;
  const offsetY = (source.height * s - view.height) / 2;
  let x0 = (rect.x + offsetX) / s;
  let x1 = (rect.x + rect.width + offsetX) / s;
  const y0 = clamp((rect.y + offsetY) / s, 0, source.height);
  const y1 = clamp((rect.y + rect.height + offsetY) / s, 0, source.height);
  if (mirrored) [x0, x1] = [source.width - x1, source.width - x0];
  x0 = clamp(x0, 0, source.width);
  x1 = clamp(x1, 0, source.width);
  return {
    x: x0 / source.width,
    y: y0 / source.height,
    width: Math.max(0, x1 - x0) / source.width,
    height: Math.max(0, y1 - y0) / source.height,
  };
}

/** Centered square covering `fraction` of the shorter view side (camera target). */
export function centeredSquare(view, fraction) {
  const side = Math.min(view.width, view.height) * fraction;
  return { x: (view.width - side) / 2, y: (view.height - side) / 2, width: side, height: side };
}

/** Centered square ROI (normalized) covering `fraction` of the shorter image side. */
export function defaultRoi(imageWidth, imageHeight, fraction = 0.6) {
  const side = Math.min(imageWidth, imageHeight) * fraction;
  return { x: (imageWidth - side) / 2 / imageWidth, y: (imageHeight - side) / 2 / imageHeight, width: side / imageWidth, height: side / imageHeight };
}

/**
 * Keep a normalized ROI inside the image, at least minPx source pixels per
 * side, and within maxAspect (in pixel terms).
 */
export function clampRoi(roi, imageWidth, imageHeight, { minPx = 64, maxAspect = 4 } = {}) {
  const minW = Math.min(1, minPx / imageWidth);
  const minH = Math.min(1, minPx / imageHeight);
  let w = clamp(roi.width, minW, 1);
  let h = clamp(roi.height, minH, 1);
  const aspect = (w * imageWidth) / (h * imageHeight);
  if (aspect > maxAspect) w = Math.max(minW, (maxAspect * h * imageHeight) / imageWidth);
  else if (aspect < 1 / maxAspect) h = Math.max(minH, (w * imageWidth) / (maxAspect * imageHeight));
  const x = clamp(roi.x, 0, 1 - w);
  const y = clamp(roi.y, 0, 1 - h);
  return { x, y, width: w, height: h };
}

/** Pixel rectangle of a normalized ROI (integer, inside the image, ≥1px). */
export function roiToPixels(roi, width, height) {
  const x = clamp(Math.round(roi.x * width), 0, width - 1);
  const y = clamp(Math.round(roi.y * height), 0, height - 1);
  const w = clamp(Math.round(roi.width * width), 1, width - x);
  const h = clamp(Math.round(roi.height * height), 1, height - y);
  return { x, y, width: w, height: h };
}

export function roisOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
