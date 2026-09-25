import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIValidationError, validateAISuggestion } from '../../src/ai/provider-contract.js';
import { createMockProvider, createProxyProvider, getConfiguredProvider, localSummaryOf, runAIReview, shouldOfferAIReview } from '../../src/ai/client.js';
import { APP_CONFIG } from '../../src/app-config.js';
import { GROUP_IDS } from '../../src/grouping.js';
import { createDetectorContext, analyzePixels } from '../../src/detection/pipeline.js';
import { solid, toInput } from '../fixtures/synthetic.mjs';
import { loadConfig, loadPalette } from '../helpers.mjs';

const palette = loadPalette();
const allowed = { allowedColorIds: palette.colors.map((c) => c.id), allowedGroupIds: GROUP_IDS };
const ctx = createDetectorContext({ config: loadConfig(), palette });
const result = analyzePixels(toInput(solid('#202E4D', { width: 96, height: 96 })), ctx).result;
const valid = { colorId: 'navy', groupId: 'darks', pattern: 'single', components: [{ colorId: 'navy', fraction: 1 }], explanation: 'Looks navy.' };

test('AI is disabled by default: no provider, no offer', () => {
  assert.equal(APP_CONFIG.ai.provider, null);
  assert.equal(getConfiguredProvider(APP_CONFIG.ai), null);
  assert.equal(shouldOfferAIReview({ ...result, confidence: 10 }, APP_CONFIG.ai, null), false);
  assert.equal(getConfiguredProvider(APP_CONFIG.ai, { allowMock: false, search: '?ai=mock' }), null, 'mock needs a debug build');
});

test('offered only for low-confidence or ambiguous scans when a provider exists', () => {
  const provider = createMockProvider();
  assert.equal(shouldOfferAIReview({ ...result, confidence: 85 }, APP_CONFIG.ai, provider), false);
  assert.equal(shouldOfferAIReview({ ...result, confidence: 40 }, APP_CONFIG.ai, provider), true);
  assert.equal(shouldOfferAIReview({ ...result, confidence: 85, patternStatus: 'ambiguous' }, APP_CONFIG.ai, provider), true);
});

test('response validation rejects unknown ids, bad fractions and non-objects; bounds text', () => {
  assert.deepEqual(validateAISuggestion(valid, allowed), valid);
  const bad = (patch) => assert.throws(() => validateAISuggestion({ ...valid, ...patch }, allowed), AIValidationError);
  bad({ colorId: 'unicorn' });
  bad({ groupId: 'socks' });
  bad({ pattern: 'plaid' });
  bad({ components: [{ colorId: 'navy', fraction: 0.5 }] });
  bad({ components: [{ colorId: 'navy', fraction: NaN }] });
  bad({ components: [{ colorId: 'ghost', fraction: 1 }] });
  assert.throws(() => validateAISuggestion('navy', allowed), AIValidationError);
  const long = validateAISuggestion({ ...valid, explanation: 'x'.repeat(5000) }, allowed);
  assert.equal(long.explanation.length, 600);
});

test('nothing is sent before consent; Cancel sends nothing', async () => {
  let calls = 0;
  const provider = { name: 'Spy', analyze: async () => (calls++, valid) };
  const outcome = await runAIReview({ provider, imageBlob: new Blob(['x']), result, ...allowed, consent: async () => false });
  assert.deepEqual(outcome, { status: 'canceled' });
  assert.equal(calls, 0);
});

test('consented request sends a numbers-only summary and validates the answer', async () => {
  let seen = null;
  const provider = { name: 'Spy', analyze: async (req) => ((seen = req), valid) };
  const outcome = await runAIReview({ provider, imageBlob: new Blob(['jpeg']), result, ...allowed, consent: async () => true });
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(seen.localSummary, localSummaryOf(result));
  assert.ok(!JSON.stringify(seen.localSummary).includes('rgba'));
  const invalid = await runAIReview({ provider: { name: 'Bad', analyze: async () => ({ groupId: 'socks' }) }, imageBlob: new Blob(['x']), result, ...allowed, consent: async () => true });
  assert.equal(invalid.status, 'invalid');
});

test('timeouts and user cancellation abort the request', async () => {
  const slow = { name: 'Slow', analyze: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) };
  const timedOut = await runAIReview({ provider: slow, imageBlob: new Blob(['x']), result, ...allowed, consent: async () => true, timeoutMs: 20 });
  assert.equal(timedOut.status, 'timeout');
  const controller = new AbortController();
  const pending = runAIReview({ provider: slow, imageBlob: new Blob(['x']), result, ...allowed, consent: async () => true, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  assert.equal((await pending).status, 'canceled');
});

test('proxy provider posts to a same-origin endpoint only, without credentials in the page', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return { ok: true, json: async () => valid };
  };
  globalThis.location = new URL('https://app.example/scanner/');
  try {
    const provider = createProxyProvider({ endpoint: './api/ai-color', name: 'Proxy', fetchImpl });
    const raw = await provider.analyze({ imageBlob: new Blob(['x']), localSummary: {}, ...allowed, signal: new AbortController().signal });
    assert.deepEqual(raw, valid);
    assert.equal(requests[0].url, 'https://app.example/scanner/api/ai-color');
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.cache, 'no-store');
    assert.throws(() => createProxyProvider({ endpoint: 'https://evil.example/ai', name: 'X', fetchImpl }), /same-origin/);
  } finally {
    delete globalThis.location;
  }
});
