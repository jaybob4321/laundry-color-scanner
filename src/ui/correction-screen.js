/**
 * Correct Result: choose the actual color (or Unknown / Pattern), a laundry
 * group and an optional note. Saved locally only after Save, as structured
 * evidence for future detector work — it never changes detection or the
 * original machine result (blueprint §11, §13).
 */
import { GROUPS, groupForColor } from '../grouping.js';
import { createId } from '../util/ids.js';
import { createColorPicker } from './color-picker.js';
import { $, clear, h, toast } from './dom.js';
import { errorMessage } from './messages.js';

const UNKNOWN = '__unknown';
const PATTERN = '__pattern';

export function createCorrectionScreen(app) {
  const form = $('#correction-form');
  const groupSelect = $('#correction-group');
  const note = $('#correction-note');
  const pickerHost = $('#correction-picker');
  const saveBtn = $('#btn-correction-save');
  let picker = null;
  let error = null;

  groupSelect.append(...GROUPS.map((g) => h('option', { value: g.id, text: g.label })));

  function suggestGroup(choice) {
    if (choice === PATTERN) return 'multicolor';
    if (choice === UNKNOWN) return 'other';
    const color = app.palette.byId.get(choice);
    return groupForColor(color.lab, color.family, color.id, app.rules()).groupId;
  }

  function showError(text) {
    error?.remove();
    error = text ? h('p', { class: 'inline-error', role: 'alert', text }) : null;
    if (error) form.prepend(error);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const choice = picker.value;
    if (!choice) {
      showError('Choose the actual color, or Unknown.');
      picker.focus();
      return;
    }
    const correction = {
      schemaVersion: 1,
      id: createId(),
      createdAt: new Date().toISOString(),
      original: app.state.result,
      corrected: {
        colorId: choice === UNKNOWN || choice === PATTERN ? null : choice,
        laundryGroup: groupSelect.value,
        patternStatus: choice === PATTERN ? 'multicolor' : choice === UNKNOWN ? 'unknown' : 'single',
      },
      note: note.value.trim().slice(0, 500),
      usedForLearning: false,
    };
    saveBtn.disabled = true;
    try {
      await app.storage.addCorrection(correction);
      app.state.correction = correction;
      toast('Correction saved on this device. It’s kept for future detector improvements and doesn’t change how scans are detected.', { timeout: 6500 });
      app.go('results');
    } catch (err) {
      showError(errorMessage(err?.code === 'storage-unavailable' ? 'storage-unavailable' : 'storage-failed'));
    } finally {
      saveBtn.disabled = false;
    }
  });

  return {
    enter() {
      showError(null);
      note.value = '';
      groupSelect.value = app.state.result.laundryGroup;
      picker = createColorPicker({
        palette: app.palette,
        extras: [
          { value: UNKNOWN, label: 'Unknown / none of these', detail: 'The color isn’t in the list' },
          { value: PATTERN, label: 'Pattern / multicolor', detail: 'The garment has several colors' },
        ],
        onChange: (choice) => {
          groupSelect.value = suggestGroup(choice);
          showError(null);
        },
      });
      clear(pickerHost).append(picker.element);
      if (!app.storage.available) showError(errorMessage('storage-unavailable'));
      picker.focus();
    },
    cancel() {
      app.go('results');
    },
  };
}
