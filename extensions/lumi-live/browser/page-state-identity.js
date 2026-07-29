function boundedToken(value, fallback) {
  const token = String(value || "")
    .replace(/[^a-z0-9_-]+/gi, "")
    .slice(0, 80);
  return token || fallback;
}

function createDocumentToken(randomUUID) {
  try {
    return boundedToken(randomUUID?.(), `doc-${Date.now().toString(36)}`);
  } catch {
    return `doc-${Date.now().toString(36)}`;
  }
}

const OWNED_VISUAL_SELECTOR = [
  "#playwright-highlight-container",
  "#page-agent-runtime_simulator-mask",
  "#lumi-stage-progress",
  "#lumi-stage-progress-style",
  "#lumi-page-agent-highlight-preference",
  "#lumi-page-agent-click-effect-preference",
].join(", ");

function isOwnedVisualNode(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!element) return false;
  try {
    return element.matches?.(OWNED_VISUAL_SELECTOR)
      || Boolean(element.closest?.(OWNED_VISUAL_SELECTOR));
  } catch {
    return false;
  }
}

function affectsSemanticState(record) {
  if (!record) return false;
  if (isOwnedVisualNode(record.target)) return false;
  if (record.type !== "childList") return true;
  const changedNodes = [
    ...Array.from(record.addedNodes || []),
    ...Array.from(record.removedNodes || []),
  ];
  return changedNodes.length === 0
    || changedNodes.some((node) => !isOwnedVisualNode(node));
}

export function createPageStateTracker({
  documentRef = globalThis.document,
  locationRef = globalThis.location,
  MutationObserverClass = globalThis.MutationObserver,
  randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
} = {}) {
  const documentId = createDocumentToken(randomUUID);
  let observationSequence = 0;
  let domRevision = 0;
  let latestState = null;
  let disposed = false;

  const observer = documentRef?.documentElement && MutationObserverClass
    ? new MutationObserverClass((records = []) => {
        if (records.some(affectsSemanticState)) {
          domRevision += 1;
        }
      })
    : null;
  observer?.observe?.(documentRef.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "aria-checked",
      "aria-disabled",
      "aria-expanded",
      "aria-pressed",
      "aria-selected",
      "checked",
      "disabled",
      "hidden",
      "selected",
    ],
  });

  function currentUrl() {
    return String(locationRef?.href || documentRef?.URL || "");
  }

  function observe() {
    if (disposed) throw new Error("The Lumi page-state tracker has been disposed.");
    observationSequence += 1;
    latestState = Object.freeze({
      stateId: `${documentId}:${observationSequence}:${domRevision}`,
      documentId,
      observationSequence,
      domRevision,
      url: currentUrl(),
    });
    return latestState;
  }

  function assertFresh(expectedStateId, { required = false } = {}) {
    const expected = String(expectedStateId || "").trim();
    if (!expected) {
      if (required) {
        throw new Error(
          "This stage requires stateId from the latest browser_get_page_state or browser_find_semantic_context result.",
        );
      }
      return latestState;
    }
    if (!latestState || expected !== latestState.stateId) {
      throw new Error(
        "The requested stage targets stale page state. Observe the page again and rebuild the remaining stage with the new stateId.",
      );
    }
    if (latestState.url !== currentUrl()) {
      throw new Error(
        "The page URL changed after the last observation. Observe fresh page state before another indexed action.",
      );
    }
    if (latestState.domRevision !== domRevision) {
      throw new Error(
        "The semantic DOM changed after the last observation. Observe fresh page state and rebuild the remaining indexed actions.",
      );
    }
    return latestState;
  }

  function assertDocumentStable(startState, remainingElements = []) {
    if (!startState || startState.documentId !== documentId || startState.url !== currentUrl()) {
      throw new Error("The page changed while the stage was running.");
    }
    const disconnected = remainingElements.find((element) => element && !element.isConnected);
    if (disconnected) {
      throw new Error("The page replaced a remaining control while the stage was running.");
    }
    return true;
  }

  function invalidate() {
    latestState = null;
  }

  function dispose() {
    disposed = true;
    latestState = null;
    observer?.disconnect?.();
  }

  return Object.freeze({
    assertDocumentStable,
    assertFresh,
    dispose,
    invalidate,
    observe,
    get current() {
      return latestState;
    },
    get documentId() {
      return documentId;
    },
    get domRevision() {
      return domRevision;
    },
  });
}
