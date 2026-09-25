import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, summarizeRanking } from '../../src/color/match.js';
import { deltaE2000Lab } from '../../src/color/delta-e-2000.js';
import { createPaletteIndex } from '../../src/references.js';
import { rgbToLab } from '../../src/color/srgb-lab.js';
import { loadConfig, loadPalette } from '../helpers.mjs';

const config = loadConfig();
const palette = createPaletteIndex(loadPalette());
const opts = { distance: deltaE2000Lab, profilePenalty: config.matching.profilePenalty };

test('every anchor ranks itself first at distance zero', () => {
  for (const color of palette.colors) {
    const ranking = rankCandidates(color.lab, palette, [], opts);
    assert.equal(ranking[0].colorId, color.id);
    assert.equal(ranking[0].distance, 0);
    assert.equal(ranking.length, palette.colors.length, 'one entry per canonical id');
  }
});

test('top matches are sorted, unique, and carry distances only', () => {
  const ranking = rankCandidates([20, 4, -20], palette, [], opts);
  const summary = summarizeRanking(ranking, config.matching);
  assert.equal(summary.top.length, 3);
  assert.deepEqual(Object.keys(summary.top[0]).sort(), ['colorId', 'distance', 'source']);
  assert.equal(new Set(summary.top.map((m) => m.colorId)).size, 3);
  for (let i = 1; i < 3; i++) assert.ok(summary.top[i].distance >= summary.top[i - 1].distance);
  assert.equal(summary.bestId, 'navy');
  assert.deepEqual(new Set(summary.top.map((m) => m.colorId)), new Set(['navy', 'dark-blue', 'indigo']));
});

test('exact ties break by id', () => {
  const tied = createPaletteIndex({
    ...loadPalette(),
    colors: [
      { ...loadPalette().colors.find((c) => c.id === 'navy'), id: 'zeta' },
      { ...loadPalette().colors.find((c) => c.id === 'navy'), id: 'alpha' },
    ],
  });
  const ranking = rankCandidates([30, 0, 0], tied, [], opts);
  assert.deepEqual(ranking.map((r) => r.colorId), ['alpha', 'zeta']);
});

test('approved profiles compete with a +2 penalty and never add duplicate ids', () => {
  const query = [45, 10, -40];
  const seedDistance = deltaE2000Lab(query, palette.byId.get('royal-blue').lab);
  const profile = { id: 'p1', colorId: 'royal-blue', lab: query, status: 'approved' };
  const ranking = rankCandidates(query, palette, [profile], opts);
  const entry = ranking.find((r) => r.colorId === 'royal-blue');
  assert.equal(entry.distance, Math.min(seedDistance, 2));
  assert.equal(entry.source, seedDistance > 2 ? 'profile' : 'seed');
  assert.equal(ranking.filter((r) => r.colorId === 'royal-blue').length, 1);
  // Profiles for unknown ids are ignored.
  const withUnknown = rankCandidates(query, palette, [{ ...profile, colorId: 'nope' }], opts);
  assert.equal(withUnknown.length, palette.colors.length);
});

test('far-away colors are unrecognized; mid distances are uncertain', () => {
  const neon = rgbToLab([0, 255, 64]);
  const s = summarizeRanking(rankCandidates(neon, palette, [], opts), config.matching);
  assert.ok(s.d1 > 18, `neon green d1 ${s.d1}`);
  assert.equal(s.recognized, false);
  const near = summarizeRanking(rankCandidates([50, 20, -20], palette, [], opts), config.matching);
  assert.equal(near.recognized, near.d1 <= 18);
  assert.equal(near.uncertain, near.d1 > 10);
});
