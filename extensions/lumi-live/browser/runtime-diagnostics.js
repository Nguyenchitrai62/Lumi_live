export function installRuntimeDiagnosticsProbeInPage() {
  const key = "__LUMI_QC_RUNTIME_DIAGNOSTICS__";
  if (window[key]) return { installed: true, reused: true };
  const state = {
    consoleErrors: [],
    networkErrors: [],
    originalConsoleError: console.error,
    originalFetch: window.fetch,
    originalXhrOpen: XMLHttpRequest.prototype.open,
    originalXhrSend: XMLHttpRequest.prototype.send,
  };
  const clean = (value, limit = 1200) => String(value || "")
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_API_KEY]")
    .replace(
      /\b(password|passwd|pwd|otp|secret|token|authorization|cookie)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .slice(0, limit);
  const cleanUrl = (value) => {
    try {
      const url = new URL(String(value || ""), location.href);
      for (const name of [...url.searchParams.keys()]) {
        if (/key|token|secret|password|auth|session|cookie/i.test(name)) {
          url.searchParams.set(name, "[REDACTED]");
        }
      }
      url.hash = "";
      return clean(url.href, 2000);
    } catch {
      return clean(value, 2000);
    }
  };
  const push = (target, value) => {
    target.push({ timestamp: Date.now(), ...value });
    if (target.length > 100) target.splice(0, target.length - 100);
  };
  const onError = (event) => push(state.consoleErrors, {
    type: "window_error",
    message: clean(event.message || event.error?.message || "Script error"),
    source: cleanUrl(event.filename || location.href),
    line: Number(event.lineno || 0),
    column: Number(event.colno || 0),
  });
  const onRejection = (event) => push(state.consoleErrors, {
    type: "unhandled_rejection",
    message: clean(event.reason?.message || event.reason || "Unhandled rejection"),
    source: cleanUrl(location.href),
  });
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const consoleErrorWrapper = function lumiQcConsoleError(...args) {
    push(state.consoleErrors, {
      type: "console_error",
      message: clean(args.map((item) =>
        item instanceof Error ? item.message : String(item)).join(" ")),
      source: cleanUrl(location.href),
    });
    return state.originalConsoleError.apply(this, args);
  };
  console.error = consoleErrorWrapper;
  const fetchWrapper = async function lumiQcFetch(input, init) {
    const startedAt = performance.now();
    try {
      const response = await state.originalFetch.call(this, input, init);
      if (!response.ok) {
        push(state.networkErrors, {
          type: "fetch",
          method: clean(init?.method || "GET", 20),
          url: cleanUrl(input?.url || input),
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      return response;
    } catch (error) {
      push(state.networkErrors, {
        type: "fetch",
        method: clean(init?.method || "GET", 20),
        url: cleanUrl(input?.url || input),
        status: 0,
        message: clean(error?.message || error),
        durationMs: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
  };
  window.fetch = fetchWrapper;
  const xhrOpenWrapper = function lumiQcXhrOpen(method, url, ...rest) {
    this.__lumiQcRequest = {
      method: clean(method || "GET", 20),
      url: cleanUrl(url),
      startedAt: 0,
    };
    return state.originalXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.open = xhrOpenWrapper;
  const xhrSendWrapper = function lumiQcXhrSend(...args) {
    if (this.__lumiQcRequest) this.__lumiQcRequest.startedAt = performance.now();
    this.addEventListener("loadend", () => {
      if (this.status > 0 && this.status < 400) return;
      const request = this.__lumiQcRequest || {};
      push(state.networkErrors, {
        type: "xhr",
        method: request.method || "GET",
        url: request.url || cleanUrl(this.responseURL),
        status: Number(this.status || 0),
        durationMs: request.startedAt
          ? Math.round(performance.now() - request.startedAt)
          : 0,
      });
    }, { once: true });
    return state.originalXhrSend.apply(this, args);
  };
  XMLHttpRequest.prototype.send = xhrSendWrapper;
  state.restore = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    if (console.error === consoleErrorWrapper) console.error = state.originalConsoleError;
    if (window.fetch === fetchWrapper) window.fetch = state.originalFetch;
    if (XMLHttpRequest.prototype.open === xhrOpenWrapper) {
      XMLHttpRequest.prototype.open = state.originalXhrOpen;
    }
    if (XMLHttpRequest.prototype.send === xhrSendWrapper) {
      XMLHttpRequest.prototype.send = state.originalXhrSend;
    }
  };
  window[key] = state;
  return { installed: true, reused: false };
}

export function collectRuntimeDiagnosticsInPage(clear = true) {
  const state = window.__LUMI_QC_RUNTIME_DIAGNOSTICS__;
  if (!state) return { installed: false, consoleErrors: [], networkErrors: [] };
  const result = {
    installed: true,
    consoleErrors: state.consoleErrors.slice(-50),
    networkErrors: state.networkErrors.slice(-50),
  };
  if (clear) {
    state.consoleErrors.length = 0;
    state.networkErrors.length = 0;
  }
  return result;
}

export function removeRuntimeDiagnosticsProbeInPage() {
  const key = "__LUMI_QC_RUNTIME_DIAGNOSTICS__";
  const state = window[key];
  if (!state) return { removed: false };
  state.restore?.();
  delete window[key];
  return { removed: true };
}
