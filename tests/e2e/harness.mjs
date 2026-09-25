/**
 * Browser test harness: static server + system Chromium-family browser
 * (Edge by default; set E2E_CHANNEL=chrome for Chrome, E2E_HEADED=1 to watch).
 * Uses playwright-core, so no browsers are downloaded.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { encodePNG } from '../../scripts/lib/png.mjs';
import { startServer } from '../../scripts/serve.mjs';

export async function startApp() {
  const overrides = new Map();
  const server = await startServer({ port: 0, quiet: true, overrides });
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  return { baseUrl, overrides, close: () => new Promise((r) => server.close(r)) };
}

export async function launchBrowser({ fakeCamera = true, videoFile = null, autoAcceptCamera = false } = {}) {
  const args = [];
  if (fakeCamera) args.push('--use-fake-device-for-media-stream');
  if (autoAcceptCamera) args.push('--use-fake-ui-for-media-stream');
  if (videoFile) args.push(`--use-file-for-fake-video-capture=${videoFile}`);
  return chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'msedge', headless: !process.env.E2E_HEADED, args });
}

/** New page that records console errors, page errors and every network request. */
export async function openPage(browser, url, { contextOptions = {}, initScript = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ...contextOptions });
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
