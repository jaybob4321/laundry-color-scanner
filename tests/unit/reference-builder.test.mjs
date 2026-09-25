import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePNG } from '../../scripts/lib/png.mjs';
import { buildReferenceProfiles } from '../../scripts/lib/reference-builder.mjs';
import { applyCast, paint, stripes } from '../fixtures/synthetic.mjs';
import { loadConfig, loadPalette } from '../helpers.mjs';

const config = loadConfig();
const palette = loadPalette();

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'lcs-ref-'));
  const png = (name, img, extraChunks) => writeFileSync(join(dir, name), encodePNG(img.width, img.height, img.rgba, { extraChunks }));
  // Navy garment with a gray card in the corner, under a warm cast.
  const scene = paint(400, 300, (x, y) => (x < 80 && y > 220 ? [180, 180, 180] : x > 100 && y < 280 ? [32, 46, 77] : [120, 110, 90]), { noise: 2 });
  png('navy-warm.png', applyCast(scene, [1.2, 1, 0.85]));
  png('navy.png', paint(300, 300, () => [32, 46, 77], { noise: 2 }));
  png('stripes.png', stripes([{ color: '#101114', size: 20 }, { color: '#FFFFFF', size: 20 }], { width: 300, height: 300 }));
  png('icc.png', paint(100, 100, () => [32, 46, 77]), [{ type: 'iCCP', data: Buffer.from('P3\0\0x') }]);
  writeFileSync(join(dir, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return dir;
}

const base = { license: 'CC0-1.0', provenance: 'synthetic test fixture', garmentRoi: { x: 0.4, y: 0.1, width: 0.5, height: 0.6 } };

test('curated photos become pending numeric profiles through the runtime pipeline', () => {
  const dir = fixtureDir();
  const manifest = {
    schemaVersion: 1,
    records: [
      { ...base, id: 'navy-calibrated', image: 'navy-warm.png', colorId: 'navy', lighting: 'calibrated', neutralRoi: { x: 0.02, y: 0.78, width: 0.15, height: 0.18 } },
      { ...base, id: 'navy-plain', image: 'navy.png', colorId: 'navy', lighting: 'neutral', garmentRoi: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 } },
      { ...base, id: 'bw-stripes', image: 'stripes.png', colorId: 'black', lighting: 'neutral', garmentRoi: { x: 0, y: 0, width: 1, height: 1 } },
      { ...base, id: 'icc', image: 'icc.png', colorId: 'navy', lighting: 'neutral', garmentRoi: { x: 0, y: 0, width: 1, height: 1 } },
      { ...base, id: 'jpeg', image: 'photo.jpg', colorId: 'navy', lighting: 'neutral' },
      { ...base, id: 'bad-color', image: 'navy.png', colorId: 'ultramarine', lighting: 'neutral' },
      { ...base, id: 'no-license', image: 'navy.png', colorId: 'navy', lighting: 'neutral', license: '' },
    ],
  };
  const { profileSet, report } = buildReferenceProfiles({ manifest, manifestDir: dir, config, palette, now: Date.parse('2026-09-25T12:00:00Z') });
  assert.deepEqual(report.accepted.map((a) => a.id), ['navy-calibrated', 'navy-plain']);
  assert.deepEqual(report.patterns.map((p) => p.id), ['bw-stripes']);
  assert.equal(report.patterns[0].clusters.length >= 2, true, 'pattern distribution kept for testing, not collapsed');
  const reasons = Object.fromEntries(report.rejected.map((r) => [r.id, r.reason]));
  assert.match(reasons.icc, /ICC profile/);
  assert.match(reasons.jpeg, /sRGB PNG/);
  assert.match(reasons['bad-color'], /unknown colorId/);
  assert.match(reasons['no-license'], /license and provenance/);

  assert.equal(profileSet.profiles.length, 2);
  for (const p of profileSet.profiles) {
    assert.equal(p.status, 'pending', 'curator approval required');
    assert.equal(p.source, 'curated');
    assert.equal(p.colorSpace, 'CIELAB-D65-2deg');
    assert.ok(!('rgba' in p) && !('image' in p));
  }
  const calibrated = report.accepted.find((a) => a.id === 'navy-calibrated');
  assert.ok(calibrated.seedDistance < 6, `calibration recovered navy (ΔE ${calibrated.seedDistance})`);
});

test('approval survives a rebuild only when the measurement is unchanged', () => {
  const dir = fixtureDir();
  const manifest = { schemaVersion: 1, records: [{ ...base, id: 'navy-plain', image: 'navy.png', colorId: 'navy', lighting: 'neutral', garmentRoi: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 } }] };
  const first = buildReferenceProfiles({ manifest, manifestDir: dir, config, palette });
  const approved = { ...first.profileSet, profiles: first.profileSet.profiles.map((p) => ({ ...p, status: 'approved' })) };
  const again = buildReferenceProfiles({ manifest, manifestDir: dir, config, palette, existing: approved });
  assert.equal(again.profileSet.profiles[0].status, 'approved');
  const moved = { ...approved, profiles: approved.profiles.map((p) => ({ ...p, lab: [p.lab[0] + 5, p.lab[1], p.lab[2]] })) };
  assert.equal(buildReferenceProfiles({ manifest, manifestDir: dir, config, palette, existing: moved }).profileSet.profiles[0].status, 'pending');
});
