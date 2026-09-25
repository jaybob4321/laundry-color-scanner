#!/usr/bin/env node
/**
 * Build step for the static app. Two jobs, both reproducible:
 *   1. Copy the authoritative seed palette spec/colors.json -> data/colors.json
 *      (blueprint §2: one generated source of truth).
 *   2. Regenerate the service worker's precache block (file list + content
 *      hash version) so every deploy is one atomic cache version (§15).
 *
 * `--check` verifies both outputs are current without writing (used by tests).
 */
import { fileURLToPath } from 'node:url';
import { syncPalette } from './lib/palette.mjs';
import { updatePrecache } from './lib/precache.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');

// Palette first: its bytes are part of the precache hash.
const results = [syncPalette(root, { check }), updatePrecache(root, { check })];
let stale = false;
for (const r of results) {
  const status = r.changed ? (check ? 'STALE  ' : 'updated') : 'ok     ';
  console.log(`${status} ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
  if (r.changed) stale = true;
}
if (check && stale) {
  console.error('Build outputs are out of date. Run `npm run build`.');
  process.exit(1);
}
