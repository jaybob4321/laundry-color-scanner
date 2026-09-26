/**
 * Browser flows: upload → crop → results, multicolor, calibration,
 * corrections and local data, errors, keyboard and Back, EXIF, AI consent.
 */
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { applyCast, blocks, paint, solid, stripes } from '../fixtures/synthetic.mjs';
import { browserTest, closeSharedBrowser, openPage, pngFile, readResult, startApp, uploadAndAnalyze } from './harness.mjs';

let app;
before(async () => {
  app = await startApp();
});
after(async () => {
  await closeSharedBrowser();
  await app?.close();
});

const navyPhoto = () =>
  pngFile('navy.png', paint(900, 700, (x, y) => (x > 120 && x < 780 && y > 60 && y < 640 ? [36, 49, 82] : [216, 210, 196]), { noise: 3 }));

browserTest('upload: navy garment → Navy / Darks with matches, HEX and RGB', async (browser) => {
  const { page, errors, context } = await openPage(browser, app.baseUrl);
  const r = await uploadAndAnalyze(page, navyPhoto());
  assert.equal(r.name, 'Navy');
  assert.equal(r.group, 'Darks');
  assert.match(r.confidence, /^Match confidence: \d+% · (High|Moderate|Low)$/);
  for (const text of ['Closest matches', 'HEX', 'RGB', 'Dark Blue', 'Follow the care label']) assert.ok(r.text.includes(text), text);
  assert.equal(r.result.source, 'upload');
  assert.deepEqual(errors, []);
  await context.close();
});

browserTest('upload: 50/50 black-white stripes → Multicolor with separate swatches, never gray', async (browser) => {
  const { page, errors, context } = await openPage(browser, app.baseUrl);
  const r = await uploadAndAnalyze(page, pngFile('stripes.png', stripes([{ color: '#15161A', size: 30 }, { color: '#F2F2F0', size: 30 }], { width: 900, height: 700, noise: 2 })));
  assert.equal(r.name, 'Multicolor');
  assert.equal(r.group, 'Multicolor');
  assert.ok(!/Gray/.test(r.name + r.group));
  const segments = await page.$$eval('.hero-swatch > span', (els) => els.map((e) => e.style.background));
  assert.ok(segments.length >= 2, 'one swatch per color, never an average');
  assert.match(r.text, /Black\s+Darks\s+(49|50|51)%/);
  assert.deepEqual(errors, []);
  await context.close();
});

browserTest('upload: 50/50 red/blue blocks → Multicolor', async (browser) => {
  const { page, context } = await openPage(browser, app.baseUrl);
  const r = await uploadAndAnalyze(page, pngFile('rb.png', blocks('#C8323E', '#3657AD', { width: 900, height: 700, noise: 2 })));
  assert.equal(r.name, 'Multicolor');
  assert.ok(r.text.includes('Red') && r.text.includes('Royal Blue'));
  await context.close();
});

browserTest('same-frame white reference corrects a warm cast; comparison and reset work', async (browser) => {
  const warm = [1.3, 1.0, 0.72];
  const scene = applyCast(
    paint(1200, 900, (x, y) => (x < 264 && y > 648 ? [215, 215, 215] : x > 300 && x < 1020 && y > 72 && y < 828 ? [197, 199, 203] : [120, 100, 80])),
    warm,
  );
  const { page, errors, context } = await openPage(browser, app.baseUrl);
  const uncalibrated = await uploadAndAnalyze(page, pngFile('warm.png', scene));
  assert.equal(uncalibrated.name, 'Beige', 'the cast misleads an uncalibrated scan');
  await page.click('#btn-results-adjust');
  await page.click('#btn-toggle-patch');
  await page.click('#btn-crop-analyze');
  await page.waitForFunction(() => window.__lcs.state.result?.calibration);
  const calibrated = await readResult(page);
  assert.equal(calibrated.name, 'Light Gray');
  assert.ok(calibrated.text.includes('Calibrated with a white reference'));
  await page.click('.segmented button:text("Without calibration")');
  await page.waitForFunction(() => document.querySelector('#result-name').textContent === 'Beige');
  await page.click('button:has-text("Reset calibration")');
  await page.waitForFunction(() => window.__lcs.state.result && !window.__lcs.state.result.calibration && !document.querySelector('.segmented'));
  assert.deepEqual(errors, []);
  await context.close();
});

browserTest('correction is saved locally, listed in Settings, exported without photos, and Delete All clears it', async (browser) => {
  const { page, errors, context } = await openPage(browser, app.baseUrl);
  await uploadAndAnalyze(page, navyPhoto());
  await page.click('#btn-correct');
  await page.fill('#correction-picker input[type=search]', 'maroon');
  await page.click('#correction-picker .picker-option:has-text("Maroon")');
  assert.equal(await page.inputValue('#correction-group'), 'darks');
  await page.fill('#correction-note', '<img src=x onerror="window.__xss=1"> shirt');
  await page.click('#btn-correction-save');
  await page.waitForSelector('.correction-note');
  assert.match(await page.textContent('.correction-note'), /Your correction: Maroon · Darks/);
  assert.equal(await page.evaluate(() => window.__lcs.state.result.detectedColorId), 'navy', 'machine result unchanged');

  await page.click('#btn-results-home');
  await page.click('#btn-settings');
  await page.waitForSelector('text=Saved corrections (1)');
  assert.equal(await page.evaluate(() => window.__xss), undefined, 'notes render as text');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Export")')]);
  const exported = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')));
  assert.equal(exported.format, 'laundry-color-scanner-export');
  assert.equal(exported.corrections.length, 1);
  assert.equal(exported.corrections[0].original.detectedColorId, 'navy');
  assert.equal(exported.corrections[0].usedForLearning, false);
  assert.ok(!/data:image|"rgba"/.test(JSON.stringify(exported)));

  await page.click('button:has-text("Delete all local data")');
  await page.click('#dialog-confirm');
  await page.waitForSelector('text=Saved corrections (0)');
  assert.equal(await page.evaluate(async () => (await window.__lcs.storage.listCorrections()).length), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

browserTest('reference profile: quality gates preview and saving numbers only', async (browser) => {
  const { page, context } = await openPage(browser, app.baseUrl);
  await uploadAndAnalyze(page, navyPhoto());
  await page.click('button:has-text("Add Reference")');
  await page.waitForSelector('#reference-preview .gates');
  assert.match(await page.textContent('#reference-preview'), /pending/i, 'unknown lighting saves as pending');
  await page.check('input[name="condition"][value="neutral"]');
  assert.match(await page.textContent('#reference-preview'), /Will be enabled for matching/);
  await page.click('#btn-reference-save');
  await page.waitForSelector('#screen-results:not([hidden])');
  const profiles = await page.evaluate(() => window.__lcs.storage.listProfiles());
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].status, 'approved');
  assert.deepEqual(Object.keys(profiles[0]).sort(), ['captureCondition', 'colorId', 'colorSpace', 'createdAt', 'detectorVersion', 'id', 'lab', 'sampleCount', 'schemaVersion', 'source', 'spreadMedianDE00', 'status']);
  await context.close();
});

browserTest('grouping settings: successive changes all persist, keep focus, and apply to new scans', async (browser) => {
  const { page, errors, context } = await openPage(browser, app.baseUrl);
  await page.click('#btn-settings');
  const row = (name) => page.locator('.override-row').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) });
  const purples = row('Purples').locator('select');
  await purples.focus(); // selectOption() alone doesn't move focus
  await purples.selectOption('darks');
  await page.waitForFunction(() => window.__lcs.settings.grouping.familyGroups.purple === 'darks');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT', 'focus kept after saving');
  await page.click('summary:has-text("Per-color overrides")');
  assert.equal(await row('Purple').locator('option').first().textContent(), 'Automatic (Darks)');
  await row('Lavender').locator('select').selectOption('other');
  await page.waitForFunction(() => window.__lcs.settings.grouping.colorOverrides.lavender === 'other');
  const stored = await page.evaluate(() => window.__lcs.storage.getSetting('grouping'));
  assert.deepEqual(stored.familyGroups, { purple: 'darks' }, 'first change not overwritten by the second');
  assert.deepEqual(stored.colorOverrides, { lavender: 'other' });
  assert.match(await page.textContent('summary:has-text("Per-color overrides")'), /\(1\)/);

  await page.click('#btn-settings-back');
  const r = await uploadAndAnalyze(page, pngFile('purple.png', solid('#795387', { width: 400, height: 400, noise: 2 })));
  assert.equal(r.name, 'Purple');
  assert.equal(r.group, 'Darks');
  assert.match(r.result.groupingVersion, /^standard-1\.0\.0#[0-9a-f]{8}$/);
  assert.deepEqual(errors, []);
  await context.close();
});

browserTest('storage unavailable: scanning still works and saving says so', async (browser) => {
  const { page, errors, context } = await openPage(browser, app.baseUrl, {
    initScript: () => Object.defineProperty(window, 'indexedDB', { get: () => undefined }),
  });
  const r = await uploadAndAnalyze(page, navyPhoto());
  assert.equal(r.name, 'Navy');
  await page.click('#btn-correct');
  await page.click('#correction-picker .picker-option:has-text("Navy")');
  await page.click('#btn-correction-save');
  assert.match(await page.textContent('#correction-form .inline-error'), /Could not save locally/);
  assert.deepEqual(errors, []);
  await context.close();
});

browserTest('upload errors: unsupported type, oversize file, mostly transparent image', async (browser) => {
  const { page, context } = await openPage(browser, app.baseUrl);
  await page.setInputFiles('#file-input', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForSelector('#toast:not([hidden])');
  assert.match(await page.textContent('#toast'), /file type isn’t supported/);

  await page.setInputFiles('#file-input', { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(21 * 1024 * 1024) });
  await page.waitForFunction(() => /larger than 20 MB/.test(document.querySelector('#toast').textContent));

  const clear = paint(400, 400, (x, y) => (x > 170 && x < 230 && y > 170 && y < 230 ? [36, 49, 82, 255] : [0, 0, 0, 0]));
  await page.setInputFiles('#file-input', pngFile('clear.png', clear));
  await page.waitForSelector('#screen-crop:not([hidden])');
  await page.click('#btn-crop-analyze');
  await page.waitForSelector('#crop-error:not([hidden])');
  assert.match(await page.textContent('#crop-error'), /Not enough of the photo is inside the target/);
  await context.close();
});

browserTest('keyboard moves and resizes the target; numeric fields stay in sync', async (browser) => {
  const { page, context } = await openPage(browser, app.baseUrl);
  await page.setInputFiles('#file-input', navyPhoto());
  await page.waitForSelector('#screen-crop:not([hidden])');
  const before = await page.evaluate(() => window.__lcs.state.roi);
  await page.focus('.region--garment');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const afterMove = await page.evaluate(() => window.__lcs.state.roi);
  assert.ok(Math.abs(afterMove.x - before.x - 0.04) < 1e-9);
  assert.ok(Math.abs(afterMove.height - before.height - 0.02) < 1e-9);
  assert.match(await page.getAttribute('.region--garment', 'aria-label'), /^Fabric: \d+% from left/);
  await page.click('.numeric-crop summary');
  const left = page.locator('.numeric-fields fieldset').first().locator('input').first();
  assert.equal(await left.inputValue(), String(Math.round(afterMove.x * 100)));
  await left.fill('10');
  await left.dispatchEvent('change');
  assert.ok(Math.abs((await page.evaluate(() => window.__lcs.state.roi.x)) - 0.1) < 1e-9);
  await context.close();
});

browserTest('browser Back behaves like Cancel', async (browser) => {
  const { page, context } = await openPage(browser, app.baseUrl);
  await page.click('#btn-settings');
  await page.waitForSelector('#screen-settings:not([hidden])');
  await page.goBack();
  await page.waitForSelector('#screen-home:not([hidden])');
  await uploadAndAnalyze(page, navyPhoto());
  await page.click('#btn-correct');
  await page.goBack();
  await page.waitForSelector('#screen-results:not([hidden])');
  await page.goBack();
  await page.waitForSelector('#screen-home:not([hidden])');
  assert.equal(await page.evaluate(() => window.__lcs.state.image), null, 'scan image released');
  await context.close();
});

browserTest('EXIF orientation is applied exactly once', async (browser) => {
  const { page, context } = await openPage(browser, app.baseUrl);
  const out = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(100, 0, 100, 100);
    const jpeg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95))).arrayBuffer());
    // APP1 Exif, big-endian TIFF, one IFD entry: Orientation (0x0112) = 6 (rotate 90° CW).
    const exif = [0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    let pos = 2;
    if (jpeg[2] === 0xff && jpeg[3] === 0xe0) pos = 4 + ((jpeg[4] << 8) | jpeg[5]);
    const bytes = new Uint8Array(jpeg.length + exif.length);
    bytes.set(jpeg.subarray(0, pos));
    bytes.set(exif, pos);
    bytes.set(jpeg.subarray(pos), pos + exif.length);
    const { decodeImageFile } = await import('./src/image-input.js');
    const decoded = await decodeImageFile(new File([bytes], 'o6.jpg', { type: 'image/jpeg' }), window.__lcs.config.input);
    const px = (x, y) => [...decoded.canvas.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)];
    return { w: decoded.width, h: decoded.height, top: px(50, 40), bottom: px(50, 160) };
  });
  assert.deepEqual([out.w, out.h], [100, 200], 'dimensions rotated once');
  assert.ok(out.top[0] > 200 && out.top[2] < 60, `top should be red, got ${out.top}`);
  assert.ok(out.bottom[2] > 200 && out.bottom[0] < 60, `bottom should be blue, got ${out.bottom}`);
  await context.close();
});

browserTest('AI review (mock provider): nothing is sent without Send; suggestion stays separate', async (browser) => {
  const { page, context, requests } = await openPage(browser, `${app.baseUrl}?ai=mock`);
  assert.match(await page.textContent('#privacy-note'), /unless you choose AI review/);
  await uploadAndAnalyze(page, pngFile('neon.png', solid([0, 255, 64], { width: 600, height: 600, noise: 2 })));
  const before = requests.length;
  await page.click('button:has-text("Review with AI")');
  await page.waitForSelector('#dialog[open]');
  assert.match(await page.textContent('#dialog-body'), /will be sent to Mock AI \(offline test\).*may leave your device/);
  assert.equal(await page.locator('#dialog-body img').count(), 1, 'shows the exact crop');
  await page.click('#dialog-cancel');
  await page.waitForFunction(() => !document.querySelector('#dialog').open);
  assert.ok(requests.slice(before).every((r) => r.method === 'GET'), 'Cancel sent nothing');
  await page.click('button:has-text("Review with AI")');
  await page.click('#dialog-confirm');
  await page.waitForFunction(() => /Suggestion from/.test(document.querySelector('#dialog-title').textContent) && document.querySelector('#dialog').open);
  assert.match(await page.textContent('#dialog-body'), /not the detector’s confidence/);
  await page.click('#dialog-confirm');
  assert.equal(await page.evaluate(() => window.__lcs.state.result.detectedColorId), null, 'local result untouched');
  assert.ok(requests.slice(before).every((r) => r.method === 'GET'), 'mock provider made no network request');
  await context.close();
});
