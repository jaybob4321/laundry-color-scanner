/**
 * AIColorProvider contract (blueprint §16). Optional and disabled by
 * default; the local detector never depends on it.
 *
 * interface AIColorProvider {
 *   name: string;                  // shown to the user before anything is sent
 *   retentionNote?: string;        // provider's actual data-retention terms
 *   analyze(request: {
 *     imageBlob: Blob;             // re-encoded JPEG crop, ≤ 768 px, no metadata
 *     localSummary: object;        // numbers from the local result, no pixels
 *     allowedColorIds: string[];
 *     allowedGroupIds: string[];
 *     signal: AbortSignal;
 *   }): Promise<unknown>;          // validated with validateAISuggestion()
 * }
 *
 * AI output is untrusted: IDs must come from the allowed lists, fractions
 * must be finite and sum to 1 ± 0.02, and text is length-bounded and only
 * ever rendered as text. AI-reported confidence is never shown as detector
 * confidence.
 */

export const AI_LIMITS = Object.freeze({
  maxImageEdge: 768,
  timeoutMs: 15000,
  maxExplanationLength: 600,
  maxComponents: 6,
  fractionTolerance: 0.02,
});

export class AIValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AIValidationError';
  }
}

export function validateAISuggestion(raw, { allowedColorIds, allowedGroupIds }) {
  const colors = new Set(allowedColorIds);
  const groups = new Set(allowedGroupIds);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AIValidationError('Response is not an object');
  const colorId = raw.colorId ?? null;
  if (colorId !== null && !colors.has(colorId)) throw new AIValidationError('Unknown color id');
  if (!groups.has(raw.groupId)) throw new AIValidationError('Unknown group id');
  if (!['single', 'multicolor', 'unknown'].includes(raw.pattern)) throw new AIValidationError('Invalid pattern');
  const components = Array.isArray(raw.components) ? raw.components : [];
  if (components.length > AI_LIMITS.maxComponents) throw new AIValidationError('Too many components');
  let sum = 0;
  const clean = components.map((c) => {
    if (!c || !colors.has(c.colorId)) throw new AIValidationError('Unknown component color');
    if (typeof c.fraction !== 'number' || !Number.isFinite(c.fraction) || c.fraction < 0 || c.fraction > 1) {
      throw new AIValidationError('Invalid component fraction');
    }
    sum += c.fraction;
    return { colorId: c.colorId, fraction: c.fraction };
  });
  if (clean.length && Math.abs(sum - 1) > AI_LIMITS.fractionTolerance) throw new AIValidationError('Fractions do not sum to 1');
  const explanation = typeof raw.explanation === 'string' ? raw.explanation.slice(0, AI_LIMITS.maxExplanationLength) : '';
  return { colorId, groupId: raw.groupId, pattern: raw.pattern, components: clean, explanation };
}
