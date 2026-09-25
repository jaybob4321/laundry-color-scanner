/**
 * "Review with AI" flow (blueprint §16). Shows the exact crop, the provider
 * name and a leave-the-device warning; only an explicit Send transmits.
 * The AI answer is shown separately and never replaces the local result.
 */
import { AI_LIMITS } from '../ai/provider-contract.js';
import { runAIReview, shouldOfferAIReview } from '../ai/client.js';
import { GROUP_IDS, groupLabel } from '../grouping.js';
import { encodeRegionJpeg } from '../image-input.js';
import { confirmDialog, h, toast } from './dom.js';

export function createAIReviewController(app, provider) {
  return {
    enabled: Boolean(provider),
    shouldOffer(result) {
      return shouldOfferAIReview(result, app.appConfig.ai, provider);
    },
    async review() {
      const { result, image } = app.state;
      if (!provider || !result || !image) return;
      const blob = await encodeRegionJpeg(image.canvas, result.roi, AI_LIMITS.maxImageEdge);
      const url = URL.createObjectURL(blob);
      try {
        const outcome = await runAIReview({
          provider,
          imageBlob: blob,
          result,
          allowedColorIds: app.palette.colors.map((c) => c.id),
          allowedGroupIds: GROUP_IDS,
          consent: () =>
            confirmDialog({
              title: 'Send this crop for AI review?',
              body: [
                h('img', { src: url, alt: 'The exact image crop that would be sent' }),
                `This crop will be sent to ${provider.name} for analysis. It may leave your device.`,
                provider.retentionNote ?? 'Check the provider’s data-retention terms before sending.',
              ],
              confirmText: 'Send',
            }),
        });
        if (outcome.status === 'ok') {
          const s = outcome.suggestion;
          await confirmDialog({
            title: `Suggestion from ${provider.name}`,
            body: [
              `Color: ${s.colorId ? app.palette.byId.get(s.colorId).name : 'Not identified'}`,
              `Laundry group: ${groupLabel(s.groupId)}`,
              s.explanation ? `“${s.explanation}”` : null,
              'This is a separate AI suggestion, not the detector’s confidence. Your local result is unchanged; use Correct Result if you want to save a correction.',
            ].filter(Boolean),
            confirmText: 'Done',
            hideCancel: true,
          });
        } else if (outcome.status !== 'canceled') {
          const text = { timeout: 'AI review timed out. Your local result is unchanged.', invalid: 'The AI response was invalid and was ignored.', failed: 'AI review is unavailable right now. Your local result is unchanged.' };
          toast(text[outcome.status]);
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}
