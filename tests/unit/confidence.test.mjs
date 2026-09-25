import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCaps, baseCaps, confidenceLabel, scoreComponents, weightedScore } from '../../src/detection/confidence.js';
import { loadConfig } from '../helpers.mjs';

const cc = loadConfig().confidence;
const perfect = { d1: 0, d2: 50, spread: 0, stabilityDistance: 0, nearBlackFraction: 0, nearWhiteFraction: 0 };

test('blueprint formula terms', () => {
  const c = scoreComponents({ d1: 5, d2: 8, spread: 4, stabilityDistance: 2, nearBlackFraction: 0.1, nearWhiteFraction: 0.15 }, cc);
  assert.equal(c.fit, Math.exp(-0.25));
  assert.equal(c.margin, 0.5);
  assert.equal(c.compact, Math.exp(-0.25));
  assert.equal(c.stability, 0.75);
  assert.equal(c.quality, 1 - 0.35 * 0.5);
  const expected = Math.round(100 * (0.35 * c.fit + 0.2 * c.margin + 0.15 * c.compact + 0.15 * c.stability + 0.15 * c.quality));
  assert.equal(weightedScore(c, cc.weights), expected);
});

test('a perfect match scores 100 before caps; uncalibrated caps at 85, calibrated at 95', () => {
  const raw = weightedScore(scoreComponents(perfect, cc), cc.weights);
  assert.equal(raw, 100);
  assert.equal(applyCaps(raw, baseCaps({ calibrated: false, clipFraction: 0, d1: 0 }, cc.caps)).score, 85);
  assert.equal(applyCaps(raw, baseCaps({ calibrated: true, clipFraction: 0, d1: 0 }, cc.caps)).score, 95);
});

test('caps: clipping 65, poor fit 60, applied as the minimum', () => {
  const caps = baseCaps({ calibrated: true, clipFraction: 0.25, d1: 12 }, cc.caps);
  const { score, applied } = applyCaps(100, caps);
  assert.equal(score, 60);
  assert.deepEqual(applied.sort(), ['calibrated', 'near-clipping', 'poor-fit']);
  assert.equal(applyCaps(50, caps).applied.length, 0, 'caps above the score are not reported');
});

test('missing runner-up and missing stability sample are handled', () => {
  const c = scoreComponents({ ...perfect, d2: Infinity, stabilityDistance: Infinity }, cc);
  assert.equal(c.margin, 1);
  assert.equal(c.stability, 0);
});

test('scores stay finite and within 0..100 for extreme inputs', () => {
  for (const d1 of [0, 5, 50, 1e6]) {
    for (const spread of [0, 100, 1e9]) {
      const s = weightedScore(scoreComponents({ d1, d2: d1 + 1, spread, stabilityDistance: 1e9, nearBlackFraction: 1, nearWhiteFraction: 1 }, cc), cc.weights);
      assert.ok(Number.isInteger(s) && s >= 0 && s <= 100);
    }
  }
});

test('labels: >=80 High, 60–79 Moderate, <60 Low', () => {
  assert.equal(confidenceLabel(80, cc.labels), 'High');
  assert.equal(confidenceLabel(79, cc.labels), 'Moderate');
  assert.equal(confidenceLabel(60, cc.labels), 'Moderate');
  assert.equal(confidenceLabel(59, cc.labels), 'Low');
  assert.equal(confidenceLabel(null, cc.labels), null);
});
