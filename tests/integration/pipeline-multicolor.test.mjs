/**
 * Multicolor fixtures (blueprint §8, §17): patterns must never be averaged
 * into a misleading single color, and illumination must not produce a
 * confident multicolor result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePixels, createDetectorContext } from '../../src/detection/pipeline.js';
import { componentBreakdown } from '../../src/ui/format.js';
import {
  blocks, checkerboard, hardShadow, illuminationRamp, solid, stripes, toInput,
} from '../fixtures/synthetic.mjs';
import { loadConfig, loadPalette } from '../helpers.mjs';

const config = loadConfig();
const palette = loadPalette();
const ctx = createDetectorContext({ config, palette });
const hex = (id) => palette.colors.find((c) => c.id === id).hex;
const analyze = (img) => analyzePixels(toInput(img), ctx).result;
const BLACK = hex('black');
const WHITE = hex('white');

function fractionOf(result, colorId) {
  return result.clusters.filter((c) => c.matches[0].colorId === colorId).reduce((s, c) => s + c.fraction, 0);
}

function assertNotGray(result, label) {
  assert.notEqual(result.laundryGroup, 'grays', `${label}: grouped as Grays`);
  assert.ok(!['gray', 'dark-gray', 'silver-gray', 'light-gray', 'charcoal'].includes(result.detectedColorId), `${label}: named ${result.detectedColorId}`);
}

test('50% black / 50% white resolved stripes are Multicolor at every tested frequency', () => {
  for (const orientation of ['vertical', 'horizontal']) {
    for (const size of [64, 32, 16, 8, 4]) {
      const label = `${orientation} ${size}px`;
      const r = analyze(stripes([{ color: BLACK, size }, { color: WHITE, size }], { orientation, noise: 2 }));
      assert.equal(r.patternStatus, 'multicolor', label);
      assert.equal(r.laundryGroup, 'multicolor', label);
      assert.ok(Math.abs(fractionOf(r, 'black') - 0.5) <= 0.05, `${label} black ${fractionOf(r, 'black')}`);
      assert.ok(Math.abs(fractionOf(r, 'white') - 0.5) <= 0.05, `${label} white ${fractionOf(r, 'white')}`);
      assertNotGray(r, label);
      // Real black/white stripes are also flagged as a possible lighting edge (cap 70).
      assert.ok(r.qualityFlags.includes('lighting-ambiguity'), label);
      assert.ok(r.confidence <= 70, label);
    }
  }
});

test('unresolved stripes abstain but never become gray', () => {
  for (const size of [1, 2]) {
    const r = analyze(stripes([{ color: BLACK, size }, { color: WHITE, size }], { noise: 2 }));
    assert.ok(['ambiguous', 'multicolor'].includes(r.patternStatus), `${size}px: ${r.patternStatus}`);
    assertNotGray(r, `${size}px`);
    if (r.patternStatus === 'ambiguous') {
      assert.equal(r.laundryGroup, 'other');
      assert.ok(r.qualityFlags.includes('pattern-ambiguous'));
      assert.ok(r.confidence < 60, 'abstention is low confidence');
    }
    // Component swatches are retained, not averaged.
    assert.ok(fractionOf(r, 'black') > 0.4 && fractionOf(r, 'white') > 0.4);
  }
});

test('52 / 43 / 5 black-white-other keeps every area within 5 points and sums to 100', () => {
  const r = analyze(stripes([{ color: BLACK, size: 52 }, { color: WHITE, size: 43 }, { color: hex('red'), size: 5 }], { noise: 2 }));
  assert.equal(r.patternStatus, 'multicolor');
  assert.ok(Math.abs(fractionOf(r, 'black') - 0.52) <= 0.05);
  assert.ok(Math.abs(fractionOf(r, 'white') - 0.43) <= 0.05);
  const { items, otherPercent } = componentBreakdown(r.clusters, config.multicolor.accentMinFraction);
  assert.equal(items.reduce((s, i) => s + i.percent, 0) + otherPercent, 100);
  assert.ok(otherPercent >= 3 && otherPercent <= 7, `other ${otherPercent}`);
});

test('50% red / 50% blue is Multicolor, not an averaged purple', () => {
  for (const img of [
    stripes([{ color: hex('red'), size: 24 }, { color: hex('royal-blue'), size: 24 }], { noise: 2 }),
    blocks(hex('red'), hex('royal-blue'), { noise: 2 }),
    checkerboard(hex('red'), hex('royal-blue'), 32, { noise: 2 }),
  ]) {
    const r = analyze(img);
    assert.equal(r.patternStatus, 'multicolor');
    assert.equal(r.laundryGroup, 'multicolor');
    assert.ok(Math.abs(fractionOf(r, 'red') - 0.5) <= 0.05);
    assert.ok(Math.abs(fractionOf(r, 'royal-blue') - 0.5) <= 0.05);
    assert.ok(!r.qualityFlags.includes('lighting-ambiguity'), 'hue edge is not a lighting edge');
    assert.ok(!r.clusters.some((c) => ['purple', 'plum', 'dark-purple'].includes(c.matches[0].colorId)));
  }
});

test('two blocks and checkerboards of black and white', () => {
  for (const img of [blocks(BLACK, WHITE, { noise: 2 }), checkerboard(BLACK, WHITE, 8, { noise: 2 }), checkerboard(BLACK, WHITE, 32, { noise: 2 })]) {
    const r = analyze(img);
    assert.equal(r.patternStatus, 'multicolor');
    assertNotGray(r, 'blocks/checks');
  }
});

test('a 10% accent is reported as a possible accent, not Multicolor', () => {
  const r = analyze(stripes([{ color: hex('navy'), size: 90 }, { color: WHITE, size: 10 }], { noise: 2 }));
  assert.equal(r.patternStatus, 'single');
  assert.equal(r.detectedColorId, 'navy');
  assert.equal(r.laundryGroup, 'darks');
  assert.ok(r.qualityFlags.includes('possible-accent'));
});

test('navy / black mixture keeps both components', () => {
  const r = analyze(stripes([{ color: hex('navy'), size: 20 }, { color: BLACK, size: 20 }], { noise: 2 }));
  assert.ok(fractionOf(r, 'navy') > 0.4, 'navy present');
  assert.ok(fractionOf(r, 'black') > 0.4, 'black present');
  assert.ok(!r.clusters.some((c) => c.fraction > 0.3 && ['soft-black', 'charcoal', 'dark-blue'].includes(c.matches[0].colorId)), 'not averaged');
  // Both components sort as Darks even though the garment is multicolor.
  assert.ok(r.clusters.slice(0, 2).every((c) => c.laundryGroup === 'darks'));
});

test('smooth illumination falloff does not produce a confident Multicolor', () => {
  for (const color of [hex('light-gray'), hex('navy'), hex('red')]) {
    const r = analyze(illuminationRamp(color, { from: 1, to: 0.3, noise: 2 }));
    assert.ok(r.patternStatus !== 'multicolor' || r.confidence < 80, `${color}: ${r.patternStatus} ${r.confidence}`);
  }
});

test('a hard shadow may look like a pattern, but is capped and flagged', () => {
  const r = analyze(hardShadow(hex('light-gray'), 0.35, { noise: 2 }));
  if (r.patternStatus !== 'single') {
    assert.ok(r.qualityFlags.includes('lighting-ambiguity'));
    assert.ok(r.confidence <= 70);
  }
});

test('a uniform solid never reports multicolor', () => {
  for (const id of ['black', 'white', 'navy', 'burgundy', 'light-blue']) {
    const r = analyze(solid(hex(id), { noise: 6 }));
    assert.equal(r.patternStatus, 'single', id);
  }
});
