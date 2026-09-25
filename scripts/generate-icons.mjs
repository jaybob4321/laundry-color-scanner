#!/usr/bin/env node
/**
 * Render the app icons (T-shirt with three color swatches) as PNGs:
 *   icon-192.png, icon-512.png   rounded tile, purpose "any"
 *   maskable-512.png             full-bleed, artwork inside the 80% safe zone
 *   apple-touch-icon.png         180px full-bleed (iOS rounds corners itself)
 * Anti-aliased by 4x4 supersampling. No dependencies.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePNG } from './lib/png.mjs';

const outDir = fileURLToPath(new URL('../assets/icons/', import.meta.url));
mkdirSync(outDir, { recursive: true });

// Artwork in a 100x100 design space.
const SHIRT = [
  [36, 20], [22, 25], [8, 40], [18, 51], [27, 45], [27, 84], [73, 84], [73, 45], [82, 51], [92, 40], [78, 25], [64, 20],
  [60, 24.5], [55, 27], [50, 27.8], [45, 27], [40, 24.5],
];
const DOTS = [
  { x: 39, y: 59, r: 6.2, color: [31, 42, 68] },
  { x: 50, y: 59, r: 6.2, color: [217, 67, 79] },
  { x: 61, y: 59, r: 6.2, color: [242, 193, 78] },
];
const BG_TOP = [14, 116, 160];
const BG_BOTTOM = [9, 74, 106];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedRect(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 100 - radius);
  const cy = Math.min(Math.max(y, radius), 100 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

function colorAt(x, y, { rounded, scale }) {
  if (rounded && !inRoundedRect(x, y, 22)) return null;
  let color = BG_TOP.map((c, i) => c + ((BG_BOTTOM[i] - c) * y) / 100);
  // Artwork is scaled about the design center (50, 52).
  const ux = 50 + (x - 50) / scale;
  const uy = 52 + (y - 52) / scale;
  if (inPolygon(ux, uy, SHIRT)) color = [255, 255, 255];
  for (const dot of DOTS) if ((ux - dot.x) ** 2 + (uy - dot.y) ** 2 <= dot.r * dot.r) color = dot.color;
  return color;
}

function render(size, options) {
  const ss = 4;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = colorAt(((px + (sx + 0.5) / ss) / size) * 100, ((py + (sy + 0.5) / ss) / size) * 100, options);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          covered++;
        }
      }
      const p = (py * size + px) * 4;
      if (covered) {
        rgba[p] = Math.round(r / covered);
        rgba[p + 1] = Math.round(g / covered);
        rgba[p + 2] = Math.round(b / covered);
      }
      rgba[p + 3] = Math.round((covered / (ss * ss)) * 255);
    }
  }
  return encodePNG(size, size, rgba);
}

const icons = [
  ['icon-192.png', 192, { rounded: true, scale: 0.92 }],
  ['icon-512.png', 512, { rounded: true, scale: 0.92 }],
  ['maskable-512.png', 512, { rounded: false, scale: 0.7 }],
  ['apple-touch-icon.png', 180, { rounded: false, scale: 0.84 }],
];
for (const [name, size, options] of icons) {
  writeFileSync(`${outDir}${name}`, render(size, options));
  console.log(`wrote assets/icons/${name}`);
}
