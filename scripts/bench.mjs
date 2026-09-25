#!/usr/bin/env node
/**
 * Detector timing benchmark (blueprint §18). Reports p50/p95 per stage for
 * representative crops. Node on a desktop is several times faster than a
 * midrange phone; use the debug view on a real device for device numbers.
 *
 *   node scripts/bench.mjs [--runs 30]
 */
import { readFileSync } from 'node:fs';
import { analyzePixels, createDetectorContext } from '../src/detection/pipeline.js';
import { illuminationRamp, solid, stripes, toInput } from '../tests/fixtures/synthetic.mjs';

const root = new URL('..', import.meta.url);
const readJson = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 30;
const ctx = createDetectorContext({ config: readJson('data/detector-config.json'), palette: readJson('data/colors.json') });

const cases = [
  ['camera ROI 432px, noisy navy', solid('#202E4D', { width: 432, height: 432, noise: 4 })],
  ['1024px noisy navy', solid('#202E4D', { width: 1024, height: 1024, noise: 4 })],
  ['1024px black/white stripes', stripes([{ color: '#101114', size: 20 }, { color: '#FFFFFF', size: 20 }], { width: 1024, height: 1024, noise: 3 })],
  ['1024px shading ramp', illuminationRamp('#808287', { width: 1024, height: 1024, noise: 3 })],
];
const stages = ['sampleMs', 'clusterMs', 'spatialMs', 'matchMs', 'totalMs'];
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

console.log(`node ${process.version}, ${runs} runs per case (after 3 warm-up runs)\n`);
for (const [name, img] of cases) {
  const input = toInput(img);
  for (let i = 0; i < 3; i++) analyzePixels(input, ctx);
  const samples = Object.fromEntries(stages.map((s) => [s, []]));
  for (let i = 0; i < runs; i++) {
    const m = analyzePixels(input, ctx).result.qualityMetrics;
    for (const s of stages) samples[s].push(m[s]);
  }
  const cells = stages.map((s) => {
    const sorted = samples[s].sort((a, b) => a - b);
    return `${s.replace('Ms', '')} ${pct(sorted, 0.5).toFixed(1)}/${pct(sorted, 0.95).toFixed(1)}`;
  });
  console.log(`${name.padEnd(32)} p50/p95 ms: ${cells.join('  ')}`);
}
