/**
 * Results: large swatch(es), color name, laundry group, heuristic match
 * confidence, closest matches, HEX/RGB, guidance, and next actions.
 * Multicolor never shows an averaged swatch.
 */
import { rgbToHex } from '../color/srgb-lab.js';
import { confidenceLabel } from '../detection/confidence.js';
import { groupLabel } from '../grouping.js';
import { renderDebugPanel } from './debug-view.js';
import { $, announce, clear, h, icon, swatch } from './dom.js';
import { componentBreakdown, formatDistance, formatLab, formatRgb } from './format.js';
import { CONFIDENCE_TOOLTIP, DISCLAIMER, flagMessages } from './messages.js';

export function createResultsScreen(app) {
  const body = $('#result-body');
  $('#btn-results-home').addEventListener('click', () => app.go('home'));
  $('#btn-results-adjust').addEventListener('click', () => app.go('crop', { returnTo: 'results' }));
  $('#btn-scan-another').addEventListener('click', () => app.scanAnother());
  $('#btn-correct').addEventListener('click', () => app.go('correction'));

  const colorName = (id) => app.palette.byId.get(id)?.name ?? id;

  function displayName(r) {
    if (r.patternStatus === 'multicolor') return 'Multicolor';
    if (r.patternStatus === 'ambiguous') return 'Pattern or shadow?';
    return r.detectedColorId ? colorName(r.detectedColorId) : 'Unrecognized color';
  }

  function hero(r, breakdown) {
    const multi = r.patternStatus !== 'single';
    const segments = multi
      ? breakdown.items.map(({ cluster, percent }) =>
          h('span', { style: { background: `rgb(${cluster.rgb.join(',')})`, width: `${Math.max(percent, 1)}%` } }),
        )
      : [h('span', { style: { background: `rgb(${r.clusters[0].rgb.join(',')})`, width: '100%' } })];
    if (multi && breakdown.otherPercent > 0) {
      segments.push(h('span', { style: { background: 'repeating-linear-gradient(45deg,#888 0 6px,#bbb 6px 12px)', width: `${breakdown.otherPercent}%` } }));
    }
    const describe = multi
      ? breakdown.items.map(({ cluster, percent }) => `${colorName(cluster.matches[0].colorId)} ${percent}%`).join(', ')
      : displayName(r);
    return h(
      'div',
      { class: 'result-hero' },
      h('div', { class: 'hero-swatch', role: 'img', 'aria-label': `Detected color swatch: ${describe}` }, ...segments),
      h('p', { class: 'eyebrow', text: 'Detected color' }),
      h('h2', { id: 'result-name', class: 'result-name', tabindex: '-1', text: displayName(r) }),
      multi ? h('p', { class: 'hint', text: describe + (breakdown.otherPercent ? `, other colors ${breakdown.otherPercent}%` : '') }) : null,
    );
  }

  function groupRow(r) {
    const needsReview = r.groupRule === 'needs-review';
    return h(
      'div',
      { class: 'group-row' },
      icon('basket'),
      h('div', {}, h('span', { text: 'Laundry group' }), h('strong', { text: groupLabel(r.laundryGroup) + (needsReview ? ' — needs review' : '') })),
    );
  }

  function confidenceBlock(r) {
    const cc = app.config.confidence;
    if (r.confidence === null) return null;
    const level = confidenceLabel(r.confidence, cc.labels);
    const tip = h('p', { class: 'confidence-note', id: 'confidence-tip', text: CONFIDENCE_TOOLTIP, hidden: true });
    const infoBtn = h('button', {
      class: 'info-btn',
      type: 'button',
      'aria-label': 'About match confidence',
      'aria-expanded': 'false',
      'aria-controls': 'confidence-tip',
      onClick: () => {
        tip.hidden = !tip.hidden;
        infoBtn.setAttribute('aria-expanded', String(!tip.hidden));
      },
    }, icon('info'));
    const lines = [
      h('div', { class: 'confidence-line' }, h('span', { text: `Match confidence: ${r.confidence}% · ${level}` }), infoBtn),
      h('div', { class: 'confidence-meter', 'aria-hidden': 'true' }, h('span', { style: { width: `${r.confidence}%` } })),
      tip,
    ];
    if (r.groupConfidence !== null && Math.abs(r.groupConfidence - r.confidence) >= cc.groupNoteDifference) {
      lines.push(
        h('p', {
          class: 'confidence-note',
          text: `Sorting confidence for ${groupLabel(r.laundryGroup)}: ${r.groupConfidence}% · ${confidenceLabel(r.groupConfidence, cc.labels)}`,
        }),
      );
    }
    return h('div', { class: 'confidence', dataset: { level } }, ...lines);
  }

  function messagesBlock(r) {
    const messages = flagMessages(r);
    if (r.patternStatus === 'multicolor') {
      const groups = new Set(r.clusters.filter((c) => c.fraction >= app.config.multicolor.significantFraction).map((c) => c.laundryGroup));
      if (groups.size === 1) {
        const [g] = groups;
        if (g !== 'other') messages.push({ level: 'info', text: `Every main color in this pattern would sort as ${groupLabel(g)}.` });
      }
    }
    if (!messages.length) return null;
    return h(
      'ul',
      { class: 'messages' },
      ...messages.map((m) =>
        h('li', { class: `message message--${m.level}` }, icon(m.level === 'warn' ? 'alert' : m.level === 'ok' ? 'check' : 'info'), h('span', { text: m.text })),
      ),
    );
  }

  function componentsBlock(r, breakdown) {
    if (breakdown.items.length < 2 && !breakdown.otherPercent) return null;
    return h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'components-title' },
      h('h3', { id: 'components-title', class: 'section-title', text: r.patternStatus === 'single' ? 'Colors in the target' : 'Colors found' }),
      h(
        'ul',
        { class: 'list' },
        ...breakdown.items.map(({ cluster, percent }) =>
          h(
            'li',
            { class: 'list-item' },
            swatch(cluster.rgb),
            h('span', { class: 'grow' }, h('strong', { text: colorName(cluster.matches[0].colorId) }), h('br'), h('small', { class: 'hint', text: groupLabel(cluster.laundryGroup) })),
            h('span', { class: 'meta', text: `${percent}%` }),
          ),
        ),
        breakdown.otherPercent
          ? h('li', { class: 'list-item' }, h('span', { class: 'swatch', 'aria-hidden': 'true', style: { background: 'repeating-linear-gradient(45deg,#888 0 6px,#bbb 6px 12px)' } }), h('span', { class: 'grow', text: 'Other colors' }), h('span', { class: 'meta', text: `${breakdown.otherPercent}%` }))
          : null,
      ),
      h('p', { class: 'hint', text: 'Percentages describe the sampled target area, not the whole garment.' }),
    );
  }

  function matchesBlock(r) {
    const primary = r.clusters[0];
    const title = r.patternStatus === 'single' ? 'Closest matches' : `Closest matches for ${colorName(primary.matches[0].colorId)}`;
    return h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'matches-title' },
      h('h3', { id: 'matches-title', class: 'section-title', text: title }),
      h(
        'ol',
        { class: 'list' },
        ...primary.matches.map((m) => {
          const color = app.palette.byId.get(m.colorId);
          return h(
            'li',
            { class: 'list-item' },
            swatch(color.rgb),
            h('span', { class: 'grow', text: color.name }),
            h('span', { class: 'meta', text: `ΔE ${formatDistance(m.distance)}`, title: 'CIEDE2000 color difference — smaller is closer' }),
          );
        }),
      ),
      h(
        'dl',
        { class: 'values' },
        h('dt', { text: 'HEX' }),
        h('dd', { text: rgbToHex(primary.rgb) }),
        h('dt', { text: 'RGB' }),
        h('dd', { text: formatRgb(primary.rgb) }),
        h('dt', { text: 'Lab' }),
        h('dd', { text: formatLab(primary.lab) }),
      ),
    );
  }

  function calibrationBlock() {
    const cal = app.state.result?.calibration ?? null;
    const discarded = app.state.result?.qualityFlags.includes('calibration-discarded');
    if (!cal && !discarded) return null;
    const showing = app.state.showUncalibrated;
    const toggle = (value) =>
      h('button', {
        type: 'button',
        'aria-pressed': String(showing === value),
        text: value ? 'Without calibration' : 'Calibrated',
        onClick: () => app.showCalibrationComparison(value),
      });
    return h(
      'section',
      { class: 'card stack', 'aria-label': 'Calibration' },
      cal ? h('div', { class: 'segmented', role: 'group', 'aria-label': 'Compare calibration' }, toggle(false), toggle(true)) : null,
      h('button', { class: 'btn btn--secondary btn--small', type: 'button', onClick: () => app.resetCalibration() }, icon('close'), 'Reset calibration'),
    );
  }

  function correctionNote(corrected) {
    const what = corrected.colorId
      ? colorName(corrected.colorId)
      : corrected.patternStatus === 'multicolor'
        ? 'Pattern / multicolor'
        : 'Unknown color';
    return h('p', { class: 'correction-note', role: 'status', text: `Your correction: ${what} · ${groupLabel(corrected.laundryGroup)} (saved on this device)` });
  }

  function actionsBlock(r) {
    const buttons = [
      h('button', { class: 'btn btn--secondary btn--small', type: 'button', onClick: () => app.go('reference') }, icon('plus'), 'Add Reference'),
    ];
    if (app.ai.shouldOffer(r)) {
      buttons.push(h('button', { class: 'btn btn--secondary btn--small', type: 'button', onClick: () => app.ai.review() }, icon('sparkle'), 'Review with AI'));
    }
    return h('div', { class: 'result-actions' }, ...buttons);
  }

  function render({ focus = false } = {}) {
    const view = app.state.showUncalibrated && app.state.uncalibrated ? app.state.uncalibrated : { result: app.state.result, debug: app.state.debug };
    const r = view.result;
    if (!r) return;
    const breakdown = componentBreakdown(r.clusters, app.config.multicolor.accentMinFraction);
    clear(body).append(
      ...[
        hero(r, breakdown),
        h('div', { class: 'result-summary' }, groupRow(r), confidenceBlock(r)),
        app.state.correction ? correctionNote(app.state.correction.corrected) : null,
        messagesBlock(r),
        componentsBlock(r, breakdown),
        matchesBlock(r),
        calibrationBlock(),
        actionsBlock(r),
        h('p', { class: 'disclaimer', text: DISCLAIMER }),
        app.debugEnabled() && view.debug ? renderDebugPanel(app, r, view.debug) : null,
      ].filter(Boolean),
    );
    if (focus) {
      $('#result-name').focus({ preventScroll: false });
      const level = r.confidence === null ? '' : ` Match confidence ${r.confidence} percent, ${confidenceLabel(r.confidence, app.config.confidence.labels)}.`;
      announce(`${displayName(r)}. Laundry group: ${groupLabel(r.laundryGroup)}.${level}`);
    }
  }

  return {
    enter() {
      window.scrollTo(0, 0);
      render({ focus: true });
    },
    render,
    cancel() {
      app.go('home');
    },
  };
}
