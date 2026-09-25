/**
 * Single-color fixtures: every palette anchor, the 18 colors the product
 * brief requires, and realistic exposure variants judged against
 * acceptable-name sets (blueprint §17 "acceptable-name sets").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePixels, analyzePixelsChunked, createDetectorContext } from '../../src/detection/pipeline.js';
import { validateScanResult } from '../../src/schema.js';
import { shade, solid, toInput } from '../fixtures/synthetic.mjs';
import { loadConfig, loadPalette } from '../helpers.mjs';

const config = loadConfig();
const palette = loadPalette();
const ctx = createDetectorContext({ config, palette });
const hex = (id) => palette.colors.find((c) => c.id === id).hex;
const analyze = (img) => analyzePixels(toInput(img), ctx).result;

const REQUIRED = {
  black: { names: ['black', 'soft-black'], groups: ['darks'] },
  navy: { names: ['navy', 'dark-blue', 'indigo'], groups: ['darks'] },
  'dark-gray': { names: ['dark-gray', 'charcoal', 'gray'], groups: ['darks', 'grays'] },
  white: { names: ['white', 'off-white'], groups: ['whites', 'lights'] },
  cream: { names: ['cream', 'ivory', 'beige', 'pale-yellow'], groups: ['lights'] },
  beige: { names: ['beige', 'cream', 'khaki', 'tan'], groups: ['lights', 'browns-beiges'] },
  tan: { names: ['tan', 'cocoa', 'khaki', 'beige'], groups: ['browns-beiges', 'lights'] },
  brown: { names: ['brown', 'dark-brown', 'cocoa', 'rust'], groups: ['browns-beiges', 'darks'] },
  red: { names: ['red', 'bright-red', 'dark-red'], groups: ['reds-pinks', 'darks'] },
  burgundy: { names: ['burgundy', 'maroon', 'dark-red'], groups: ['darks'] },
  pink: { names: ['pink', 'dusty-rose', 'light-pink', 'hot-pink'], groups: ['reds-pinks'] },
  orange: { names: ['orange', 'rust', 'coral'], groups: ['yellows-oranges'] },
  yellow: { names: ['yellow', 'pale-yellow', 'mustard'], groups: ['lights', 'yellows-oranges'] },
  green: { names: ['green', 'emerald', 'dark-green'], groups: ['greens', 'darks'] },
  olive: { names: ['olive', 'khaki'], groups: ['greens', 'browns-beiges'] },
  'light-blue': { names: ['light-blue', 'sky-blue', 'faded-denim'], groups: ['lights', 'blues'] },
  'royal-blue': { names: ['royal-blue', 'blue', 'dark-blue', 'indigo'], groups: ['blues', 'darks'] },
  purple: { names: ['purple', 'dark-purple', 'plum'], groups: ['other', 'darks'] },
};

test('every palette anchor (with sensor-like noise) is named and grouped correctly', () => {
  for (const color of palette.colors) {
    const r = analyze(solid(color.hex, { noise: 3 }));
    assert.equal(r.patternStatus, 'single', color.id);
    assert.equal(r.detectedColorId, color.id, color.id);
    assert.equal(r.laundryGroup, color.laundryGroup, color.id);
    assert.ok(r.confidence >= 60, `${color.id} confidence ${r.confidence}`);
  }
});

for (const [id, expect] of Object.entries(REQUIRED)) {
  test(`required color: ${id}`, () => {
    const exact = analyze(solid(hex(id), { noise: 3 }));
    assert.equal(exact.detectedColorId, id);
    assert.equal(exact.clusters.length >= 1, true);
    assert.equal(exact.clusters[0].matches[0].colorId, id);
    assert.equal(exact.clusters[0].matches.length, 3, 'three closest matches');

    for (const exposure of [0.8, 1.2]) {
      const r = analyze(solid(shade(hex(id), exposure), { noise: 4 }));
      const label = `${id} x${exposure}`;
      assert.equal(r.patternStatus, 'single', label);
      assert.ok(expect.names.includes(r.detectedColorId), `${label}: named ${r.detectedColorId}`);
      assert.ok(r.clusters[0].matches.some((m) => m.colorId === id), `${label}: ${id} not in top 3`);
      assert.ok(expect.groups.includes(r.laundryGroup), `${label}: group ${r.laundryGroup}`);
    }
  });
}

test('close calls are capped instead of forcing a confident name', () => {
  // Cream at -20% exposure sits between cream and beige.
  const r = analyze(solid(shade(hex('cream'), 0.8), { noise: 4 }));
  const [first, second] = r.clusters[0].matches;
  if (second.distance - first.distance < 1) {
    assert.ok(r.qualityFlags.includes('close-call'));
    assert.ok(r.confidence <= 55);
  }
});

test('navy vs black stay separate candidates; small margins show alternatives', () => {
  const r = analyze(solid('#1A2238', { noise: 3 }));
  const ids = r.clusters[0].matches.map((m) => m.colorId);
  assert.ok(ids.includes('navy'));
  assert.equal(r.laundryGroup, 'darks');
  assert.ok(r.groupConfidence >= r.confidence - 1, 'group can be surer than the name');
});

test('unrecognized colors abstain to Other with nearest suggestions', () => {
  const r = analyze(solid([0, 255, 64], { noise: 2 }));
  assert.equal(r.detectedColorId, null);
  assert.equal(r.laundryGroup, 'other');
  assert.ok(r.qualityFlags.includes('unrecognized'));
  assert.ok(r.qualityFlags.includes('needs-review'));
  assert.equal(r.clusters[0].matches.length, 3, 'nearest matches are kept as suggestions');
});

test('results are deterministic, valid and finite', () => {
  const img = solid(hex('teal'), { noise: 5 });
  const a = analyze(img);
  const b = analyze(img);
  const strip = (r) => ({ ...r, id: 0, createdAt: 0, qualityMetrics: { ...r.qualityMetrics, sampleMs: 0, clusterMs: 0, spatialMs: 0, matchMs: 0, totalMs: 0 } });
  assert.deepEqual(strip(a), strip(b));
  validateScanResult(a);
  assert.equal(a.confidenceKind, 'heuristic');
  assert.equal(JSON.stringify(a).includes('null,null'), false);
});

test('chunked main-thread fallback matches the worker path', async () => {
  const img = solid(hex('mustard'), { noise: 3 });
  const sync = analyze(img);
  const { result } = await analyzePixelsChunked(toInput(img), ctx);
  assert.equal(result.detectedColorId, sync.detectedColorId);
  assert.equal(result.confidence, sync.confidence);
  assert.deepEqual(result.clusters.map((c) => c.lab), sync.clusters.map((c) => c.lab));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(analyzePixelsChunked(toInput(img), ctx, { signal: aborted.signal }), { code: 'canceled' });
});

test('a 1024px crop analyzes well within the phone budget on this machine', () => {
  const img = solid(hex('navy'), { noise: 4, width: 1024, height: 1024 });
  analyze(img); // warm up
  const times = Array.from({ length: 5 }, () => analyze(img).qualityMetrics.totalMs).sort((x, y) => x - y);
  assert.ok(times[2] < 400, `median ${times[2].toFixed(1)} ms`);
});
