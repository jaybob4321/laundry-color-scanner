/**
 * Add Reference: save this scan's measured color as a numeric profile for
 * a known color, after the same quality gates as curated profiles
 * (blueprint §14). No picture is kept. Unknown lighting saves a pending
 * profile that is not used for matching.
 */
import { deltaE2000Lab } from '../color/delta-e-2000.js';
import { combineProfiles, evaluateProfileCandidate } from '../references.js';
import { createId } from '../util/ids.js';
import { createColorPicker } from './color-picker.js';
import { $, clear, confirmDialog, h, icon, swatch, toast } from './dom.js';
import { formatLab } from './format.js';
import { errorMessage } from './messages.js';

const GATE_TEXT = {
  'known-color': () => 'A known color is selected',
  'single-color': (g) => `One color covers at least 85% of the target (now ${Math.round(g.value * 100)}%)`,
  compact: (g) => `The color is even across the target (spread ${g.value.toFixed(1)} of max 6)`,
  clipping: (g) => `Almost no pure black or white pixels (${Math.round(g.value * 100)}%, max 5%)`,
  lighting: () => 'Scanned in neutral light or with a white reference',
  'seed-distance': (g) => `Close to the selected color's anchor (ΔE ${g.value.toFixed(1)} of max 12; farther needs palette review)`,
  capacity: (g) => `Fewer than 20 active references for this color (now ${g.value})`,
};

export function createReferenceScreen(app) {
  const form = $('#reference-form');
  const pickerHost = $('#reference-picker');
  const preview = $('#reference-preview');
  const saveBtn = $('#btn-reference-save');
  let picker = null;
  let evaluation = null;

  const condition = () => form.querySelector('input[name="condition"]:checked')?.value ?? 'unknown';

  function evaluate() {
    const colorId = picker.value;
    if (!colorId) {
      evaluation = null;
      clear(preview).append(h('p', { class: 'hint', text: 'Choose the color this garment really is.' }));
      saveBtn.disabled = true;
      return;
    }
    evaluation = evaluateProfileCandidate({
      result: app.state.result,
      colorId,
      captureCondition: condition(),
      paletteIndex: app.palette,
      existingProfiles: app.state.profiles,
      config: app.config,
      distance: deltaE2000Lab,
      makeId: createId,
    });
    const primary = app.state.result.clusters[0];
    const outcome = evaluation.blocked
      ? 'This scan can’t be saved as a reference.'
      : evaluation.status === 'approved'
        ? 'Will be enabled for matching.'
        : 'Will be saved as pending — kept, but not used for matching until it qualifies.';
    clear(preview).append(
      h(
        'div',
        { class: 'list-item' },
        swatch(primary.rgb),
        h('span', { class: 'grow' }, h('strong', { text: 'Measured color' }), h('br'), h('small', { class: 'hint', text: formatLab(primary.lab) })),
      ),
      h(
        'ul',
        { class: 'gates' },
        ...evaluation.gates.map((g) =>
          h('li', { class: g.pass ? '' : 'gate-fail' }, icon(g.pass ? 'check' : 'alert'), h('span', { text: `${g.pass ? '' : 'Not met: '}${GATE_TEXT[g.id](g)}` })),
        ),
      ),
      h('p', { class: 'section-title', text: outcome }),
      evaluation.duplicate && !evaluation.blocked
        ? h('p', { class: 'hint', text: 'A very similar reference for this color already exists; saving will offer to combine them.' })
        : null,
    );
    saveBtn.disabled = evaluation.blocked;
  }

  form.addEventListener('change', (event) => {
    if (event.target.name === 'condition') evaluate();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!evaluation || evaluation.blocked) return;
    let record = evaluation.profile;
    if (evaluation.duplicate && evaluation.status === 'approved') {
      const combine = await confirmDialog({
        title: 'Combine references?',
        body: 'This is almost identical to a reference you already saved for this color. Combine them into one?',
        confirmText: 'Combine',
        cancelText: 'Keep both',
      });
      if (combine) record = combineProfiles(evaluation.duplicate, evaluation.profile);
    }
    saveBtn.disabled = true;
    try {
      await app.storage.putProfile(record);
      await app.reloadProfiles();
      toast(record.status === 'approved' ? 'Reference saved on this device (numbers only, no photo).' : 'Reference saved as pending. It won’t be used for matching yet.');
      app.go('results');
    } catch (err) {
      clear(preview).append(h('p', { class: 'inline-error', role: 'alert', text: errorMessage(err?.code === 'storage-unavailable' ? 'storage-unavailable' : 'storage-failed') }));
    } finally {
      saveBtn.disabled = false;
    }
  });

  return {
    enter() {
      const result = app.state.result;
      form.querySelector(`input[name="condition"][value="${result.calibration ? 'calibrated' : 'unknown'}"]`).checked = true;
      form.querySelector('input[name="condition"][value="calibrated"]').disabled = !result.calibration;
      picker = createColorPicker({ palette: app.palette, selected: result.detectedColorId, label: 'Known color', onChange: evaluate });
      clear(pickerHost).append(picker.element);
      evaluate();
      picker.focus();
    },
    cancel() {
      app.go('results');
    },
  };
}
