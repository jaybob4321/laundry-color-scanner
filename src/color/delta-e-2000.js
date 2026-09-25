/**
 * Color-difference formulas (blueprint §5).
 *
 * CIEDE2000 is implemented from the published equations in
 * G. Sharma, W. Wu, E. N. Dalal, "The CIEDE2000 color-difference formula:
 * Implementation notes, supplementary test data, and mathematical
 * observations", Color Research & Application 30(1), 2005.
 * Weighting factors default to kL = kC = kH = 1.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const POW25_7 = 25 ** 7;

/** Hue angle in degrees normalized to [0, 360); 0 for an achromatic point. */
function hueDegrees(b, aPrime) {
  if (b === 0 && aPrime === 0) return 0;
  let h = Math.atan2(b, aPrime) * RAD_TO_DEG;
  if (h < 0) h += 360;
  return h >= 360 ? h - 360 : h;
}

/** CIEDE2000 between two Lab colors given as scalars (allocation-free). */
export function deltaE2000(L1, a1, b1, L2, a2, b2, kL = 1, kC = 1, kH = 1) {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueDegrees(b1, a1p);
  const h2p = hueDegrees(b2, a2p);
  const chromaProduct = C1p * C2p;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (chromaProduct !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(chromaProduct) * Math.sin((dhp * DEG_TO_RAD) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (chromaProduct === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG_TO_RAD) +
    0.24 * Math.cos(2 * hbarp * DEG_TO_RAD) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG_TO_RAD) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG_TO_RAD);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const Lm50sq = (Lbarp - 50) ** 2;
  const SL = 1 + (0.015 * Lm50sq) / Math.sqrt(20 + Lm50sq);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * DEG_TO_RAD) * RC;

  const tL = dLp / (kL * SL);
  const tC = dCp / (kC * SC);
  const tH = dHp / (kH * SH);
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

/** CIEDE2000 between two [L,a,b] arrays. */
export function deltaE2000Lab(p, q) {
  return deltaE2000(p[0], p[1], p[2], q[0], q[1], q[2]);
}

/** CIE76: Euclidean distance in Lab. Used for fast k-means assignments. */
export function deltaE76Lab(p, q) {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/**
 * Pluggable distance registry so the matching engine can switch methods
 * without touching callers. Thresholds in detector-config.json are tuned
 * for CIEDE2000; changing the method requires re-validating them.
 */
export const DISTANCE_METHODS = Object.freeze({
  ciede2000: deltaE2000Lab,
  cie76: deltaE76Lab,
});

export function getDistanceMethod(name = 'ciede2000') {
  const fn = DISTANCE_METHODS[name];
  if (!fn) throw new RangeError(`Unknown color distance method: ${name}`);
  return fn;
}
