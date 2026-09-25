/**
 * Image-quality indicators (blueprint §3.7, §8 "Highlights and shadows", §19).
 *
 * Near-black / near-white fractions are ambiguity indicators, not proof of bad
 * exposure; those pixels stay in clustering because deleting them would
 * delete real black and white fabric.
 */

export const SAMPLE_NEAR_BLACK = 1;
export const SAMPLE_NEAR_WHITE = 2;
export const SAMPLE_CHANNEL_CLIP = 4;

/** Raw (pre-calibration) clip statistics over valid samples. */
export function measureRawQuality(samples, { nearBlackMax, nearWhiteMin, channelClipMin }) {
  const flags = new Uint8Array(samples.total);
  let nearBlack = 0;
  let nearWhite = 0;
  let channelClip = 0;
  for (let i = 0; i < samples.total; i++) {
    if (!samples.valid[i]) continue;
    const r = samples.rgb[i * 3];
    const g = samples.rgb[i * 3 + 1];
    const b = samples.rgb[i * 3 + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let f = 0;
    if (max <= nearBlackMax) {
      f |= SAMPLE_NEAR_BLACK;
      nearBlack++;
    }
    if (min >= nearWhiteMin) {
      f |= SAMPLE_NEAR_WHITE;
      nearWhite++;
    }
    if (max >= channelClipMin) {
      f |= SAMPLE_CHANNEL_CLIP;
      channelClip++;
    }
    flags[i] = f;
  }
  const n = samples.validCount || 1;
  return {
    flags,
    validCount: samples.validCount,
    validFraction: samples.validCount / samples.total,
    nearBlackFraction: nearBlack / n,
    nearWhiteFraction: nearWhite / n,
    channelClipFraction: channelClip / n,
  };
}

/**
 * Mark small, spatially isolated highlight (L > highlightMinL, C < highlightMaxC)
 * or deep-shadow (L < shadowMaxL) components on the sample grid as possible
 * artifacts. Components larger than maxComponentFraction of the valid samples
 * are real bright/dark fabric and are never marked.
 *
 * Returns a mask indexed by valid sample.
 */
export function findArtifactMask(labs, n, gridIndex, gridWidth, gridHeight, cfg) {
  const total = gridWidth * gridHeight;
  const kind = new Uint8Array(total); // 0 none, 1 highlight, 2 shadow
  const validAt = new Int32Array(total).fill(-1);
  for (let v = 0; v < n; v++) {
    const g = gridIndex[v];
    validAt[g] = v;
    const L = labs[v * 3];
    const C = Math.hypot(labs[v * 3 + 1], labs[v * 3 + 2]);
    if (L > cfg.highlightMinL && C < cfg.highlightMaxC) kind[g] = 1;
    else if (L < cfg.shadowMaxL) kind[g] = 2;
  }
  const mask = new Uint8Array(n);
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const component = new Int32Array(total);
  const maxSize = Math.floor(cfg.maxComponentFraction * n);
  const neighbors = new Int32Array(4);
  let count = 0;
  for (let start = 0; start < total; start++) {
    if (!kind[start] || seen[start]) continue;
    const type = kind[start];
    let top = 0;
    let size = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const g = stack[--top];
      component[size++] = g;
      const gx = g % gridWidth;
      const gy = (g - gx) / gridWidth;
      let m = 0;
      if (gx > 0) neighbors[m++] = g - 1;
      if (gx < gridWidth - 1) neighbors[m++] = g + 1;
      if (gy > 0) neighbors[m++] = g - gridWidth;
      if (gy < gridHeight - 1) neighbors[m++] = g + gridWidth;
      for (let k = 0; k < m; k++) {
        const h = neighbors[k];
        if (!seen[h] && kind[h] === type) {
          seen[h] = 1;
          stack[top++] = h;
        }
      }
    }
    if (size <= maxSize) {
      for (let k = 0; k < size; k++) mask[validAt[component[k]]] = 1;
      count += size;
    }
  }
  return { mask, count };
}
