/**
 * Developer/debug view (opt-in): sampled region with sample points, the
 * diagnostic label map, representative RGB/Lab, cluster fractions, ΔE00
 * rankings, score components, caps, pattern evidence and timings.
 * Disabled entirely when APP_CONFIG.debugAvailable is false.
 */
import { rgbToHex } from '../color/srgb-lab.js';
import { context2d, createCanvas, extractRegion } from '../image-input.js';
import { h } from './dom.js';
import { formatLab } from './format.js';

const fmt = (v, d = 2) => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(d) : String(v)) : String(v));

function sampleCanvas(app, result, debug) {
  const image = app.state.image;
  if (!image) return null;
  const crop = extractRegion(image.canvas, result.roi, app.config.input.cropMaxEdge);
  const scale = Math.min(1, 320 / Math.max(crop.width, crop.height));
  const w = Math.max(1, Math.round(crop.width * scale));
  const hgt = Math.max(1, Math.round(crop.height * scale));
  const src = createCanvas(crop.width, crop.height);
  context2d(src).putImageData(new ImageData(crop.rgba, crop.width, crop.height), 0, 0);
  const canvas = createCanvas(w, hgt);
  const ctx = context2d(canvas);
  ctx.drawImage(src, 0, 0, w, hgt);
  const colors = result.clusters.map((c) => `rgb(${c.rgb.join(',')})`);
  const n = debug.sampleLabels.length;
  const step = Math.max(1, Math.floor(n / 1200));
  for (let v = 0; v < n; v += step) {
    const x = debug.samplePositions[v * 2] * scale;
    const y = debug.samplePositions[v * 2 + 1] * scale;
    ctx.fillStyle = colors[debug.sampleLabels[v]] ?? '#f0f';
    ctx.strokeStyle = debug.artifactMask[v] ? '#f0f' : 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Analyzed crop with sample points colored by cluster');
  return canvas;
}

function labelCanvas(result, debug) {
  const size = debug.diagnosticSize;
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  const img = ctx.createImageData(size, size);
  for (let p = 0; p < size * size; p++) {
    const label = debug.diagnosticLabels[p];
    const rgb = label >= 0 ? result.clusters[label]?.rgb ?? [255, 0, 255] : [0, 0, 0];
    img.data.set([...rgb, 255], p * 4);
  }
  ctx.putImageData(img, 0, 0);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Diagnostic label map');
  return canvas;
}

function table(headers, rows) {
  return h(
    'table',
    {},
    h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', { text: t })))),
    h('tbody', {}, ...rows.map((cells) => h('tr', {}, ...cells.map((c) => h('td', {}, c))))),
  );
}

export function renderDebugPanel(app, result, debug) {
  const name = (id) => app.palette.byId.get(id)?.name ?? id;
  const clusterRows = result.clusters.map((c, i) => {
    const d = debug.clusters[i];
    return [
      h('span', {}, h('span', { class: 'swatch swatch--sm', style: { background: `rgb(${c.rgb.join(',')})` }, 'aria-hidden': 'true' }), ` #${i}`),
      `${fmt(c.fraction * 100, 1)}%`,
      `${rgbToHex(c.rgb)} (${c.rgb.join(', ')})`,
      formatLab(c.lab, 2),
      fmt(c.spreadMedianDE00),
      d.ranking.slice(0, 5).map((m) => `${name(m.colorId)} ${fmt(m.distance)}${m.source === 'profile' ? '*' : ''}`).join(', '),
      `${c.confidence} (raw ${d.rawScore}${d.caps.length ? `; caps ${d.caps.join(', ')}` : ''})`,
      `fit ${fmt(d.components.fit)} · margin ${fmt(d.components.margin)} · compact ${fmt(d.components.compact)} · stab ${fmt(d.components.stability)} (ΔE ${fmt(d.stabilityDistance)}) · quality ${fmt(d.components.quality)}`,
      `black ${fmt(d.nearBlackFraction * 100, 1)}% / white ${fmt(d.nearWhiteFraction * 100, 1)}% · artifacts excl. ${d.artifactsExcluded}`,
      c.laundryGroup,
    ];
  });
  const sampled = sampleCanvas(app, result, debug);
  const pattern = debug.pattern;
  const spatial = debug.spatial;
  return h(
    'details',
    { class: 'debug' },
    h('summary', { text: 'Developer details' }),
    h(
      'div',
      { class: 'debug-body' },
      h(
        'div',
        { class: 'debug-canvases' },
        sampled ? h('figure', {}, sampled, h('figcaption', { text: `Sampled region ${debug.cropWidth}×${debug.cropHeight}, ${result.sampleCount} valid samples (magenta ring = possible artifact)` })) : null,
        h('figure', {}, labelCanvas(result, debug), h('figcaption', { text: `Diagnostic ${debug.diagnosticSize}×${debug.diagnosticSize} labels` })),
      ),
      table(['Cluster', 'Area', 'Representative RGB', 'Representative Lab', 'Spread ΔE00', 'Nearest (ΔE00)', 'Score', 'Components', 'Clip', 'Group'], clusterRows),
      table(
        ['k', 'SSE', 'Cost'],
        debug.kCandidates.map((c) => [String(c.k) + (c.k === debug.selectedK ? ' ✓' : ''), fmt(c.sse, 0), fmt(c.cost, 1)]),
      ),
      h(
        'pre',
        {
          text: [
            `pattern: ${pattern.status} · evidence ${pattern.evidence ?? 'none'} · seed-2 agreement ${pattern.samplingAgreement} (candidate ${pattern.stabilityCandidate}, max Δ ${fmt(pattern.maxProportionDelta)})`,
            `significant ${JSON.stringify(pattern.significant)} · coverage ${fmt(pattern.coverage)} · pairs ${pattern.pairs.map((p) => `${p.i}-${p.j}:${fmt(p.distance)}`).join(' ') || 'none'}`,
            `sharp boundary ${fmt(spatial.sharpBoundaryFraction)} (${spatial.sharpEdges}/${spatial.boundaryEdges}) · occupied cells ${JSON.stringify(spatial.occupiedCells)}`,
            `lighting ambiguity ${pattern.lightingAmbiguity} · accent ${JSON.stringify(pattern.accent)} · primary share ${fmt(pattern.primaryShare)} · mixed ${pattern.mixed}`,
            `merges ${debug.merges.map((m) => `[${m.centers}]@${fmt(m.distance)}`).join(' ') || 'none'} · seed-2 clusters ${debug.stabilityClusters.map((c) => `${fmt(c.fraction * 100, 1)}%`).join(' ')}`,
            `timings ms: sample ${fmt(debug.timings.sampleMs, 1)} · cluster ${fmt(debug.timings.clusterMs, 1)} · spatial ${fmt(debug.timings.spatialMs, 1)} · match ${fmt(debug.timings.matchMs, 1)} · total ${fmt(debug.timings.totalMs, 1)} · engine ${app.detector.mode}`,
            `versions: detector ${result.detectorVersion} · config ${result.configVersion} · palette ${result.paletteVersion} · grouping ${result.groupingVersion} · profiles ${result.profileSetVersion}`,
          ].join('\n'),
        },
      ),
      h('details', {}, h('summary', { text: 'Result JSON' }), h('pre', { text: JSON.stringify(result, null, 2) })),
    ),
  );
}
