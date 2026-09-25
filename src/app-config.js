/**
 * App-level switches that are not detector thresholds (those live in
 * data/detector-config.json and are versioned with every result).
 */
export const APP_CONFIG = Object.freeze({
  appVersion: '1.0.0',

  // Developer/debug view. Set to false for a production build: the Settings
  // toggle disappears and ?debug=1 is ignored.
  debugAvailable: true,

  // Optional AI review (blueprint §16). Disabled: no provider, no endpoint,
  // nothing is ever sent. To enable later, configure a same-origin proxy that
  // keeps credentials server-side, e.g.
  //   ai: { provider: 'proxy', endpoint: './api/ai-color', providerName: 'Example AI', offerBelowConfidence: 60 }
  ai: Object.freeze({
    provider: null,
    endpoint: null,
    providerName: null,
    offerBelowConfidence: 60,
  }),
});
