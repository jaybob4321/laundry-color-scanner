/**
 * Service worker registration, update prompts, install affordances and
 * offline readiness (blueprint §15).
 *
 * - "Offline ready" appears only after the active worker verifies that every
 *   precached file is in its cache.
 * - Updates install in the background; the user activates them from Home
 *   ("Reload to update"), never mid-scan.
 * - Installation is offered only where the browser supports it; iOS Safari
 *   gets manual Add to Home Screen guidance instead.
 * - Any failure here leaves online scanning untouched.
 */

function isStandalone() {
  return globalThis.matchMedia?.('(display-mode: standalone)').matches || globalThis.navigator?.standalone === true;
}

function isIos() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function ask(worker, message, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

export function createPwa({ onChange, disabled = false }) {
  const state = {
    offline: 'checking', // checking | ready | not-ready | unsupported | error
    version: null,
    updateReady: false,
    installEvent: null,
    installed: isStandalone(),
    registration: null,
    reloading: false,
  };
  const changed = () => onChange?.(state);

  async function verify() {
    const registration = await navigator.serviceWorker.ready;
    const result = registration.active ? await ask(registration.active, { type: 'VERIFY_CACHE' }) : null;
    state.offline = result?.ok ? 'ready' : 'not-ready';
    state.version = result?.version ?? null;
    changed();
  }

  function watchForUpdates(registration) {
    const markWaiting = () => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        state.updateReady = true;
        changed();
      }
    };
    markWaiting();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') markWaiting();
        if (worker.state === 'activated') verify().catch(() => {});
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) registration.update().catch(() => {});
    });
  }

  async function init() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.installEvent = event;
      changed();
    });
    window.addEventListener('appinstalled', () => {
      state.installEvent = null;
      state.installed = true;
      changed();
    });
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      state.offline = 'unsupported';
      changed();
      return;
    }
    if (disabled) {
      // Development switch (?nosw=1 in debug builds): run uncached from the server.
      for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
      state.offline = 'unsupported';
      changed();
      return;
    }
    try {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (state.reloading) window.location.reload();
      });
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      state.registration = registration;
      watchForUpdates(registration);
      await verify();
    } catch {
      state.offline = 'error';
      changed();
    }
  }

  return {
    state,
    init,
    /** Activate a waiting update. Called only from Home by the user. */
    applyUpdate() {
      const waiting = state.registration?.waiting;
      if (!waiting) {
        window.location.reload();
        return;
      }
      state.reloading = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
    },
    async promptInstall() {
      const event = state.installEvent;
      if (!event) return;
      state.installEvent = null;
      event.prompt();
      await event.userChoice.catch(() => null);
      changed();
    },
    describe() {
      const text = {
        checking: 'Checking offline support…',
        ready: 'Offline ready: scanning works without internet on this device.',
        'not-ready': 'Not yet available offline. Keep the app open online for a moment.',
        unsupported: 'Offline use isn’t available in this browser (needs https and service workers). Online scanning still works.',
        error: 'Offline caching failed to install. Online scanning still works.',
      }[state.offline];
      const installHint =
        !state.installed && !state.installEvent && isIos()
          ? 'To install on iPhone or iPad: tap the Share button, then “Add to Home Screen”.'
          : null;
      return { text, canInstall: Boolean(state.installEvent) && !state.installed, installHint };
    },
  };
}
