const TURNSTILE_HOST = 'challenges.cloudflare.com';
const TURNSTILE_PATH_FRAGMENT = '/turnstile/';
const TURNSTILE_API_SUFFIX = '/api.js';
const AGENTBROWSE_PASSTHROUGH_PARAM = '__agentbrowse_passthrough';

export function isTurnstileApiRequest(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === TURNSTILE_HOST &&
      parsed.pathname.includes(TURNSTILE_PATH_FRAGMENT) &&
      parsed.pathname.endsWith(TURNSTILE_API_SUFFIX) &&
      !parsed.searchParams.has(AGENTBROWSE_PASSTHROUGH_PARAM)
    );
  } catch {
    return false;
  }
}

export function buildTurnstileApiShimSource(originalUrl: string): string {
  const serializedUrl = JSON.stringify(originalUrl);

  return `
(function () {
  const originalUrl = ${serializedUrl};
  const passthroughParam = ${JSON.stringify(AGENTBROWSE_PASSTHROUGH_PARAM)};
  const callbacksKey = '__agentbrowseTurnstileCallbacks';
  const challengesKey = '__agentbrowseTurnstileChallenges';
  const pendingRendersKey = '__agentbrowseTurnstilePendingRenders';
  const scriptLoadKey = '__agentbrowseTurnstileRealScriptLoading';
  const stateKey = '__agentbrowseTurnstileState';

  function ensureStores(win) {
    if (!Array.isArray(win[challengesKey])) {
      win[challengesKey] = [];
    }
    if (!win[callbacksKey] || typeof win[callbacksKey] !== 'object') {
      win[callbacksKey] = {};
    }
    if (!win[stateKey] || typeof win[stateKey] !== 'object') {
      win[stateKey] = { nextCallbackId: 1 };
    }
    if (!Array.isArray(win[pendingRendersKey])) {
      win[pendingRendersKey] = [];
    }
  }

  function addPassthroughParam(url) {
    const parsed = new URL(url);
    parsed.searchParams.set(passthroughParam, '1');
    parsed.searchParams.delete('onload');
    return parsed.toString();
  }

  function appendRealScript(doc, win, src, stubRender) {
    if (win[scriptLoadKey]) {
      return;
    }
    win[scriptLoadKey] = true;
    const script = doc.createElement('script');
    script.src = addPassthroughParam(src);
    script.async = true;
    script.onload = function () {
      win[scriptLoadKey] = false;
      const pendingRenders = Array.isArray(win[pendingRendersKey]) ? win[pendingRendersKey].slice() : [];
      win[pendingRendersKey] = [];
      const realTurnstile = win.turnstile;
      if (!realTurnstile || typeof realTurnstile.render !== 'function' || realTurnstile.render === stubRender) {
        return;
      }
      for (const entry of pendingRenders) {
        try {
          realTurnstile.render(entry.container, entry.options);
        } catch {
          // Preserve page execution if passthrough replay fails.
        }
      }
    };
    (doc.head || doc.documentElement).appendChild(script);
  }

  function notifyOnload(win, onloadName) {
    if (!onloadName) return;
    const current = win[onloadName];
    if (typeof current === 'function') {
      current();
      return;
    }

    try {
      let assignedValue;
      Object.defineProperty(win, onloadName, {
        configurable: true,
        enumerable: true,
        get: function () {
          return assignedValue;
        },
        set: function (value) {
          assignedValue = value;
          if (typeof value === 'function') {
            value();
          }
        },
      });
    } catch {
      // Ignore non-configurable global callback names.
    }
  }

  const win = window;
  const doc = document;
  const parsedUrl = new URL(originalUrl);
  const onloadName = parsedUrl.searchParams.get('onload') || '';
  ensureStores(win);
  const callbacks = win[callbacksKey];
  const challenges = win[challengesKey];
  const pendingRenders = win[pendingRendersKey];
  const state = win[stateKey];
  win.__agentbrowseTurnstileShimInstalled = true;
  const userAgent = (win.navigator && typeof win.navigator.userAgent === 'string')
    ? win.navigator.userAgent
    : '';

  const stubRender = function (container, options) {
      const isChallenge = Boolean(
        options && (
          (typeof options.cData === 'string' && options.cData) ||
          (typeof options.chlPageData === 'string' && options.chlPageData)
        )
      );

      if (!isChallenge) {
        state.lastShimMode = 'passthrough';
        pendingRenders.push({ container: container, options: options });
        appendRealScript(doc, win, originalUrl, stubRender);
        return 'agentbrowse-turnstile-passthrough';
      }

      const callbackId = typeof options.callback === 'function'
        ? 'cf-turnstile-callback-' + String(state.nextCallbackId || 1)
        : '';
      if (callbackId) {
        callbacks[callbackId] = options.callback;
        state.nextCallbackId = (state.nextCallbackId || 1) + 1;
      }

      challenges.push({
        siteKey: typeof options.sitekey === 'string'
          ? options.sitekey
          : typeof options.siteKey === 'string'
          ? options.siteKey
          : '',
        action: typeof options.action === 'string' ? options.action : '',
        cData: typeof options.cData === 'string' ? options.cData : '',
        chlPageData: typeof options.chlPageData === 'string' ? options.chlPageData : '',
        callbackId: callbackId,
        userAgent: userAgent,
        captureSource: 'api-shim',
      });
      state.lastShimMode = 'challenge-captured';

      return 'agentbrowse-turnstile-challenge';
    };

  win.turnstile = {
    render: stubRender,
    execute: function () {
      return 'agentbrowse-turnstile-challenge';
    },
    reset: function () {},
    remove: function () {},
  };

  notifyOnload(win, onloadName);
})();
`;
}
