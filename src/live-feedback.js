/**
 * Optional live framing feedback (blueprint §3): at most two frames per
 * second, ~1,024 point samples of the target, and only "Ready" or a
 * reframing hint. Capture always runs the full analysis.
 */
import { SRGB8_TO_LINEAR } from './color/srgb-lab.js';

export function assessFrame(rgba, width, height) {
  let dark = 0;
  let bright = 0;
  let count = 0;
  let sumY = 0;
  for (let p = 0; p < width * height * 4; p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const max = Math.max(r, g, b);
    if (max <= 12) dark++;
    if (Math.min(r, g, b) >= 250) bright++;
    sumY += 0.2126 * SRGB8_TO_LINEAR[r] + 0.7152 * SRGB8_TO_LINEAR[g] + 0.0722 * SRGB8_TO_LINEAR[b];
    count++;
  }
  if (!count) return { status: 'unknown', message: '' };
  const meanY = sumY / count;
  if (bright / count > 0.08) return { status: 'glare', message: 'Glare detected — tilt the garment or move away from direct light.' };
  if (dark / count > 0.6 && meanY < 0.004) return { status: 'too-dark', message: 'Too dark — add light or turn on the flash.' };
  return { status: 'ready', message: 'Ready' };
}
