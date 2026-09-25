/**
 * Settings: laundry grouping (preset, family mappings, per-color overrides),
 * saved reference profiles, saved corrections, export/import/delete of local
 * data, offline readiness and the developer view (blueprint §7, §11, §13).
 */
import { deltaE2000Lab } from '../color/delta-e-2000.js';
import { labToRgb } from '../color/srgb-lab.js';
import { buildExport, ImportError, planImport } from '../data-transfer.js';
import { FAMILIES, GROUPS, groupForColor, groupLabel } from '../grouping.js';
import { $, clear, confirmDialog, h, icon, swatch, toast } from './dom.js';
import { errorMessage } from './messages.js';

const FAMILY_LABELS = {
  neutral: 'Neutrals (grays)',
  blue: 'Blues',
  green: 'Greens',
  yellow: 'Yellows',
  orange: 'Oranges',
  brown: 'Browns',
  red: 'Reds and pinks',
  purple: 'Purples',
};
const SORTABLE_GROUPS = GROUPS.filter((g) => g.id !== 'multicolor');

export function createSettingsScreen(app) {
  const body = $('#settings-body');
  $('#btn-settings-back').addEventListener('click', () => app.go('home'));

  const section = (title, ...children) =>
    h('section', { class: 'card settings-section', 'aria-label': title }, h('h3', { text: title }), ...children.filter(Boolean));

  function groupSelect(value, onChange, { automaticLabel } = {}) {
    const select = h(
      'select',
      {},
      automaticLabel ? h('option', { value: '', text: automaticLabel }) : null,
      ...SORTABLE_GROUPS.map((g) => h('option', { value: g.id, text: g.label })),
    );
    select.value = value ?? '';
    select.addEventListener('change', () => onChange(select.value || null));
    return select;
  }

  async function saveGrouping(next, message) {
    try {
      await app.updateGroupingSettings(next);
      toast(message ?? 'Saved. Applies to new scans.');
    } catch (err) {
      toast(errorMessage(err?.code ?? 'storage-failed'));
    }
  }

  function groupingSection() {
    const preset = app.config.grouping;
    // Handlers read app.settings.grouping at change time (never a render-time
    // snapshot), and update labels in place so keyboard focus is kept.
    const current = () => app.settings.grouping;
    const automaticOptions = new Map();
    const summary = h('summary', { class: 'field-label' });
    const refreshLabels = () => {
      const rules = app.rules({ withoutColorOverrides: true });
      for (const [colorId, option] of automaticOptions) {
        const color = app.palette.byId.get(colorId);
        option.textContent = `Automatic (${groupLabel(groupForColor(color.lab, color.family, color.id, rules).groupId)})`;
      }
      const count = Object.keys(current().colorOverrides ?? {}).length;
      summary.textContent = `Per-color overrides${count ? ` (${count})` : ''}`;
    };

    const families = h(
      'div',
      { class: 'override-grid' },
      ...FAMILIES.map((family) =>
        h(
          'label',
          { class: 'override-row' },
          h('span', { 'aria-hidden': 'true' }),
          h('span', { text: FAMILY_LABELS[family] }),
          groupSelect(current().familyGroups?.[family] ?? preset.familyGroups[family], async (value) => {
            await saveGrouping({ ...current(), familyGroups: { ...current().familyGroups, [family]: value } });
            refreshLabels();
          }),
        ),
      ),
    );
    const overrides = h(
      'div',
      { class: 'override-grid' },
      ...app.palette.colors.map((color) => {
        const select = groupSelect(
          current().colorOverrides?.[color.id] ?? null,
          async (value) => {
            const colorOverrides = { ...current().colorOverrides };
            if (value) colorOverrides[color.id] = value;
            else delete colorOverrides[color.id];
            await saveGrouping({ ...current(), colorOverrides });
            refreshLabels();
          },
          { automaticLabel: 'Automatic' },
        );
        automaticOptions.set(color.id, select.options[0]);
        return h('label', { class: 'override-row' }, swatch(color.rgb, { small: true }), h('span', { text: color.name }), select);
      }),
    );
    refreshLabels();
    return section(
      'Laundry groups',
      h('p', { class: 'hint', text: `${preset.presetName} (${preset.presetVersion}). Whites need very light, nearly colorless fabric; dark colors sort as Darks; very light colors sort as Lights; reds and pinks always stay together unless dark. Changes apply to new scans only.` }),
      h('h4', { class: 'field-label', text: 'Where each color family goes' }),
      families,
      h('details', {}, summary, overrides),
      h('button', {
        class: 'btn btn--secondary btn--small',
        type: 'button',
        onClick: async () => {
          await saveGrouping({ familyGroups: {}, colorOverrides: {} }, 'Restored standard color sorting.');
          render();
        },
      }, 'Restore standard sorting'),
    );
  }

  function canEnable(profile) {
    const seed = app.palette.byId.get(profile.colorId);
    const active = app.state.profiles.filter((p) => p.colorId === profile.colorId && p.status === 'approved').length;
    return (
      profile.captureCondition !== 'unknown' &&
      seed &&
      deltaE2000Lab(profile.lab, seed.lab) <= app.config.profiles.maxSeedDistance &&
      active < app.config.profiles.maxActivePerColor
    );
  }

  function profilesSection() {
    const profiles = [...app.state.profiles].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const statusText = { approved: 'Enabled', pending: 'Pending', disabled: 'Disabled' };
    const conditionText = { neutral: 'neutral light', calibrated: 'calibrated', unknown: 'unknown light' };
    const rows = profiles.map((p) => {
      const toggle =
        p.status === 'approved'
          ? h('button', { class: 'btn btn--ghost btn--small', type: 'button', onClick: () => updateProfile({ ...p, status: 'disabled' }) }, 'Disable')
          : canEnable(p)
            ? h('button', { class: 'btn btn--ghost btn--small', type: 'button', onClick: () => updateProfile({ ...p, status: 'approved' }) }, 'Enable')
            : null;
      return h(
        'li',
        { class: 'list-item' },
        swatch(labToRgb(p.lab)),
        h(
          'span',
          { class: 'grow' },
          h('strong', { text: app.palette.byId.get(p.colorId)?.name ?? p.colorId }),
          ' ',
          h('span', { class: `badge ${p.status === 'approved' ? 'badge--ok' : 'badge--warn'}`, text: statusText[p.status] }),
          h('br'),
          h('small', { class: 'hint', text: `${conditionText[p.captureCondition]} · ${new Date(p.createdAt).toLocaleDateString()}` }),
        ),
        toggle,
        h('button', { class: 'btn btn--ghost btn--small', type: 'button', 'aria-label': 'Delete reference', onClick: () => deleteProfile(p) }, icon('trash')),
      );
    });
    return section(
      'Reference profiles',
      h('p', { class: 'hint', text: 'Numeric color references you saved from scans. Enabled ones help matching on this device. No photos are stored.' }),
      rows.length ? h('ul', { class: 'list' }, ...rows) : h('p', { class: 'hint', text: 'None yet. Use “Add Reference” on a result.' }),
    );
  }

  async function updateProfile(profile) {
    try {
      await app.storage.putProfile(profile);
      await app.reloadProfiles();
      render();
    } catch (err) {
      toast(errorMessage(err?.code ?? 'storage-failed'));
    }
  }

  async function deleteProfile(profile) {
    const ok = await confirmDialog({ title: 'Delete reference?', body: 'This removes the saved reference from this device.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await app.storage.deleteProfile(profile.id);
      await app.reloadProfiles();
      render();
    } catch (err) {
      toast(errorMessage(err?.code ?? 'storage-failed'));
    }
  }

  function correctionsSection(corrections) {
    const name = (id) => (id ? app.palette.byId.get(id)?.name ?? id : 'Unknown');
    const predicted = (r) => (r.patternStatus === 'multicolor' ? 'Multicolor' : r.patternStatus === 'ambiguous' ? 'Pattern or shadow' : name(r.detectedColorId));
    const rows = corrections.slice(0, 50).map((c) =>
      h(
        'li',
        { class: 'list-item' },
        h(
          'span',
          { class: 'grow' },
          h('strong', { text: `${predicted(c.original)} → ${c.corrected.patternStatus === 'multicolor' ? 'Pattern' : name(c.corrected.colorId)}` }),
          h('br'),
          h('small', { class: 'hint', text: `${groupLabel(c.corrected.laundryGroup)} · ${new Date(c.createdAt).toLocaleString()}${c.note ? ` · “${c.note}”` : ''}` }),
        ),
        h('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          'aria-label': 'Delete correction',
          onClick: async () => {
            try {
              await app.storage.deleteCorrection(c.id);
              render();
            } catch (err) {
              toast(errorMessage(err?.code ?? 'storage-failed'));
            }
          },
        }, icon('trash')),
      ),
    );
    return section(
      `Saved corrections (${corrections.length})`,
      h('p', { class: 'hint', text: 'Kept on this device as evidence for improving the detector later. They never change detection automatically.' }),
      rows.length ? h('ul', { class: 'list' }, ...rows) : h('p', { class: 'hint', text: 'None yet.' }),
    );
  }

  async function exportData() {
    const [corrections, profiles] = await Promise.all([app.storage.listCorrections(), app.storage.listProfiles()]);
    const payload = buildExport({ corrections, profiles, settings: app.settings, appVersion: app.appConfig.appVersion });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `laundry-color-scanner-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${corrections.length} corrections and ${profiles.length} references (no photos).`);
  }

  async function importData(file) {
    try {
      const [corrections, profiles] = await Promise.all([app.storage.listCorrections(), app.storage.listProfiles()]);
      const text = await file.text();
      const plan = planImport(text, {
        byteLength: file.size,
        existingCorrectionIds: new Set(corrections.map((c) => c.id)),
        existingProfileIds: new Set(profiles.map((p) => p.id)),
      });
      const c = plan.counts;
      const ok = await confirmDialog({
        title: 'Import data?',
        body: [
          `Add ${c.corrections.add} corrections and ${c.profiles.add} reference profiles${plan.settings ? ', and replace your grouping settings' : ''}.`,
          `Skipped: ${c.corrections.duplicate + c.profiles.duplicate} already present, ${c.corrections.invalid + c.profiles.invalid} invalid.`,
        ],
        confirmText: 'Import',
      });
      if (!ok) return;
      await app.storage.applyImport(plan);
      await app.reloadSettings();
      await app.reloadProfiles();
      toast('Import complete.');
      render();
    } catch (err) {
      toast(err instanceof ImportError ? `Import failed: ${err.message}` : errorMessage(err?.code ?? 'storage-failed'));
    }
  }

  async function deleteAll() {
    const ok = await confirmDialog({
      title: 'Delete all local data?',
      body: 'This permanently removes every saved correction, reference profile and setting from this device. Scanning keeps working.',
      confirmText: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    try {
      await app.deleteAllLocalData();
      toast('All local data deleted.');
      render();
    } catch (err) {
      toast(errorMessage(err?.code ?? 'storage-failed'));
    }
  }

  function dataSection() {
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) importData(file);
    });
    return section(
      'Your data',
      h('p', { class: 'hint', text: 'Everything stays in this browser. Export creates a JSON file without any photos.' }),
      h(
        'div',
        { class: 'settings-row' },
        h('button', { class: 'btn btn--secondary btn--small', type: 'button', onClick: exportData, disabled: !app.storage.available }, icon('download'), 'Export'),
        h('button', { class: 'btn btn--secondary btn--small', type: 'button', onClick: () => fileInput.click(), disabled: !app.storage.available }, icon('upload'), 'Import'),
        h('button', { class: 'btn btn--danger btn--small', type: 'button', onClick: deleteAll }, icon('trash'), 'Delete all local data'),
      ),
      fileInput,
    );
  }

  const offlineBody = h('div', { class: 'stack' });

  /** Refresh only the offline/install status (never the whole page, which would drop focus). */
  function renderOffline() {
    const status = app.pwa.describe();
    clear(offlineBody).append(
      ...[
        h('p', { text: status.text }),
        status.canInstall ? h('button', { class: 'btn btn--secondary btn--small', type: 'button', onClick: () => app.pwa.promptInstall() }, icon('download'), 'Install app') : null,
        status.installHint ? h('p', { class: 'hint', text: status.installHint }) : null,
      ].filter(Boolean),
    );
  }

  function offlineSection() {
    renderOffline();
    return section('Offline use', offlineBody);
  }

  function developerSection() {
    if (!app.appConfig.debugAvailable) return null;
    const checkbox = h('input', { type: 'checkbox' });
    checkbox.checked = Boolean(app.settings.debug);
    checkbox.addEventListener('change', async () => {
      try {
        await app.setDebug(checkbox.checked);
      } catch (err) {
        toast(errorMessage(err?.code ?? 'storage-failed'));
      }
    });
    return section(
      'Developer',
      h('label', { class: 'choice' }, checkbox, 'Show developer details on results'),
      h('p', { class: 'hint', text: `Engine: ${app.detector.mode} · detector ${app.detectorVersion} · config ${app.config.configVersion} · palette ${app.palette.paletteVersion} · grouping ${app.groupingVersion()}` }),
    );
  }

  async function render() {
    const corrections = await app.storage.listCorrections().catch(() => []);
    clear(body).append(
      ...[
        app.storage.available ? null : h('p', { class: 'inline-error', role: 'status', text: errorMessage('storage-unavailable') }),
        groupingSection(),
        profilesSection(),
        correctionsSection(corrections),
        dataSection(),
        offlineSection(),
        developerSection(),
        section(
          'Privacy',
          h('p', { class: 'hint', text: 'Scans are analyzed on this device. Photos are never uploaded or saved; only corrections, reference numbers and settings you choose to save are kept locally.' }),
        ),
      ].filter(Boolean),
    );
  }

  return {
    enter() {
      render();
      $('#settings-title').focus({ preventScroll: true });
    },
    render,
    renderOffline,
    cancel() {
      app.go('home');
    },
  };
}
