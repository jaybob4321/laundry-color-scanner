import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function loadJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

export const loadConfig = () => loadJson('data/detector-config.json');
export const loadPalette = () => loadJson('data/colors.json');

export function assertClose(actual, expected, tolerance, message = '') {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message} expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

export function assertLabClose(actual, expected, tolerance, message = '') {
  for (let i = 0; i < 3; i++) assertClose(actual[i], expected[i], tolerance, `${message}[${i}]`);
}
