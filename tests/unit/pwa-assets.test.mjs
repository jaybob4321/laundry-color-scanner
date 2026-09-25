import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeBuildVersion, listPrecacheFiles } from '../../scripts/lib/precache.mjs';
import { decodePNG, encodePNG } from '../../scripts/lib/png.mjs';
import { assessFrame } from '../../src/live-feedback.js';
import { ROOT, loadJson } from '../helpers.mjs';

test('manifest is installable and path-relative (subdirectory hosting)', () => {
  const m = loadJson('manifest.webmanifest');
  for (const key of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) assert.ok(m[key], key);
  assert.equal(m.display, 'standalone');
  assert.ok(!m.start_url.startsWith('/') && !m.scope.startsWith('/'), 'relative URLs');
  const sizes = (purpose) => m.icons.filter((i) => i.purpose === purpose).map((i) => i.sizes);
  assert.ok(sizes('any').includes('192x192') && sizes('any').includes('512x512'));
  assert.ok(sizes('maskable').includes('512x512'));
  for (const icon of m.icons) {
    const png = decodePNG(readFileSync(join(ROOT, icon.src)));
    assert.equal(`${png.width}x${png.height}`, icon.sizes, icon.src);
  }
  const apple = decodePNG(readFileSync(join(ROOT, 'assets/icons/apple-touch-icon.png')));
  assert.equal(apple.width, 180);
  assert.ok([...apple.rgba].filter((_, i) => i % 4 === 3).every((a) => a === 255), 'apple icon is opaque');
});

test('service worker precache is current and complete', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const files = listPrecacheFiles(ROOT);
  const version = computeBuildVersion(ROOT, files);
  assert.ok(sw.includes(`version: '${version}'`), 'run `npm run build` to refresh the precache version');
  for (const f of files) {
    assert.ok(sw.includes(`'${f}'`), `${f} missing from precache`);
    assert.ok(existsSync(join(ROOT, f)));
  }
  for (const required of ['index.html', 'manifest.webmanifest', 'src/worker/detector.worker.js', 'data/colors.json', 'data/detector-config.json', 'styles/app.css']) {
    assert.ok(files.includes(required), required);
  }
  assert.ok(!files.some((f) => /^(tests|scripts|docs|spec|node_modules)\//.test(f)), 'dev-only files are never precached');
});

test('index.html references only relative, same-origin resources', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
  for (const ref of refs) assert.ok(!/^(https?:)?\/\//.test(ref) && !ref.startsWith('/'), ref);
  assert.ok(!/fonts\.googleapis|analytics|gtag/.test(html));
});

test('PNG codec round-trips RGBA', () => {
  const rgba = new Uint8ClampedArray(7 * 5 * 4).map((_, i) => (i * 37) % 256);
  const decoded = decodePNG(encodePNG(7, 5, rgba, { extraChunks: [{ type: 'sRGB', data: Buffer.from([0]) }] }));
  assert.deepEqual([decoded.width, decoded.height], [7, 5]);
  assert.deepEqual(Buffer.from(decoded.rgba), Buffer.from(rgba));
  assert.deepEqual(decoded.colorChunks, ['sRGB']);
});

test('live framing feedback only says Ready or suggests reframing', () => {
  const frame = (rgb) => new Uint8ClampedArray(32 * 32 * 4).map((_, i) => (i % 4 === 3 ? 255 : rgb[i % 4]));
  assert.equal(assessFrame(frame([40, 60, 90]), 32, 32).status, 'ready');
  assert.equal(assessFrame(frame([255, 255, 255]), 32, 32).status, 'glare');
  assert.equal(assessFrame(frame([2, 2, 2]), 32, 32).status, 'too-dark');
});
