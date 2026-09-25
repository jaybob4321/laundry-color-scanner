/**
 * Detection pipeline (blueprint §1, §20):
 *   crop -> stratified sampling -> optional calibration -> Lab -> clustering
 *   -> second jittered sample (stability) -> spatial pattern evidence
 *   -> reference matching -> ordered grouping -> heuristic confidence.
 *
 * Pure: no DOM, no storage, configuration passed explicitly. Runs inside the
 * detector worker, and on the main thread (chunked) if the worker fails.
 */
import { buildClusters, fitKMeans } from '../color/cluster.js';
import { getDistanceMethod } from '../color/delta-e-2000.js';
import { rankCandidates, summarizeRanking } from '../color/match.js';
import { boundaryAlternatives, classifyGroup, groupForColor, groupingVersion, resolveGroupingRules } from '../grouping.js';
import { approvedProfiles, computeProfileSetVersion, createPaletteIndex } from '../references.js';
import { createId } from '../util/ids.js';
import { measureNeutralReference, validateCalibration } from './calibration.js';
import { applyCaps, baseCaps, clamp01, scoreComponents, weightedScore } from './confidence.js';
import { buildDiagnosticImage, classifyPattern, labelDiagnostic, measureSpatialEvidence } from './pattern.js';
import { SAMPLE_NEAR_BLACK, SAMPLE_NEAR_WHITE, findArtifactMask, measureRawQuality } from './quality.js';
import { sampleGrid, samplesToLab } from './sampling.js';

export const DETECTOR_VERSION = '1.0.0';

/** Recoverable, user-explainable failures. `code` drives the UI message. */
export class DetectorError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'DetectorError';
    this.code = code;
  }
}

const defaultClock = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

/**
 * Everything the pipeline needs besides pixels. Build once, reuse per scan.
 * `palette` may be the raw colors.json object or an existing palette index.
 */
export function createDetectorContext({ config, palette, profiles = [], groupingSettings = null, clock = defaultClock, now = Date.now, makeId = createId }) {
  if (!config || config.schemaVersion !== 1) throw new DetectorError('invalid-config');
  const paletteIndex = palette.byId instanceof Map ? palette : createPaletteIndex(palette);
  const active = approvedProfiles(profiles, paletteIndex);
  const rules = resolveGroupingRules(config.grouping, groupingSettings, paletteIndex);
  return {
    config,
    paletteIndex,
    profiles: active,
    rules,
    groupingVersion: groupingVersion(rules),
    profileSetVersion: computeProfileSetVersion(active),
    distance: getDistanceMethod(config.matching.distanceMethod),
    clock,
    now,
    makeId,
  };
}

function validateInput(input, config) {
  const { rgba, width, height } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new DetectorError('invalid-input', 'Invalid crop dimensions');
  }
  if (!rgba || rgba.length !== width * height * 4) throw new DetectorError('invalid-input', 'Pixel buffer size mismatch');
  if (input.source !== 'camera' && input.source !== 'upload') throw new DetectorError('invalid-input', 'Unknown source');
  const roi = input.roi;
  if (!roi || ['x', 'y', 'width', 'height'].some((k) => !Number.isFinite(roi[k]) || roi[k] < 0 || roi[k] > 1)) {
    throw new DetectorError('invalid-input', 'ROI must be normalized');
  }
  const src = input.sourceRoiPx ?? { width, height };
  if (Math.min(src.width, src.height) < config.input.minRoiPixels) throw new DetectorError('roi-too-small');
}

function median(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function summarizeClusters(built, conv, rawFlags, n, distance) {
  const { lab, displayRgb, gridIndex } = conv;
  return built.clusters.map((cl) => {
    const rep = cl.lab;
    const d = new Float64Array(cl.count);
    let nearBlack = 0;
    let nearWhite = 0;
    cl.members.forEach((i, k) => {
      d[k] = distance([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]], rep);
      const f = rawFlags[gridIndex[i]];
      if (f & SAMPLE_NEAR_BLACK) nearBlack++;
      if (f & SAMPLE_NEAR_WHITE) nearWhite++;
    });
    const r = cl.repIndex;
    return {
      lab: rep,
      rgb: [displayRgb[r * 3], displayRgb[r * 3 + 1], displayRgb[r * 3 + 2]],
      count: cl.count,
      fraction: cl.count / n,
      spreadMedianDE00: median(d),
      nearBlackFraction: nearBlack / cl.count,
      nearWhiteFraction: nearWhite / cl.count,
      artifactsExcluded: cl.artifactsExcluded,
    };
  });
}

function clusterSamples(conv, samples, config, distance) {
  const fit = fitKMeans(conv.lab, conv.n, config.clustering);
  const artifacts = findArtifactMask(conv.lab, conv.n, conv.gridIndex, samples.gridWidth, samples.gridHeight, config.artifacts);
  const built = buildClusters(conv.lab, conv.n, fit, {
    distance,
    mergeBelow: config.clustering.mergeBelow,
    artifactMask: artifacts.mask,
    minRemainingFraction: config.artifacts.minRemainingFraction,
  });
  return { fit, artifacts, built };
}

const finiteOrNull = (x) => (Number.isFinite(x) ? x : null);

/**
 * Generator form of the analysis; yields between stages so a main-thread
 * fallback can stay responsive. Returns { result, debug }.
 */
export function* analyzeSteps(input, ctx, { debug = false } = {}) {
  const { config } = ctx;
  const cc = config.confidence;
  const sCfg = config.sampling;
  const t0 = ctx.clock();
  const timings = {};
  validateInput(input, config);
  const flags = new Set();
  const grid = { gridWidth: sCfg.gridSize, gridHeight: sCfg.gridSize, alphaMin: sCfg.alphaMin };

  // 1. Sampling and raw quality (before calibration).
  const s1 = sampleGrid(input.rgba, input.width, input.height, { ...grid, seed: sCfg.primarySeed });
  if (s1.validCount < sCfg.minValidSamples) throw new DetectorError('too-few-samples');
  const raw = measureRawQuality(s1, sCfg);

  // 2. Optional calibration; discarded (not silently) if it clips the garment.
  let calibration = input.calibration ?? null;
  if (calibration && !validateCalibration(calibration, config.calibration).ok) throw new DetectorError('invalid-calibration');
  let gains = calibration ? calibration.gains : null;
  let conv1 = samplesToLab(s1, gains);
  const newlyClippedFraction = conv1.newlyClippedFraction;
  if (calibration && newlyClippedFraction > config.calibration.maxNewlyClippedFraction) {
    flags.add('calibration-discarded');
    calibration = null;
    gains = null;
    conv1 = samplesToLab(s1, null);
  }
  if (calibration) flags.add('calibrated');
  timings.sampleMs = ctx.clock() - t0;
  yield 'sampled';

  // 3. Clustering on unaveraged samples.
  const tCluster = ctx.clock();
  const n = conv1.n;
  const primaryFit = clusterSamples(conv1, s1, config, ctx.distance);
  if (primaryFit.artifacts.count) flags.add('possible-artifacts');
  const clusters = summarizeClusters(primaryFit.built, conv1, raw.flags, n, ctx.distance);
  yield 'clustered';

  // 4. Second jittered sample for stability and multicolor agreement.
  const s2 = sampleGrid(input.rgba, input.width, input.height, { ...grid, seed: sCfg.stabilitySeed });
  let stabilityClusters = [];
  if (s2.validCount >= sCfg.minValidSamples) {
    const conv2 = samplesToLab(s2, gains);
    const second = clusterSamples(conv2, s2, config, ctx.distance);
    stabilityClusters = second.built.clusters.map((cl) => ({ lab: cl.lab, fraction: cl.count / conv2.n }));
  }
  timings.clusterMs = ctx.clock() - tCluster;
  yield 'stability';

  // 5. Spatial evidence on the diagnostic image, then pattern classification.
  const tSpatial = ctx.clock();
  const diag = buildDiagnosticImage(input.rgba, input.width, input.height, {
    size: config.multicolor.diagnosticSize,
    alphaMin: sCfg.alphaMin,
    gains,
  });
  const diagLabels = labelDiagnostic(diag, primaryFit.fit.centers, primaryFit.fit.k, primaryFit.built.centerToCluster);
  const spatial = measureSpatialEvidence(diag, diagLabels, clusters.length, config.multicolor);
  const pattern = classifyPattern({ clusters, stabilityClusters, spatial, distance: ctx.distance, cfg: config.multicolor });
  timings.spatialMs = ctx.clock() - tSpatial;
  yield 'pattern';

  // 6. Matching and per-cluster scores.
  const tMatch = ctx.clock();
  const calibrated = calibration !== null;
  const clipFraction = raw.nearBlackFraction + raw.nearWhiteFraction;
  for (const c of clusters) {
    c.ranking = rankCandidates(c.lab, ctx.paletteIndex, ctx.profiles, {
      distance: ctx.distance,
      profilePenalty: config.matching.profilePenalty,
    });
    c.summary = summarizeRanking(c.ranking, config.matching);
    c.stabilityDistance = stabilityClusters.length ? Math.min(...stabilityClusters.map((s) => ctx.distance(c.lab, s.lab))) : Infinity;
    c.components = scoreComponents(
      {
        d1: c.summary.d1,
        d2: c.summary.d2,
        spread: c.spreadMedianDE00,
        stabilityDistance: c.stabilityDistance,
        nearBlackFraction: c.nearBlackFraction,
        nearWhiteFraction: c.nearWhiteFraction,
      },
      cc,
    );
    c.rawScore = weightedScore(c.components, cc.weights);
    const caps = baseCaps({ calibrated, clipFraction, d1: c.summary.d1 }, cc.caps);
    if (c.summary.d2 - c.summary.d1 < cc.caps.closeCallBelow) caps.push({ id: 'close-call', max: cc.caps.closeCall });
    const capped = applyCaps(c.rawScore, caps);
    c.score = capped.score;
    c.capsApplied = capped.applied;
    c.groupId = c.summary.recognized
      ? groupForColor(c.lab, ctx.rules.families[c.summary.bestId], c.summary.bestId, ctx.rules).groupId
      : 'other';
  }

  // 7. Result-level decision: grouping and confidence.
  const primary = clusters[0];
  const significant = pattern.criteria.significant.map((i) => clusters[i]);
  let detectedColorId = null;
  let group;
  let confidence;
  let groupConfidence;
  let groupAlternatives = [];
  let groupMargin = Infinity;
  if (pattern.status === 'multicolor') {
    group = { groupId: 'multicolor', rule: 'multicolor' };
    const caps = [{ id: 'multicolor', max: cc.caps.multicolor }];
    if (pattern.lightingAmbiguity) {
      flags.add('lighting-ambiguity');
      caps.push({ id: 'lighting-ambiguity', max: cc.caps.lightingAmbiguity });
    }
    confidence = applyCaps(Math.min(...significant.map((c) => c.score)), caps).score;
    groupConfidence = confidence;
  } else if (pattern.status === 'ambiguous') {
    flags.add('pattern-ambiguous');
    flags.add('needs-review');
    if (pattern.lightingAmbiguity) flags.add('lighting-ambiguity');
    group = { groupId: 'other', rule: 'needs-review' };
    confidence = Math.min(...significant.map((c) => c.score), cc.caps.patternAmbiguous);
    groupConfidence = confidence;
  } else {
    const s = primary.summary;
    if (s.recognized) {
      detectedColorId = s.bestId;
      if (s.uncertain) flags.add('uncertain-match');
    } else {
      flags.add('unrecognized');
      flags.add('needs-review');
    }
    if (s.d2 - s.d1 < cc.caps.closeCallBelow) flags.add('close-call');
    if (pattern.accent) flags.add('possible-accent');
    const resultCaps = [];
    if (pattern.mixed) {
      flags.add('mixed-colors');
      resultCaps.push({ id: 'mixed-colors', max: cc.caps.mixedColors });
    }
    group = classifyGroup({ patternStatus: 'single', recognized: s.recognized, lab: primary.lab, colorId: detectedColorId }, ctx.rules);
    confidence = applyCaps(primary.score, resultCaps).score;
    if (s.recognized) {
      for (const cand of primary.ranking) {
        const g = groupForColor(primary.lab, ctx.rules.families[cand.colorId], cand.colorId, ctx.rules).groupId;
        if (g !== group.groupId) {
          groupMargin = cand.distance - s.d1;
          break;
        }
      }
      const gComponents = { ...primary.components, margin: Number.isFinite(groupMargin) ? clamp01(groupMargin / cc.marginScale) : 1 };
      const gCaps = baseCaps({ calibrated, clipFraction, d1: s.d1 }, cc.caps).concat(resultCaps);
      if (groupMargin < cc.caps.closeCallBelow) gCaps.push({ id: 'close-call', max: cc.caps.closeCall });
      groupAlternatives = boundaryAlternatives(primary.lab, detectedColorId, ctx.rules);
      if (groupAlternatives.length) {
        flags.add('group-boundary');
        gCaps.push({ id: 'group-boundary', max: cc.caps.groupBoundary });
      }
      groupConfidence = applyCaps(weightedScore(gComponents, cc.weights), gCaps).score;
    } else {
      groupConfidence = confidence;
    }
  }
  if (clipFraction > cc.caps.nearClippingFraction) flags.add('near-clipping');
  if (raw.channelClipFraction > config.multicolor.channelClipFlagFraction) flags.add('channel-clipping');
  if (confidence < cc.labels.moderate) flags.add('low-confidence');
  timings.matchMs = ctx.clock() - tMatch;
  timings.totalMs = ctx.clock() - t0;

  const qualityMetrics = {
    validSampleFraction: raw.validFraction,
    nearBlackFraction: raw.nearBlackFraction,
    nearWhiteFraction: raw.nearWhiteFraction,
    channelClipFraction: raw.channelClipFraction,
    cropWidth: input.width,
    cropHeight: input.height,
    sourceRoiWidth: input.sourceRoiPx?.width ?? input.width,
    sourceRoiHeight: input.sourceRoiPx?.height ?? input.height,
    selectedK: primaryFit.fit.k,
    clusterCount: clusters.length,
    artifactSamples: primaryFit.artifacts.count,
    sharpBoundaryFraction: spatial.sharpBoundaryFraction,
    boundaryEdges: spatial.boundaryEdges,
    significantCoverage: pattern.criteria.coverage,
    primaryShare: pattern.primaryShare,
    stabilityClusterCount: stabilityClusters.length,
    sampleMs: timings.sampleMs,
    clusterMs: timings.clusterMs,
    spatialMs: timings.spatialMs,
    matchMs: timings.matchMs,
    totalMs: timings.totalMs,
  };
  if (input.calibration) qualityMetrics.newlyClippedFraction = newlyClippedFraction;
  if (pattern.maxProportionDelta !== null) qualityMetrics.maxProportionDelta = pattern.maxProportionDelta;
  if (Number.isFinite(primary.summary.d1)) qualityMetrics.primaryD1 = primary.summary.d1;
  if (Number.isFinite(primary.summary.d2)) qualityMetrics.primaryD2 = primary.summary.d2;
  if (Number.isFinite(groupMargin)) qualityMetrics.groupMarginDE00 = groupMargin;

  const result = {
    schemaVersion: 1,
    id: ctx.makeId(),
    createdAt: new Date(ctx.now()).toISOString(),
    detectorVersion: DETECTOR_VERSION,
    configVersion: config.configVersion,
    paletteVersion: ctx.paletteIndex.paletteVersion,
    groupingVersion: ctx.groupingVersion,
    profileSetVersion: ctx.profileSetVersion,
    source: input.source,
    roi: { x: input.roi.x, y: input.roi.y, width: input.roi.width, height: input.roi.height },
    calibration: calibration ? { ...calibration, gains: [...calibration.gains], referenceLinearRgb: [...calibration.referenceLinearRgb] } : null,
    clusters: clusters.map((c) => ({
      lab: [...c.lab],
      rgb: c.rgb,
      fraction: c.fraction,
      spreadMedianDE00: c.spreadMedianDE00,
      matches: c.summary.top,
      confidence: c.score,
      laundryGroup: c.groupId,
      scoreDetail: {
        ...c.components,
        raw: c.rawScore,
        caps: c.capsApplied,
        stabilityDE00: finiteOrNull(c.stabilityDistance),
        nearBlackFraction: c.nearBlackFraction,
        nearWhiteFraction: c.nearWhiteFraction,
      },
    })),
    detectedColorId,
    patternStatus: pattern.status,
    laundryGroup: group.groupId,
    groupRule: group.rule,
    groupAlternatives,
    confidence,
    groupConfidence,
    confidenceKind: 'heuristic',
    qualityFlags: [...flags],
    sampleCount: n,
    qualityMetrics,
  };

  let debugInfo = null;
  if (debug) {
    const positions = new Uint16Array(n * 2);
    const sampleLabels = new Int8Array(n);
    for (let v = 0; v < n; v++) {
      const g = conv1.gridIndex[v];
      positions[v * 2] = s1.x[g];
      positions[v * 2 + 1] = s1.y[g];
      sampleLabels[v] = primaryFit.built.centerToCluster[primaryFit.fit.labels[v]];
    }
    debugInfo = {
      cropWidth: input.width,
      cropHeight: input.height,
      samplePositions: positions,
      sampleLabels,
      artifactMask: primaryFit.artifacts.mask,
      diagnosticSize: diag.size,
      diagnosticLabels: diagLabels,
      kCandidates: primaryFit.fit.candidates,
      selectedK: primaryFit.fit.k,
      merges: primaryFit.built.merges,
      stabilityClusters,
      spatial,
      pattern: {
        status: pattern.status,
        evidence: pattern.evidence,
        samplingAgreement: pattern.samplingAgreement,
        stabilityCandidate: pattern.stabilityCandidate,
        maxProportionDelta: pattern.maxProportionDelta,
        lightingAmbiguity: pattern.lightingAmbiguity,
        accent: pattern.accent,
        primaryShare: pattern.primaryShare,
        mixed: pattern.mixed,
        significant: pattern.criteria.significant,
        pairs: pattern.criteria.pairs,
        coverage: pattern.criteria.coverage,
      },
      clusters: clusters.map((c) => ({
        ranking: c.ranking.slice(0, 8),
        components: c.components,
        rawScore: c.rawScore,
        caps: c.capsApplied,
        stabilityDistance: finiteOrNull(c.stabilityDistance),
        nearBlackFraction: c.nearBlackFraction,
        nearWhiteFraction: c.nearWhiteFraction,
        artifactsExcluded: c.artifactsExcluded,
        count: c.count,
      })),
      timings,
    };
  }
  return { result, debug: debugInfo };
}

/** Run the full analysis synchronously (worker / tests). */
export function analyzePixels(input, ctx, options) {
  const steps = analyzeSteps(input, ctx, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Main-thread fallback: same analysis, yielding to the event loop between stages. */
export async function analyzePixelsChunked(input, ctx, { signal, ...options } = {}) {
  const steps = analyzeSteps(input, ctx, options);
  let step = steps.next();
  while (!step.done) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (signal?.aborted) throw new DetectorError('canceled');
    step = steps.next();
  }
  return step.value;
}

/** Neutral-patch measurement with the context's calibration thresholds. */
export function measureCalibrationPatch({ rgba, width, height }, ctx) {
  const { config } = ctx;
  const minPatch = config.input.minPatchPixels;
  if (!Number.isInteger(width) || !Number.isInteger(height) || rgba?.length !== width * height * 4) {
    throw new DetectorError('invalid-input', 'Invalid reference patch');
  }
  if (Math.min(width, height) < minPatch) return { ok: false, code: 'calibration-too-few-samples', metrics: { sampleCount: 0 } };
  return measureNeutralReference(rgba, width, height, config.calibration, config.sampling.alphaMin);
}
