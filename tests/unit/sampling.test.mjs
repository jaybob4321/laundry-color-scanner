import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, sampleGrid, samplesToLab } from '../../src/detection/sampling.js';
import { measureRawQuality, findArtifactMask } from '../../src/detection/quality.js';
import { srgb8ToLab } from '../../src/color/srgb-lab.js';
import { solid, paint } from '../fixtures/synthetic.mjs';
import { assertLabClose, loadConfig } from '../helpers.mjs';

const cfg = loadConfig();
const opts = { gridWidth: 64, gridHeight: 64, seed: 1, alphaMin: 250 };

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(1);
  const b = mulberry32(1);
  for (let i = 0; i < 1000; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('one jittered sample per cell, positions preserved and deterministic', () => {
  const img = solid('#808080', { width: 300, height: 200 });
  const s = sampleGrid(img.rgba, img.width, img.height, opts);
  assert.equal(s.total, 4096);
  assert.equal(s.validCount, 4096);
  for (let gy = 0; gy < 64; gy++) {
    for (let gx = 0; gx < 64; gx++) {
      const i = gy * 64 + gx;
      assert.ok(s.x[i] >= Math.floor((gx * 300) / 64) && s.x[i] < Math.ceil(((gx + 1) * 300) / 64), `x cell ${gx}`);
      assert.ok(s.y[i] >= Math.floor((gy * 200) / 64) && s.y[i] < Math.ceil(((gy + 1) * 200) / 64), `y cell ${gy}`);
    }
  }
  const again = sampleGrid(img.rgba, img.width, img.height, opts);
  assert.deepEqual(again.x, s.x);
  assert.deepEqual(again.y, s.y);
  const seed2 = sampleGrid(img.rgba, img.width, img.height, { ...opts, seed: 2 });
  assert.notDeepEqual(seed2.x, s.x);
});

test('samples are single pixels, never cell averages', () => {
  // 1px black/white columns: every sample must be pure black or pure white.
  const img = paint(256, 256, (x) => (x % 2 ? [255, 255, 255] : [0, 0, 0]));
  const s = sampleGrid(img.rgba, img.width, img.height, opts);
  for (let i = 0; i < s.total; i++) assert.ok(s.rgb[i * 3] === 0 || s.rgb[i * 3] === 255);
});

test('pixels with alpha < 250 are invalid and not composited', () => {
  const img = paint(128, 128, (x) => (x < 64 ? [200, 10, 10, 249] : [10, 200, 10, 255]));
  const s = sampleGrid(img.rgba, img.width, img.height, opts);
  assert.equal(s.validCount, 2048);
  const conv = samplesToLab(s);
  assert.equal(conv.n, 2048);
  for (let v = 0; v < conv.n; v++) assert.equal(conv.displayRgb[v * 3 + 1], 200);
});

test('handles crops smaller than the grid', () => {
  const img = solid('#336699', { width: 40, height: 30 });
  const s = sampleGrid(img.rgba, img.width, img.height, opts);
  assert.equal(s.validCount, 4096);
  assert.throws(() => sampleGrid(new Uint8ClampedArray(0), 0, 0, opts));
  assert.throws(() => sampleGrid(new Uint8ClampedArray(10), 10, 10, opts));
});

test('samplesToLab without gains uses the 8-bit conversion', () => {
  const img = solid([32, 46, 77], { width: 64, height: 64 });
  const conv = samplesToLab(sampleGrid(img.rgba, 64, 64, opts));
  assertLabClose([conv.lab[0], conv.lab[1], conv.lab[2]], srgb8ToLab(32, 46, 77), 1e-12);
  assert.equal(conv.newlyClippedFraction, 0);
});

test('samplesToLab applies gains in linear light and counts newly clipped samples', () => {
  const img = paint(64, 64, (x) => (x < 32 ? [128, 128, 128] : [250, 250, 250]));
  const conv = samplesToLab(sampleGrid(img.rgba, 64, 64, opts), [1.2, 1, 1]);
  assert.ok(Math.abs(conv.newlyClippedFraction - 0.5) < 0.01, `got ${conv.newlyClippedFraction}`);
  // Already-saturated channels are not "newly" clipped.
  const white = solid([255, 255, 255], { width: 64, height: 64 });
  assert.equal(samplesToLab(sampleGrid(white.rgba, 64, 64, opts), [1.2, 1, 1]).newlyClippedFraction, 0);
});

test('raw quality fractions use the blueprint thresholds', () => {
  const img = paint(64, 64, (x) => (x < 16 ? [3, 2, 1] : x < 32 ? [252, 253, 255] : x < 48 ? [255, 30, 30] : [100, 100, 100]));
  const q = measureRawQuality(sampleGrid(img.rgba, 64, 64, opts), cfg.sampling);
  assert.equal(q.nearBlackFraction, 0.25);
  assert.equal(q.nearWhiteFraction, 0.25);
  assert.equal(q.channelClipFraction, 0.5);
  assert.equal(q.validFraction, 1);
});

test('artifact mask marks only small isolated highlight/shadow components', () => {
  const n = 64 * 64;
  const labs = new Float64Array(n * 3);
  const gridIndex = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    gridIndex[i] = i;
    labs[i * 3] = 50;
  }
  const set = (gx, gy, L) => (labs[(gy * 64 + gx) * 3] = L);
  set(5, 5, 99); // isolated highlight
  set(6, 5, 99);
  set(40, 40, 1); // isolated deep shadow
  for (let gy = 0; gy < 64; gy++) for (let gx = 50; gx < 64; gx++) set(gx, gy, 99.5); // large bright patch
  const { mask, count } = findArtifactMask(labs, n, gridIndex, 64, 64, cfg.artifacts);
  assert.equal(count, 3);
  assert.equal(mask[5 * 64 + 5], 1);
  assert.equal(mask[5 * 64 + 6], 1);
  assert.equal(mask[40 * 64 + 40], 1);
  assert.equal(mask[10 * 64 + 60], 0, 'large bright area is real fabric');
});
