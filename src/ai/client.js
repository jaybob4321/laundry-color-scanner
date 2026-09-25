/**
 * Optional AI review client (blueprint §16). Provider-specific code stays
 * behind the AIColorProvider contract; the default build has no provider.
 *
 * Rules enforced here:
 *  - Offered only when a provider is configured AND the scan is low
 *    confidence or pattern-ambiguous. Never invoked automatically.
 *  - Nothing is sent until the user approves this specific request.
 *  - Same-origin proxy only: no API keys in the browser.
 *  - 15 s timeout, cancelable, no retries, no caching.
 */
import { AI_LIMITS, AIValidationError, validateAISuggestion } from './provider-contract.js';

export function shouldOfferAIReview(result, aiConfig, provider) {
  if (!provider || !result) return false;
  return result.patternStatus === 'ambiguous' || result.confidence === null || result.confidence < aiConfig.offerBelowConfidence;
}

/** Numbers from the local analysis — never pixels. */
export function localSummaryOf(result) {
  return {
    detectedColorId: result.detectedColorId,
    patternStatus: result.patternStatus,
    laundryGroup: result.laundryGroup,
    confidence: result.confidence,
    components: result.clusters.map((c) => ({ colorId: c.matches[0].colorId, fraction: c.fraction, lab: c.lab })),
  };
}

/** Provider that POSTs to a same-origin serverless proxy holding the credentials. */
export function createProxyProvider({ endpoint, name, retentionNote = null, fetchImpl = globalThis.fetch }) {
  const url = new URL(endpoint, globalThis.location?.href);
  if (globalThis.location && url.origin !== globalThis.location.origin) throw new Error('AI proxy must be same-origin');
  return {
    name,
    retentionNote,
    async analyze({ imageBlob, localSummary, allowedColorIds, allowedGroupIds, signal }) {
      const body = new FormData();
      body.append('image', imageBlob, 'crop.jpg');
      body.append('request', JSON.stringify({ localSummary, allowedColorIds, allowedGroupIds }));
      const response = await fetchImpl(url, { method: 'POST', body, signal, credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`AI proxy HTTP ${response.status}`);
      return response.json();
    },
  };
}

/** Local stand-in used only by tests and debug builds (?ai=mock). Sends nothing. */
export function createMockProvider() {
  return {
    name: 'Mock AI (offline test)',
    retentionNote: 'Test provider: nothing leaves this device.',
    async analyze({ localSummary, signal }) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 300);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
      const top = localSummary.components[0];
      return { colorId: top?.colorId ?? null, groupId: localSummary.laundryGroup, pattern: 'unknown', components: [], explanation: 'Mock response for testing.' };
    },
  };
}

export function getConfiguredProvider(aiConfig, { allowMock = false, search = '' } = {}) {
  if (allowMock && new URLSearchParams(search).get('ai') === 'mock') return createMockProvider();
  if (aiConfig.provider === 'proxy' && aiConfig.endpoint) {
    return createProxyProvider({ endpoint: aiConfig.endpoint, name: aiConfig.providerName ?? 'AI provider', retentionNote: aiConfig.retentionNote ?? null });
  }
  return null;
}

/**
 * Run one consented AI review. `consent` must resolve true before anything
 * is sent. Returns { status: 'ok'|'canceled'|'timeout'|'invalid'|'failed', suggestion? }.
 */
export async function runAIReview({ provider, imageBlob, result, allowedColorIds, allowedGroupIds, consent, timeoutMs = AI_LIMITS.timeoutMs, signal }) {
  const approved = await consent();
  if (!approved) return { status: 'canceled' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort('canceled'));
  try {
    const raw = await provider.analyze({
      imageBlob,
      localSummary: localSummaryOf(result),
      allowedColorIds,
      allowedGroupIds,
      signal: controller.signal,
    });
    return { status: 'ok', suggestion: validateAISuggestion(raw, { allowedColorIds, allowedGroupIds }) };
  } catch (err) {
    if (controller.signal.aborted) return { status: controller.signal.reason === 'canceled' ? 'canceled' : 'timeout' };
    if (err instanceof AIValidationError) return { status: 'invalid' };
    return { status: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
