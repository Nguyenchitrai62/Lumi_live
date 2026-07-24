const SAME_CONTEXT_TARGETS = new Set(["_self", "_top", "_parent"]);
const SUPPORTED_TAB_PROTOCOLS = new Set(["http:", "https:", "file:"]);

export function installWindowOpenProbeInPage(probeKey, probeToken) {
  const previousProbe = globalThis[probeKey];
  if (previousProbe?.descriptor && window.open === previousProbe.wrapped) {
    try {
      Object.defineProperty(window, "open", previousProbe.descriptor);
    } catch {
      // A page may redefine window.open while a prior click is completing.
    }
  } else if (previousProbe?.wrapped && window.open === previousProbe.wrapped) {
    try {
      delete window.open;
    } catch {
      // Leave the page-owned value intact if it is no longer configurable.
    }
  }

  const descriptor = Object.getOwnPropertyDescriptor(window, "open");
  const original = window.open;
  const calls = [];
  const wrapped = function (...args) {
    calls.push({
      url: String(args[0] ?? ""),
      target: String(args[1] ?? "_blank"),
    });
    return Reflect.apply(original, this, args);
  };
  try {
    Object.defineProperty(window, "open", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value: wrapped,
    });
  } catch {
    return false;
  }
  globalThis[probeKey] = {
    token: probeToken,
    descriptor,
    original,
    wrapped,
    calls,
  };
  return window.open === wrapped;
}

export function collectWindowOpenCallsInPage(probeKey, probeToken) {
  const probe = globalThis[probeKey];
  if (!probe || probe.token !== probeToken) return [];
  if (window.open === probe.wrapped) {
    try {
      if (probe.descriptor) {
        Object.defineProperty(window, "open", probe.descriptor);
      } else {
        delete window.open;
      }
    } catch {
      // Do not overwrite a value the page installed during the click.
    }
  }
  delete globalThis[probeKey];
  return probe.calls;
}

export function watchForNewTabCreation({
  tabsApi,
  beforeTabIds,
  sourceTab,
  timeoutMs,
}) {
  let finish;
  const promise = new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    const deferredCandidates = [];
    const onCreated = (tab) => {
      if (tab?.openerTabId === sourceTab?.id) {
        finish(tab);
        return;
      }
      deferredCandidates.push(tab);
    };
    finish = (tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      tabsApi.onCreated.removeListener(onCreated);
      resolve(tab);
    };
    tabsApi.onCreated.addListener(onCreated);
    timeoutId = setTimeout(
      () => finish(selectNewlyOpenedTab(beforeTabIds, deferredCandidates, sourceTab)),
      timeoutMs,
    );
  });
  return {
    promise,
    stop() {
      finish(null);
    },
  };
}

export function resolveNewTabUrl(value, baseUrl) {
  const candidate = String(value ?? "").trim();
  if (!candidate) return null;
  try {
    const base = new URL(baseUrl);
    const url = new URL(candidate, baseUrl);
    if (!SUPPORTED_TAB_PROTOCOLS.has(url.protocol)) return null;
    if (url.protocol === "file:" && base.protocol !== "file:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function findWindowOpenNewTabUrl(calls, baseUrl) {
  for (const call of Array.isArray(calls) ? calls : []) {
    const target = String(call?.target ?? "_blank").trim().toLowerCase() || "_blank";
    if (SAME_CONTEXT_TARGETS.has(target)) continue;
    const url = resolveNewTabUrl(call?.url, baseUrl);
    if (url) return url;
  }
  return null;
}

export function selectNewlyOpenedTab(beforeTabIds, tabs, sourceTab) {
  const previousIds = beforeTabIds instanceof Set ? beforeTabIds : new Set(beforeTabIds);
  const newlyCreated = (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => Number.isInteger(tab?.id) && !previousIds.has(tab.id));
  const openerCandidates = newlyCreated.filter((tab) =>
    tab.openerTabId === sourceTab?.id);
  const candidates = openerCandidates.length
    ? openerCandidates
    : newlyCreated.length === 1
      ? newlyCreated
      : [];

  candidates.sort((left, right) => {
    const score = (tab) =>
      (tab.openerTabId === sourceTab?.id ? 8 : 0)
      + (tab.windowId === sourceTab?.windowId ? 4 : 0)
      + (tab.active ? 2 : 0)
      + (String(tab.pendingUrl || tab.url || "").trim() ? 1 : 0);
    return score(right) - score(left);
  });

  return candidates[0] || null;
}
