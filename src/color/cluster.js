/**
 * Lightweight deterministic clustering in CIELAB (blueprint §8).
 *
 * - k = 1..maxK on unaveraged Lab samples.
 * - Deterministic farthest-point initialization, run twice: first center is
 *   (A) the sample nearest the component-wise median, (B) the sample farthest
 *   from it. The run with smaller within-cluster SSE is kept.
 * - Lloyd assignments use squared Euclidean Lab distance (ΔE76²); CIEDE2000
 *   is only used for merge decisions and final metrics.
 * - k is chosen by minimizing N·ln(max(SSE/N, 1)) + penalty·k·ln(N).
 * - Clusters whose representatives are closer than `mergeBelow` (ΔE00) merge.
 *   A representative is the actual sample nearest the component-wise median.
 *
 * Samples are a Float64Array of length 3n: [L0,a0,b0, L1,a1,b1, ...].
 */

function dist2(labs, i, centers, c) {
  const dL = labs[i * 3] - centers[c * 3];
  const da = labs[i * 3 + 1] - centers[c * 3 + 1];
  const db = labs[i * 3 + 2] - centers[c * 3 + 2];
  return dL * dL + da * da + db * db;
}

function dist2Point(labs, i, p) {
  const dL = labs[i * 3] - p[0];
  const da = labs[i * 3 + 1] - p[1];
  const db = labs[i * 3 + 2] - p[2];
  return dL * dL + da * da + db * db;
}

function medianOfSorted(values) {
  const m = values.length >> 1;
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}

/** Component-wise median of the samples listed in `indices` (or all n). */
export function componentMedian(labs, indices, n = indices ? indices.length : labs.length / 3) {
  const L = new Float64Array(n);
  const A = new Float64Array(n);
  const B = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const i = indices ? indices[k] : k;
    L[k] = labs[i * 3];
    A[k] = labs[i * 3 + 1];
    B[k] = labs[i * 3 + 2];
  }
  L.sort();
  A.sort();
  B.sort();
  return [medianOfSorted(L), medianOfSorted(A), medianOfSorted(B)];
}

/** Index of the sample nearest `point`; ties resolve to the earliest listed. */
export function nearestSample(labs, indices, point, n = indices ? indices.length : labs.length / 3) {
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < n; k++) {
    const i = indices ? indices[k] : k;
    const d = dist2Point(labs, i, point);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function farthestSample(labs, n, point) {
  let best = 0;
  let bestD = -1;
  for (let i = 0; i < n; i++) {
    const d = dist2Point(labs, i, point);
    if (d > bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Farthest-point seeding: each next center is the sample maximizing the
 * distance to its nearest existing center. Stops early when every residual
 * is zero (fewer distinct colors than kMax).
 */
export function farthestPointSeeds(labs, n, kMax, firstIndex) {
  const centers = new Float64Array(kMax * 3);
  const minD = new Float64Array(n).fill(Infinity);
  let k = 0;
  let next = firstIndex;
  while (k < kMax) {
    centers[k * 3] = labs[next * 3];
    centers[k * 3 + 1] = labs[next * 3 + 1];
    centers[k * 3 + 2] = labs[next * 3 + 2];
    k++;
    if (k === kMax) break;
    let best = -1;
    let bestD = 0;
    for (let i = 0; i < n; i++) {
      const d = dist2(labs, i, centers, k - 1);
      if (d < minD[i]) minD[i] = d;
      if (minD[i] > bestD) {
        bestD = minD[i];
        best = i;
      }
    }
    if (best < 0) break;
    next = best;
  }
  return { centers, k };
}

function assign(labs, n, centers, k, labels, resid) {
  let sse = 0;
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bestD = dist2(labs, i, centers, 0);
    for (let c = 1; c < k; c++) {
      const d = dist2(labs, i, centers, c);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    labels[i] = best;
    resid[i] = bestD;
    sse += bestD;
  }
  return sse;
}

/** Bounded Lloyd iterations with empty-cluster reseeding. */
export function lloyd(labs, n, seedCenters, k, { maxIterations, convergenceDE76 }) {
  const centers = seedCenters.slice(0, k * 3);
  const labels = new Uint8Array(n);
  const resid = new Float64Array(n);
  const sums = new Float64Array(k * 3);
  const counts = new Int32Array(k);
  let iterations = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    assign(labs, n, centers, k, labels, resid);
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      counts[c]++;
      sums[c * 3] += labs[i * 3];
      sums[c * 3 + 1] += labs[i * 3 + 1];
      sums[c * 3 + 2] += labs[i * 3 + 2];
    }
    let maxMove = 0;
    for (let c = 0; c < k; c++) {
      let nL;
      let na;
      let nb;
      if (counts[c] > 0) {
        nL = sums[c * 3] / counts[c];
        na = sums[c * 3 + 1] / counts[c];
        nb = sums[c * 3 + 2] / counts[c];
      } else {
        // Reseed an empty cluster with the sample farthest from its center.
        let far = -1;
        let farD = 0;
        for (let i = 0; i < n; i++) {
          if (resid[i] > farD) {
            farD = resid[i];
            far = i;
          }
        }
        if (far < 0) continue; // all residuals zero: nothing better to do
        resid[far] = 0;
        nL = labs[far * 3];
        na = labs[far * 3 + 1];
        nb = labs[far * 3 + 2];
      }
      const move = Math.hypot(nL - centers[c * 3], na - centers[c * 3 + 1], nb - centers[c * 3 + 2]);
      if (move > maxMove) maxMove = move;
      centers[c * 3] = nL;
      centers[c * 3 + 1] = na;
      centers[c * 3 + 2] = nb;
    }
    if (maxMove < convergenceDE76) break;
  }
  const sse = assign(labs, n, centers, k, labels, resid);
  return { k, centers, labels, sse, iterations };
}

/** Penalized distortion criterion (blueprint §8). Lower is better. */
export function modelCost(sse, n, k, penaltyPerCluster) {
  return n * Math.log(Math.max(sse / n, 1)) + penaltyPerCluster * k * Math.log(n);
}

/** Fit k = 1..maxK with two deterministic initializations; select by cost. */
export function fitKMeans(labs, n, cfg) {
  if (!(n > 0)) throw new RangeError('No samples to cluster');
  const median = componentMedian(labs, null, n);
  const firstA = nearestSample(labs, null, median, n);
  const firstB = farthestSample(labs, n, median);
  const seedSets = [farthestPointSeeds(labs, n, cfg.maxK, firstA)];
  if (firstB !== firstA) seedSets.push(farthestPointSeeds(labs, n, cfg.maxK, firstB));

  const candidates = [];
  let best = null;
  for (let k = 1; k <= cfg.maxK; k++) {
    let bestForK = null;
    for (const seeds of seedSets) {
      if (seeds.k < k) continue;
      const fit = lloyd(labs, n, seeds.centers, k, cfg);
      if (!bestForK || fit.sse < bestForK.sse) bestForK = fit;
      if (k === 1) break; // both initializations converge to the same mean
    }
    if (!bestForK) break; // fewer distinct samples than k
    const cost = modelCost(bestForK.sse, n, k, cfg.penaltyPerCluster);
    candidates.push({ k, sse: bestForK.sse, cost, iterations: bestForK.iterations });
    if (!best || cost < best.cost) best = { ...bestForK, cost };
  }
  return { ...best, candidates };
}

function makeCluster(labs, members, artifactMask, minRemainingFraction, centerIds) {
  let repMembers = members;
  if (artifactMask) {
    const kept = members.filter((i) => !artifactMask[i]);
    if (kept.length < members.length && kept.length > minRemainingFraction * members.length) repMembers = kept;
  }
  const median = componentMedian(labs, repMembers);
  const repIndex = nearestSample(labs, repMembers, median);
  return {
    members,
    count: members.length,
    repIndex,
    lab: [labs[repIndex * 3], labs[repIndex * 3 + 1], labs[repIndex * 3 + 2]],
    artifactsExcluded: members.length - repMembers.length,
    centerIds,
  };
}

/**
 * Turn k-means labels into clusters with representatives, then repeatedly
 * merge the closest pair whose representative distance < mergeBelow.
 * Returns clusters sorted by size (desc) and the k-means-center -> cluster map.
 */
export function buildClusters(labs, n, fit, { distance, mergeBelow, artifactMask = null, minRemainingFraction = 0.5 }) {
  const memberLists = Array.from({ length: fit.k }, () => []);
  for (let i = 0; i < n; i++) memberLists[fit.labels[i]].push(i);
  let clusters = [];
  memberLists.forEach((members, c) => {
    if (members.length) clusters.push(makeCluster(labs, members, artifactMask, minRemainingFraction, [c]));
  });

  const merges = [];
  while (clusters.length > 1) {
    let bi = -1;
    let bj = -1;
    let bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = distance(clusters[i].lab, clusters[j].lab);
        if (d < bestD) {
          bestD = d;
          bi = i;
          bj = j;
        }
      }
    }
    if (!(bestD < mergeBelow)) break;
    const members = clusters[bi].members.concat(clusters[bj].members).sort((p, q) => p - q);
    const centerIds = clusters[bi].centerIds.concat(clusters[bj].centerIds);
    merges.push({ centers: centerIds, distance: bestD });
    clusters[bi] = makeCluster(labs, members, artifactMask, minRemainingFraction, centerIds);
    clusters.splice(bj, 1);
  }

  clusters.sort((p, q) => q.count - p.count || p.members[0] - q.members[0]);
  const centerToCluster = new Int8Array(fit.k).fill(-1);
  clusters.forEach((cl, idx) => {
    for (const c of cl.centerIds) centerToCluster[c] = idx;
  });
  return { clusters, centerToCluster, merges };
}
