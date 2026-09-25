/**
 * User-facing copy for quality flags and error codes. Kept in one place so
 * wording can be reviewed without reading UI code.
 */
import { groupLabel } from '../grouping.js';

export const CONFIDENCE_TOOLTIP = 'Based on color similarity and image quality; lighting can change the result.';
export const DISCLAIMER = 'Color sorting suggestion. Follow the care label; wash new or bleeding items separately.';

/**
 * Result messages keyed by quality flag. `level` controls styling (never
 * the only cue: every message has text and an icon).
 */
export function flagMessages(result) {
  const out = [];
  const has = (f) => result.qualityFlags.includes(f);
  if (has('low-confidence')) out.push({ level: 'warn', text: 'Check result — this match is uncertain.' });
  if (has('pattern-ambiguous')) out.push({ level: 'warn', text: 'Pattern or shadow — try flat, even lighting. If the garment is patterned, widen the target to include all of its colors.' });
  if (has('unrecognized')) out.push({ level: 'warn', text: 'Unrecognized color — no reference color is close. The nearest suggestions are listed below.' });
  if (has('mixed-colors')) out.push({ level: 'warn', text: 'Several colors detected — this may be a print. Widen the target to cover the pattern, or tighten it on one color.' });
  if (has('calibration-discarded')) out.push({ level: 'warn', text: 'The white reference would have over-brightened the garment, so calibration was not applied. Recapture with softer light.' });
  if (has('near-clipping')) out.push({ level: 'warn', text: 'Parts of the photo are pure black or pure white, which hides color. Avoid glare and deep shadow.' });
  if (has('lighting-ambiguity')) out.push({ level: 'info', text: 'Light and dark areas could be a shadow rather than a pattern. Recapture in even light if unsure.' });
  if (has('possible-accent')) out.push({ level: 'info', text: 'Possible accent color. If the garment is patterned, widen the target to include all of its colors.' });
  if (has('uncertain-match') && !has('low-confidence')) out.push({ level: 'info', text: 'Not a close match to any reference color.' });
  if (has('close-call')) out.push({ level: 'info', text: 'Two names fit almost equally well — see the closest matches.' });
  if (has('group-boundary') && result.groupAlternatives?.length) {
    out.push({ level: 'info', text: `Close to the boundary with ${result.groupAlternatives.map(groupLabel).join(' / ')}.` });
  }
  if (has('channel-clipping') && !has('near-clipping')) out.push({ level: 'info', text: 'Some colors are brighter than the camera can measure. Reduce glare or exposure.' });
  if (has('calibrated')) out.push({ level: 'ok', text: 'Calibrated with a white reference.' });
  return out;
}

const ERRORS = {
  // Detector
  'too-few-samples': 'Not enough of the photo is inside the target. Move or enlarge the target over the fabric.',
  'roi-too-small': 'The target is too small. Make it larger or move closer to the garment.',
  'invalid-calibration': 'The white reference could not be used. Reset calibration and try again.',
  'version-mismatch': 'The app was just updated. Reload to finish updating.',
  'analysis-failed': 'Analysis failed. Please try again.',
  'invalid-input': 'This image could not be analyzed. Try another photo.',
  // Calibration
  'calibration-too-few-samples': 'The white reference box is too small. Make it larger.',
  'calibration-exposure': 'The white reference is too dark or too bright. Use a matte white or light gray card in normal light.',
  'calibration-clipped': 'The white reference is overexposed. Move it out of direct light or glare.',
  'calibration-uneven': 'The white reference is unevenly lit or not a plain surface. Put the box on one evenly lit patch.',
  'calibration-gain-range': 'That reference looks colored, or the light is too strongly tinted. Use a plain white or gray card.',
  'calibration-overlap': 'Keep the white reference outside the fabric target.',
  // Input
  'file-too-large': 'That file is larger than 20 MB. Choose a smaller photo.',
  'image-too-large': 'That photo is larger than 24 megapixels. Choose a smaller photo.',
  'unsupported-format': 'That file type isn’t supported. Choose a JPEG, PNG or WebP photo.',
  'unsupported-format-heic': 'This browser can’t open HEIC photos. Convert the photo to JPEG or PNG first (iPhone: Settings › Camera › Formats › Most Compatible).',
  'decode-failed': 'That photo couldn’t be opened. Try another one.',
  'out-of-memory': 'The photo was too large to process on this device. Try a smaller one.',
  'no-file': 'No photo was selected.',
  // Camera
  'permission-denied': 'Camera access is blocked. Allow camera access for this site in your browser settings, then try again — or upload a photo instead.',
  'no-camera': 'No camera was found. You can upload a photo instead.',
  'camera-busy': 'The camera is in use by another app. Close that app and try again.',
  'insecure-context': 'The camera only works on a secure (https) address. Open the app over https, or upload a photo.',
  unsupported: 'This browser doesn’t support camera access. Upload a photo instead.',
  'camera-failed': 'The camera couldn’t start. Try again or upload a photo.',
  'camera-not-ready': 'The camera isn’t ready yet. Wait a moment and try again.',
  // Storage
  'storage-unavailable': 'Could not save locally. Scanning still works, but corrections and references can’t be saved in this browser mode.',
  'storage-failed': 'Could not save locally. Your device may be out of space.',
};

export function errorMessage(code) {
  return ERRORS[code] ?? 'Something went wrong. Please try again.';
}
