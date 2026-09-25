import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Copy spec/colors.json to data/colors.json byte-for-byte. */
export function syncPalette(root, { check = false } = {}) {
  const src = join(root, 'spec', 'colors.json');
  const dest = join(root, 'data', 'colors.json');
  const content = readFileSync(src, 'utf8');
  const current = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
  const changed = current !== content;
  if (changed && !check) writeFileSync(dest, content);
  const palette = JSON.parse(content);
  return { name: 'data/colors.json', changed, detail: `palette ${palette.paletteVersion}, ${palette.colors.length} colors` };
}
