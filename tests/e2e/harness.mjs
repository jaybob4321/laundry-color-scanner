/**
 * Browser test harness: static server + a browser engine.
 *
 *   E2E_BROWSER=chromium (default)  system Edge (E2E_CHANNEL=chrome for Chrome)
 *   E2E_BROWSER=webkit              Playwright WebKit (Safari's engine) emulating
 *                                   an iPhone; install once with
 *                                   `npx playwright-core install webkit`
 *   E2E_HEADED=1                    show the browser window
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, devices, webkit } from 'playwright-core';
import { encodePNG } from '../../scripts/lib/png.mjs';
import { startServer } from '../../scripts/serve.mjs';

export async function startApp() {
  const overrides = new Map();
  const server = await startServer({ port: 0, quiet: true, overrides });
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const close = () =>
    new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    });
  return { baseUrl, overrides, close };
}

export const ENGINE = (process.env.E2E_BROWSER ?? 'chromium').toLowerCase();
export const IS_WEBKIT = ENGINE === 'webkit';

/**
 * WebKit's Windows build has no media-capture support (no MediaStream,
 * no getUserMedia), so live camera frames can only be tested in Chromium's
 * fake capture device, and on a real iPhone.
 */
export const LIVE_CAMERA_SKIP = IS_WEBKIT && 'WebKit on Windows has no media capture; covered by Chromium runs and real-device testing';

export async function launchBrowser({ fakeCamera = true, videoFile = null, autoAcceptCamera = false } = {}) {
  if (IS_WEBKIT) return webkit.launch({ headless: !process.env.E2E_HEADED });
  const args = [];
  if (fakeCamera) args.push('--use-fake-device-for-media-stream');
  if (autoAcceptCamera) args.push('--use-fake-ui-for-media-stream');
  if (videoFile) args.push(`--use-file-for-fake-video-capture=${videoFile}`);
  return chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'msedge', headless: !process.env.E2E_HEADED, args });
}

let shared = null;

/** One browser per test file, relaunched if its process has died. */
export async function sharedBrowser() {
  if (!shared || !shared.isConnected()) shared = await launchBrowser();
  return shared;
}

export async function closeSharedBrowser() {
  await shared?.close().catch(() => {});
  shared = null;
}

/**
 * A test that runs in the shared browser: fn(browser, t).
 *
 * WebKit's Windows build occasionally crashes its browser process. On WebKit
 * only, a test during which the browser *disconnected* is relaunched and run
 * once more (with a logged diagnostic). Failures in a healthy browser are
 * never retried, so real app bugs still fail.
 */
export function browserTest(name, options, fn) {
  if (typeof options === 'function') [fn, options] = [options, {}];
  test(name, options, async (t) => {
    for (let attempt = 1; ; attempt++) {
      const browser = await sharedBrowser();
      let disconnected = false;
      const onDisconnect = () => {
        disconnected = true;
      };
      browser.on('disconnected', onDisconnect);
      try {
        return await fn(browser, t);
      } catch (err) {
        if (IS_WEBKIT && attempt === 1) {
          // A crash can surface as a timeout just before the disconnect event.
          if (!disconnected) await new Promise((r) => setTimeout(r, 2000));
          if (disconnected || !browser.isConnected()) {
            t.diagnostic(`WebKit browser crashed (${String(err?.message).split('\n')[0]}); relaunched and retried once`);
            continue;
          }
        }
        throw err;
      } finally {
        browser.off('disconnected', onDisconnect);
      }
    }
  });
}

// WebKit runs emulate an iPhone (viewport, touch, iOS Safari user agent).
const DEVICE = IS_WEBKIT ? { ...devices['iPhone 15'] } : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 };

/** New page that records console errors, page errors and every network request. */
export async function openPage(browser, url, { contextOptions = {}, initScript = null } = {}) {
  const context = await browser.newContext({ ...DEVICE, ...contextOptions });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  context.on('request', (req) => requests.push({ url: req.url(), method: req.method(), postData: req.postData() }));
  if (initScript) await page.addInitScript(initScript);
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
  return { context, page, errors, requests };
}

export function pngFile(name, img) {
  return { name, mimeType: 'image/png', buffer: encodePNG(img.width, img.height, img.rgba) };
}

/** Upload a photo, confirm the default target and wait for the result. */
export async function uploadAndAnalyze(page, file) {
  await page.setInputFiles('#file-input', file);
  await page.waitForSelector('#screen-crop:not([hidden])');
  await page.click('#btn-crop-analyze');
  await page.waitForSelector('#screen-results:not([hidden]) #result-name');
  return readResult(page);
}

export function readResult(page) {
  return page.evaluate(() => ({
    name: document.querySelector('#result-name')?.textContent,
    group: document.querySelector('.group-row strong')?.textContent,
    confidence: document.querySelector('.confidence-line span')?.textContent ?? null,
    text: document.querySelector('#result-body')?.innerText ?? '',
    result: window.__lcs?.state.result,
  }));
}

/**
 * Write a Y4M (I420, BT.601 limited range) video of `frames` frames drawn by
 * paint(x, y) -> [r,g,b], for Chromium's fake capture device.
 */
export function writeY4m(paint, { width = 640, height = 480, frames = 10 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lcs-e2e-'));
  const file = join(dir, 'camera.y4m');
  const ySize = width * height;
  const cSize = (width / 2) * (height / 2);
  const frame = Buffer.alloc(ySize + 2 * cSize);
  const rgbAt = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgbAt.push(paint(x, y));
  for (let i = 0; i < ySize; i++) {
    const [r, g, b] = rgbAt[i];
    frame[i] = Math.round(16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255);
  }
  for (let cy = 0; cy < height / 2; cy++) {
    for (let cx = 0; cx < width / 2; cx++) {
      const [r, g, b] = rgbAt[cy * 2 * width + cx * 2];
      frame[ySize + cy * (width / 2) + cx] = Math.round(128 + (-37.797 * r - 74.203 * g + 112 * b) / 255);
      frame[ySize + cSize + cy * (width / 2) + cx] = Math.round(128 + (112 * r - 93.786 * g - 18.214 * b) / 255);
    }
  }
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`);
  const parts = [header];
  for (let f = 0; f < frames; f++) parts.push(Buffer.from('FRAME\n'), frame);
  writeFileSync(file, Buffer.concat(parts));
  return file;
}
