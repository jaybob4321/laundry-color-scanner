/**
 * Camera (fake capture device), permission failures, offline behavior,
 * network privacy, and the service-worker update flow.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paint, stripes } from '../fixtures/synthetic.mjs';
import { ROOT } from '../helpers.mjs';
import { launchBrowser, openPage, pngFile, readResult, startApp, uploadAndAnalyze, writeY4m } from './harness.mjs';

let app;
let browser;
before(async () => {
  app = await startApp();
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await app?.close();
});

const origin = () => new URL(app.baseUrl).origin;

test('boots offline-ready with the worker engine and no console errors', async () => {
  const { page, errors, context } = await openPage(browser, app.baseUrl);
  await page.waitForFunction(() => window.__lcs.pwa.state.offline === 'ready', null, { timeout: 20000 });
  const info = await page.evaluate(() => ({
    engine: window.__lcs.detector.mode,
    chip: document.querySelector('#offline-status').textContent,
    storage: window.__lcs.storage.available,
  }));
  assert.deepEqual(info, { engine: 'worker', chip: 'Offline ready', storage: true });
  assert.deepEqual(errors, []);
  await context.close();
});

test('camera: rear-camera request, capture from a navy video feed, tracks released', async () => {
  const video = writeY4m(() => [32, 46, 77]);
  const camBrowser = await launchBrowser({ videoFile: video });
  try {
    const { page, errors, context } = await openPage(camBrowser, app.baseUrl, {
      contextOptions: { permissions: ['camera'] },
      initScript: () => {
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        window.__gumCalls = [];
        navigator.mediaDevices.getUserMedia = (constraints) => {
          window.__gumCalls.push(constraints);
          return original(constraints);
        };
      },
    });
    await page.click('#btn-scan');
    await page.waitForFunction(() => document.querySelector('#camera-video').videoWidth > 0 && !document.querySelector('#btn-capture').disabled);
    const calls = await page.evaluate(() => window.__gumCalls);
    assert.equal(calls[0].audio, false, 'microphone never requested');
    assert.deepEqual(calls[0].video.facingMode, { ideal: 'environment' });
    await page.waitForFunction(() => document.querySelector('#camera-feedback').textContent === 'Ready');
    await page.click('#btn-capture');
    await page.waitForSelector('#screen-results:not([hidden]) #result-name');
    const r = await readResult(page);
    assert.equal(r.result.source, 'camera');
    assert.equal(r.group, 'Darks');
    assert.ok(['Navy', 'Dark Blue', 'Indigo'].includes(r.name), r.name);
    const live = await page.evaluate(() => document.querySelector('#camera-video').srcObject);
    assert.equal(live, null, 'camera stopped after capture');
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await camBrowser.close();
  }
});

test('camera: live white-reference calibration applies to the next capture', async () => {
  const video = writeY4m(() => [205, 205, 205]);
  const camBrowser = await launchBrowser({ videoFile: video });
  try {
    const { page, context } = await openPage(camBrowser, app.baseUrl, { contextOptions: { permissions: ['camera'] } });
    await page.click('#btn-scan');
    await page.waitForFunction(() => !document.querySelector('#btn-capture').disabled);
    await page.click('#btn-calibrate');
    assert.equal(await page.getAttribute('#btn-capture', 'aria-label'), 'Set white reference');
    await page.click('#btn-capture');
    await page.waitForSelector('#camera-calibration:not([hidden])');
    assert.match(await page.textContent('#camera-calibration'), /Calibrated · 1:5\d|Calibrated · 2:00/);
    await page.click('#btn-capture');
    await page.waitForSelector('#screen-results:not([hidden]) #result-name');
    const r = await readResult(page);
    assert.ok(r.result.calibration, 'capture used the live calibration');
    assert.ok(r.result.calibration.cameraSessionId);
    await context.close();
  } finally {
    await camBrowser.close();
  }
});

for (const [name, code, pattern] of [
  ['permission denied', 'NotAllowedError', /Camera access is blocked/],
  ['no camera', 'NotFoundError', /No camera was found/],
  ['camera busy', 'NotReadableError', /in use by another app/],
]) {
  test(`camera failure (${name}) shows guidance and an upload fallback`, async () => {
    const { page, errors, context } = await openPage(browser, app.baseUrl, {
      initScript: `navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('x', '${code}'));`,
    });
    await page.click('#btn-scan');
    await page.waitForSelector('#camera-message:not([hidden])');
    assert.match(await page.textContent('#camera-message-text'), pattern);
    assert.equal(await page.isDisabled('#btn-capture'), true);
    await page.setInputFiles('#file-input', pngFile('n.png', paint(400, 400, () => [36, 49, 82])));
    await page.waitForSelector('#screen-crop:not([hidden])');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('offline: after one online visit the app reloads and scans without network', async () => {
  const { page, context } = await openPage(browser, app.baseUrl);
  await page.waitForFunction(() => window.__lcs.pwa.state.offline === 'ready', null, { timeout: 20000 });
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  assert.equal(await page.evaluate(() => window.__lcs.detector.mode), 'worker');
  const r = await uploadAndAnalyze(page, pngFile('stripes.png', stripes([{ color: '#15161A', size: 24 }, { color: '#F2F2F0', size: 24 }], { width: 600, height: 600 })));
  assert.equal(r.name, 'Multicolor');
  await context.setOffline(false);
  await context.close();
});

test('privacy: scanning sends no photo, pixel or profile data anywhere', async () => {
  const { page, context, requests } = await openPage(browser, app.baseUrl);
  await page.waitForFunction(() => window.__lcs.pwa.state.offline === 'ready', null, { timeout: 20000 });
  const before = requests.length;
  await uploadAndAnalyze(page, pngFile('p.png', paint(800, 600, (x) => (x < 400 ? [200, 50, 62] : [54, 87, 173]))));
  await page.click('#btn-correct');
  await page.click('#correction-picker .picker-option:has-text("Red")');
  await page.click('#btn-correction-save');
  await page.waitForSelector('.correction-note');
  const during = requests.slice(before);
  for (const r of during) {
    const url = new URL(r.url);
    assert.ok(url.protocol === 'blob:' || url.protocol === 'data:' || url.origin === origin(), `unexpected destination ${r.url}`);
    assert.equal(r.method, 'GET', `${r.method} ${r.url}`);
    assert.equal(r.postData ?? null, null);
  }
  await context.close();
});

test('update: a new version installs in the background and activates only from Home', async () => {
  const { page, context } = await openPage(browser, app.baseUrl);
  await page.waitForFunction(() => window.__lcs.pwa.state.offline === 'ready', null, { timeout: 20000 });
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8').replace(/version: '[^']+'/, "version: 'e2e-update'");
  app.overrides.set('/sw.js', { body: sw, type: 'text/javascript; charset=utf-8' });
  try {
    await page.evaluate(() => window.__lcs.pwa.state.registration.update());
    await page.waitForSelector('#update-banner:not([hidden])', { timeout: 20000 });
    await Promise.all([page.waitForNavigation(), page.click('#btn-apply-update')]);
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    await page.waitForFunction(() => window.__lcs.pwa.state.version === 'e2e-update', null, { timeout: 20000 });
    const caches = await page.evaluate(() => window.caches.keys());
    assert.deepEqual(caches, ['laundry-color-scanner-e2e-update'], 'obsolete app caches removed');
  } finally {
    app.overrides.delete('/sw.js');
    await context.close();
  }
});
