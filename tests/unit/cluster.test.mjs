import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClusters, componentMedian, farthestPointSeeds, fitKMeans, lloyd, modelCost, nearestSample,
} from '../../src/color/cluster.js';
import { deltaE2000Lab } from '../../src/color/delta-e-2000.js';
import { mulberry32 } from '../../src/detection/sampling.js';
import { loadConfig } from '../helpers.mjs';

const cfg = loadConfig().clustering;

function blobs(specs, seed = 3) {
  const rand = mulberry32(seed);
  const points = [];
  for (const { center, count, spread } of specs) {
    for (let i = 0; i < count; i++) points.push(center.map((c) => c + (rand() - 0.5) * 2 * spread));
  }
  return { labs: Float64Array.from(points.flat()), n: points.length };
}

test('component-wise median (odd and even counts)', () => {
  const labs = Float64Array.from([1, 10, -5, 3, 20, 5, 2, 30, 0]);
  assert.deepEqual(componentMedian(labs, null, 3), [2, 20, 0]);
  assert.deepEqual(componentMedian(labs, [0, 1], 2), [2, 15, 0]);
});

test('nearest sample ties resolve to the earliest index', () => {
  const labs = Float64Array.from([0, 0, 0, 2, 0, 0, 1, 0, 0]);
  assert.equal(nearestSample(labs, [0, 1], [1, 0, 0]), 0);
  assert.equal(nearestSample(labs, null, [1, 0, 0], 3), 2);
});

test('farthest-point seeding stops when every residual is zero', () => {
  const labs = new Float64Array(30).fill(7);
  const seeds = farthestPointSeeds(labs, 10, 5, 0);
  assert.equal(seeds.k, 1);
});

test('identical samples: k=1, zero SSE, finite cost', () => {
  const labs = new Float64Array(3000).fill(42);
  const fit = fitKMeans(labs, 1000, cfg);
  assert.equal(fit.k, 1);
  assert.equal(fit.sse, 0);
  assert.ok(Number.isFinite(fit.cost));
});

test('model cost floors the per-sample distortion at 1', () => {
  assert.equal(modelCost(0, 100, 1, 4), 4 * Math.log(100));
  assert.equal(modelCost(50, 100, 2, 4), 8 * Math.log(100));
  assert.ok(modelCost(1000, 100, 1, 4) > modelCost(50, 100, 2, 4));
});

test('two tight, distant blobs select k = 2 with correct sizes', () => {
  const { labs, n } = blobs([
    { center: [20, 5, -20], count: 600, spread: 0.4 },
    { center: [90, 0, 2], count: 400, spread: 0.4 },
  ]);
  const fit = fitKMeans(labs, n, cfg);
  assert.equal(fit.k, 2);
  const built = buildClusters(labs, n, fit, { distance: deltaE2000Lab, mergeBelow: cfg.mergeBelow });
  assert.deepEqual(built.clusters.map((c) => c.count), [600, 400]);
});

test('clustering is deterministic', () => {
  const { labs, n } = blobs([
    { center: [30, 10, 10], count: 500, spread: 6 },
    { center: [60, -20, 30], count: 500, spread: 6 },
    { center: [80, 0, 0], count: 300, spread: 3 },
  ]);
  const a = fitKMeans(labs, n, cfg);
  const b = fitKMeans(labs, n, cfg);
  assert.equal(a.k, b.k);
  assert.deepEqual(a.labels, b.labels);
  assert.deepEqual(a.centers, b.centers);
});

test('representatives are actual samples', () => {
  const { labs, n } = blobs([{ center: [50, 20, -10], count: 777, spread: 5 }]);
  const fit = fitKMeans(labs, n, cfg);
  const built = buildClusters(labs, n, fit, { distance: deltaE2000Lab, mergeBelow: cfg.mergeBelow });
  for (const c of built.clusters) {
    const i = c.repIndex;
    assert.deepEqual(c.lab, [labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]]);
    assert.ok(c.members.includes(i));
  }
});

test('noise splits of one color merge back below 6 ΔE00', () => {
  const { labs, n } = blobs([{ center: [50, 20, -10], count: 2000, spread: 4 }]);
  const fit = fitKMeans(labs, n, cfg);
  assert.ok(fit.k > 1, 'criterion over-splits noisy data by design');
  const built = buildClusters(labs, n, fit, { distance: deltaE2000Lab, mergeBelow: cfg.mergeBelow });
  assert.equal(built.clusters.length, 1);
  assert.equal(built.clusters[0].count, n);
  for (let c = 0; c < fit.k; c++) assert.equal(built.centerToCluster[c], 0);
});

test('distinct colors are never merged', () => {
  const { labs, n } = blobs([
    { center: [5, 0, -2], count: 500, spread: 1 },
    { center: [100, 0, 0], count: 500, spread: 1 },
  ]);
  const fit = fitKMeans(labs, n, cfg);
  const built = buildClusters(labs, n, fit, { distance: deltaE2000Lab, mergeBelow: cfg.mergeBelow });
  assert.equal(built.clusters.length, 2);
});

test('empty clusters are reseeded with the farthest residual sample', () => {
  const { labs, n } = blobs([
    { center: [20, 0, 0], count: 100, spread: 1 },
    { center: [80, 0, 0], count: 100, spread: 1 },
  ]);
  // Duplicate seed centers force an empty cluster on the first assignment.
  const seeds = Float64Array.from([20, 0, 0, 20, 0, 0]);
  const fit = lloyd(labs, n, seeds, 2, cfg);
  const counts = [0, 0];
  for (let i = 0; i < n; i++) counts[fit.labels[i]]++;
  assert.ok(counts[0] > 0 && counts[1] > 0, `counts ${counts}`);
  assert.ok(Number.isFinite(fit.sse));
});

test('artifact samples are excluded from the representative only when >50% remain', () => {
  const labs = Float64Array.from([50, 0, 0, 50, 0, 0, 50, 0, 0, 99, 0, 0, 99, 0, 0]);
  const fit = { k: 1, labels: new Uint8Array(5) };
  const mask = Uint8Array.from([0, 0, 0, 1, 1]);
  const built = buildClusters(labs, 5, fit, { distance: deltaE2000Lab, mergeBelow: 6, artifactMask: mask });
  assert.equal(built.clusters[0].artifactsExcluded, 2);
  assert.equal(built.clusters[0].lab[0], 50);
  const allArtifacts = Uint8Array.from([1, 1, 1, 1, 1]);
  const kept = buildClusters(labs, 5, fit, { distance: deltaE2000Lab, mergeBelow: 6, artifactMask: allArtifacts });
  assert.equal(kept.clusters[0].artifactsExcluded, 0);
});
