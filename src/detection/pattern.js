/**
 * Multicolor detection and pattern-vs-illumination evidence (blueprint §8).
 *
 * Color criteria: >= 2 significant clusters (>= 15% of samples) at least
 * 15 ΔE00 apart, covering >= 70% of the target together.
 *
 * Spatial criteria use a 128x128 diagnostic image. Each pixel is labeled with
 * its nearest cluster; boundary edges between different labels are "sharp"
 * when neighboring pixels differ by >= 8 ΔE76.
 *
 * Deviation (documented in README): the blueprint measures edge sharpness as
 * a lightness difference only. That rejects sharp equal-lightness hue edges
 * such as red/blue stripes (ΔL ≈ 7), so we use the full Lab difference, which
 * equals ΔL for the pure-lightness shadow edges the rule was designed around.
 */
import { SRGB8_TO_LINEAR, linearRgbToLab } from '../color/srgb-lab.js';

/**
 * Box-average the crop down to size x size in linear light (alpha-aware),
 * optionally applying calibration gains, then convert to Lab.
 */
export function buildDiagnosticImage(rgba, width, height, { size, alphaMin, gains = null }) {
  const lab = new Float64Array(size * size * 3);
  const valid = new Uint8Array(size * size);
  const x0 = new Int32Array(size);
  const x1 = new Int32Array(size);
  const y0 = new Int32Array(size);
  const y1 = new Int32Array(size);
  for (let o = 0; o < size; o++) {
    x0[o] = Math.floor((o * width) / size);
    x1[o] = Math.min(width, Math.max(x0[o] + 1, Math.floor(((o + 1) * width) / size)));
    y0[o] = Math.floor((o * height) / size);
    y1[o] = Math.min(height, Math.max(y0[o] + 1, Math.floor(((o + 1) * height) / size)));
  }
  const gr = gains ? gains[0] : 1;
  const gg = gains ? gains[1] : 1;
  const gb = gains ? gains[2] : 1;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = y0[oy]; y < y1[oy]; y++) {
        let p = (y * width + x0[ox]) * 4;
        for (let x = x0[ox]; x < x1[ox]; x++, p += 4) {
          if (rgba[p + 3] < alphaMin) continue;
          r += SRGB8_TO_LINEAR[rgba[p]];
          g += SRGB8_TO_LINEAR[rgba[p + 1]];
          b += SRGB8_TO_LINEAR[rgba[p + 2]];
          count++;
        }
      }
      if (!count) continue;
      const o = oy * size + ox;
      valid[o] = 1;
      linearRgbToLab(
        Math.min(1, (r / count) * gr),
        Math.min(1, (g / count) * gg),
        Math.min(1, (b / count) * gb),
        lab,
        o * 3,
      );
    }
  }
  return { size, lab, valid };
}

/** Label each diagnostic pixel with the final cluster of its nearest k-means center. */
export function labelDiagnostic(diag, centers, k, centerToCluster) {
  const n = diag.size * diag.size;
  const labels = new Int8Array(n).fill(-1);
  const { lab, valid } = diag;
  for (let p = 0; p < n; p++) {
    if (!valid[p]) continue;
    let best = -1;
    let bestD = Infinity;
    for (let c = 0; c < k; c++) {
      if (centerToCluster[c] < 0) continue;
      const dL = lab[p * 3] - centers[c * 3];
      const da = lab[p * 3 + 1] - centers[c * 3 + 1];
      const db = lab[p * 3 + 2] - centers[c * 3 + 2];
      const d = dL * dL + da * da + db * db;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best >= 0) labels[p] = centerToCluster[best];
  }
  return labels;
}

/** Boundary sharpness and 4x4 grid occupancy per cluster. */
export function measureSpatialEvidence(diag, labels, clusterCount, cfg) {
  const { size, lab } = diag;
  const sharp2 = cfg.sharpEdgeMinDE76 * cfg.sharpEdgeMinDE76;
  let boundaryEdges = 0;
  let sharpEdges = 0;
  const edge = (p, q) => {
    const lq = labels[q];
    if (lq < 0 || lq === labels[p]) return;
    boundaryEdges++;
    const dL = lab[p * 3] - lab[q * 3];
    const da = lab[p * 3 + 1] - lab[q * 3 + 1];
    const db = lab[p * 3 + 2] - lab[q * 3 + 2];
    if (dL * dL + da * da + db * db >= sharp2) sharpEdges++;
  };
  const grid = cfg.occupancyGrid;
  const cells = grid * grid;
  const cellTotals = new Int32Array(cells);
  const cellCounts = new Int32Array(cells * clusterCount);
  for (let y = 0; y < size; y++) {
    const cy = Math.floor((y * grid) / size);
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const lp = labels[p];
      if (lp < 0) continue;
      if (x + 1 < size) edge(p, p + 1);
      if (y + 1 < size) edge(p, p + size);
      const cell = cy * grid + Math.floor((x * grid) / size);
      cellTotals[cell]++;
      cellCounts[cell * clusterCount + lp]++;
    }
  }
  const occupiedCells = new Array(clusterCount).fill(0);
  for (let cell = 0; cell < cells; cell++) {
    const total = cellTotals[cell];
    if (!total) continue;
    for (let c = 0; c < clusterCount; c++) {
      if (cellCounts[cell * clusterCount + c] >= cfg.cellOccupancyFraction * total) occupiedCells[c]++;
    }
  }
  return {
    boundaryEdges,
    sharpEdges,
    sharpBoundaryFraction: boundaryEdges ? sharpEdges / boundaryEdges : 0,
    occupiedCells,
  };
}

/** Color-only multicolor candidacy for a list of {lab, fraction} clusters. */
export function multicolorColorCriteria(clusters, distance, cfg) {
  const significant = [];
  clusters.forEach((c, i) => {
    if (c.fraction >= cfg.significantFraction) significant.push(i);
  });
  const pairs = [];
  for (let a = 0; a < significant.length; a++) {
    for (let b = a + 1; b < significant.length; b++) {
      const i = significant[a];
      const j = significant[b];
      const d = distance(clusters[i].lab, clusters[j].lab);
      if (d >= cfg.pairMinDistance) pairs.push({ i, j, distance: d });
    }
  }
  const coverage = significant.reduce((sum, i) => sum + clusters[i].fraction, 0);
  return { significant, pairs, coverage, candidate: pairs.length > 0 && coverage >= cfg.minSignificantCoverage };
}

/**
 * Decide single / multicolor / ambiguous.
 * `clusters` and `stabilityClusters` are sorted by fraction, largest first.
 */
export function classifyPattern({ clusters, stabilityClusters, spatial, distance, cfg }) {
  const criteria = multicolorColorCriteria(clusters, distance, cfg);
  const criteria2 = stabilityClusters && stabilityClusters.length ? multicolorColorCriteria(stabilityClusters, distance, cfg) : null;

  let evidence = null;
  if (criteria.candidate) {
    if (spatial.sharpBoundaryFraction >= cfg.strongSharpFraction) evidence = 'sharp-boundaries';
    else if (
      spatial.sharpBoundaryFraction >= cfg.spreadSharpFraction &&
      criteria.pairs.some(
        (p) => spatial.occupiedCells[p.i] >= cfg.spreadMinCells && spatial.occupiedCells[p.j] >= cfg.spreadMinCells,
      )
    ) {
      evidence = 'distributed-pattern';
    }
  }

  let samplingAgreement = false;
  let maxProportionDelta = null;
  if (criteria.candidate && criteria2) {
    maxProportionDelta = 0;
    for (const i of criteria.significant) {
      let bestD = Infinity;
      let match = null;
      for (const c2 of stabilityClusters) {
        const d = distance(clusters[i].lab, c2.lab);
        if (d < bestD) {
          bestD = d;
          match = c2;
        }
      }
      maxProportionDelta = Math.max(maxProportionDelta, Math.abs(match.fraction - clusters[i].fraction));
    }
    samplingAgreement = criteria2.candidate && maxProportionDelta <= cfg.stabilityMaxProportionDelta;
  }

  const lightingAmbiguity = criteria.pairs.some(({ i, j }) => {
    const p = clusters[i].lab;
    const q = clusters[j].lab;
    return Math.abs(p[0] - q[0]) >= cfg.lightingMinDeltaL && Math.hypot(p[1] - q[1], p[2] - q[2]) < cfg.lightingMaxChromaDistance;
  });

  let status = 'single';
  if (criteria.candidate) status = evidence && samplingAgreement ? 'multicolor' : 'ambiguous';

  let accent = null;
  let primaryShare = 1;
  if (status === 'single' && clusters.length > 1) {
    const primary = clusters[0];
    primaryShare = 0;
    clusters.forEach((c, i) => {
      const d = i === 0 ? 0 : distance(primary.lab, c.lab);
      if (d < cfg.pairMinDistance) primaryShare += c.fraction;
      else if (!accent && c.fraction >= cfg.accentMinFraction && c.fraction < cfg.significantFraction) {
        accent = { index: i, fraction: c.fraction };
      }
    });
  }
  // Addition to the blueprint: a single-color answer whose color (plus its
  // near shades) covers under half the target is flagged as mixed colors.
  const mixed = status === 'single' && primaryShare < cfg.mixedLargestBelow;

  return {
    status,
    criteria,
    stabilityCandidate: criteria2 ? criteria2.candidate : null,
    evidence,
    samplingAgreement,
    maxProportionDelta,
    lightingAmbiguity,
    accent,
    primaryShare,
    mixed,
  };
}
