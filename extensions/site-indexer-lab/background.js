import {
  actionSafety,
  canonicalizePageUrl,
  hashText,
  INDEX_STORAGE_KEY,
  normalizeScanUrl,
  normalizeText,
  queueFingerprint,
  RUN_STORAGE_KEY,
  sameSiteOrigin,
  stateFingerprint,
} from "./core.js";

const MESSAGE_SCOPE = "site-capability-indexer-lab";
const DASHBOARD_URL = chrome.runtime.getURL("index.html");
const MAX_ERROR_RECORDS = 80;
const MAX_NOOP_SAMPLES = 30;
const NOOP_FAMILY_THRESHOLD = 3;
const RESULT_PERSIST_INTERVAL_MS = 2500;
const NAVIGATION_TIMEOUT_MS = 15000;
const CONTENT_READY_TIMEOUT_MS = 10000;
let activeRun = null;
let startPending = false;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeOptions(value = {}) {
  return {
    maxStates: clampInteger(value.maxStates, 5, 200, 40),
    maxDepth: clampInteger(value.maxDepth, 1, 6, 3),
    settleMs: clampInteger(value.settleMs, 250, 3000, 700),
    workerCount: clampInteger(value.workerCount, 1, 8, 4),
    keepTabOpen: value.keepTabOpen === true,
  };
}

function publicRunState(run = activeRun) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    startUrl: run.startUrl,
    origin: run.origin,
    currentUrl: run.currentUrl,
    currentAction: run.currentAction,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt || "",
    scannedStates: run.result?.screens?.length || 0,
    mappedTransitions: run.result?.transitions?.length || 0,
    queuedStates: run.queue?.length || 0,
    workerCount: run.options.workerCount,
    activeWorkers: run.activeWorkers || 0,
    noOpActions: run.result?.noOpActionCount || 0,
    prunedActions: run.result?.prunedActionCount || 0,
    maxStates: run.options.maxStates,
    errors: run.result?.errors?.slice(-8) || [],
  };
}

async function publishRunState() {
  const state = publicRunState();
  if (state) await chrome.storage.local.set({ [RUN_STORAGE_KEY]: state });
  void chrome.runtime.sendMessage({
    scope: MESSAGE_SCOPE,
    type: "run_update",
    state,
  }).catch(() => {});
}

async function updateRun(patch = {}) {
  if (!activeRun) return;
  Object.assign(activeRun, patch, { updatedAt: new Date().toISOString() });
  await publishRunState();
}

function recordRunError(message, context = "") {
  if (!activeRun) return;
  const error = {
    message: normalizeText(message, 500),
    context: normalizeText(context, 500),
    at: new Date().toISOString(),
  };
  activeRun.result.errors.push(error);
  if (activeRun.result.errors.length > MAX_ERROR_RECORDS) {
    activeRun.result.errors.splice(
      0,
      activeRun.result.errors.length - MAX_ERROR_RECORDS,
    );
  }
}

async function openDashboard() {
  const existing = await chrome.tabs.query({ url: DASHBOARD_URL });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: DASHBOARD_URL, active: true });
}

chrome.action.onClicked.addListener(() => {
  void openDashboard();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "site-indexer-dashboard") return;
  port.onMessage.addListener(() => {
    // Dashboard heartbeats keep this experimental long-running crawler alive.
  });
});

async function waitForContentReady(tabId, timeoutMs = CONTENT_READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        scope: MESSAGE_SCOPE,
        type: "ping",
      });
      if (response?.success) return chrome.tabs.get(tabId);
    } catch (error) {
      lastError = error;
    }
    await delay(80);
  }
  try {
    await ensureContentScript(tabId);
    return chrome.tabs.get(tabId);
  } catch (error) {
    lastError = error;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for the page DOM to become inspectable.");
}

async function navigateAndWaitForDom(tabId, navigate, timeoutMs = NAVIGATION_TIMEOUT_MS) {
  await new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.webNavigation.onDOMContentLoaded.removeListener(onDomContentLoaded);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(onSameDocumentNavigation);
      chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onSameDocumentNavigation);
      chrome.webNavigation.onErrorOccurred.removeListener(onNavigationError);
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDomContentLoaded = (details) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      finish();
    };
    const onSameDocumentNavigation = (details) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      finish();
    };
    const onNavigationError = (details) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      finish(new Error(details.error || "The page navigation failed."));
    };
    const timeoutId = setTimeout(() => {
      finish(new Error("Timed out waiting for the page DOM to load."));
    }, timeoutMs);
    chrome.webNavigation.onDOMContentLoaded.addListener(onDomContentLoaded);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDocumentNavigation);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDocumentNavigation);
    chrome.webNavigation.onErrorOccurred.addListener(onNavigationError);
    Promise.resolve()
      .then(navigate)
      .catch((error) => finish(error));
  });
}

async function waitForTabReady(tabId, settleMs) {
  await waitForContentReady(tabId);
  await delay(Math.min(settleMs, 120));
  return chrome.tabs.get(tabId);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      scope: MESSAGE_SCOPE,
      type: "ping",
    });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  }
}

async function sendContentCommand(tabId, message) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (attempt === 1) await ensureContentScript(tabId);
      const response = await chrome.tabs.sendMessage(tabId, {
        scope: MESSAGE_SCOPE,
        ...message,
      });
      if (!response?.success) {
        throw new Error(response?.error || "The page rejected the indexer command.");
      }
      return response;
    } catch (error) {
      lastError = error;
      await delay(180 * (attempt + 1));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The page could not be reached by the indexer.");
}

async function waitForDomQuiet(tabId, maxWait, quietWindowMs = 160) {
  const boundedMaxWait = Math.min(3000, Math.max(250, Number(maxWait) || 700));
  const startedAt = Date.now();
  while (Date.now() - startedAt < boundedMaxWait) {
    const state = await sendContentCommand(tabId, { type: "stability" });
    if (
      state.readyState !== "loading"
      && Number(state.quietForMs || 0) >= quietWindowMs
    ) {
      return state;
    }
    await delay(75);
  }
  return null;
}

async function trySoftNavigation(tabId, url, settleMs, timeoutMs = 1200) {
  const before = await chrome.tabs.get(tabId);
  if (!before.url || !sameSiteOrigin(before.url, url)) return null;
  let beforeUrl;
  try {
    beforeUrl = canonicalizePageUrl(before.url);
  } catch {
    return null;
  }
  const response = await sendContentCommand(tabId, {
    type: "navigate",
    destination: url,
  }).catch(() => null);
  if (!response?.clicked) return null;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const after = await chrome.tabs.get(tabId);
    try {
      if (canonicalizePageUrl(after.url) !== beforeUrl) {
        await delay(60);
        await waitForContentReady(tabId);
        await waitForDomQuiet(tabId, settleMs);
        return chrome.tabs.get(tabId);
      }
    } catch {
      // The worker may briefly expose an internal URL during navigation.
    }
    await delay(60);
  }
  return null;
}

async function navigateTab(tabId, url, settleMs) {
  const current = await chrome.tabs.get(tabId);
  let isSamePage = false;
  try {
    isSamePage = canonicalizePageUrl(current.url) === canonicalizePageUrl(url);
  } catch {
    // Fresh workers start at about:blank and need a normal navigation.
  }
  if (!isSamePage) {
    const softlyNavigated = await trySoftNavigation(tabId, url, settleMs);
    if (softlyNavigated) return softlyNavigated;
    const latest = await chrome.tabs.get(tabId);
    try {
      if (canonicalizePageUrl(latest.url) === canonicalizePageUrl(url)) {
        await waitForContentReady(tabId);
        await waitForDomQuiet(tabId, settleMs);
        return chrome.tabs.get(tabId);
      }
    } catch {
      // Fall through to a normal navigation.
    }
  }
  await navigateAndWaitForDom(tabId, () => (
    isSamePage
      ? chrome.tabs.reload(tabId)
      : chrome.tabs.update(tabId, { url })
  ));
  await waitForContentReady(tabId);
  await waitForDomQuiet(tabId, settleMs).catch(async () => {
    await delay(Math.min(settleMs, 350));
  });
  return chrome.tabs.get(tabId);
}

async function clickIndexedAction(tabId, action, settleMs) {
  const response = await sendContentCommand(tabId, {
    type: "click",
    action,
  });
  await delay(60);
  let after = await chrome.tabs.get(tabId);
  if (after.status !== "complete") {
    after = await waitForTabReady(tabId, settleMs);
  }
  await waitForDomQuiet(tabId, settleMs).catch(async () => {
    await delay(Math.min(settleMs, 350));
  });
  after = await chrome.tabs.get(tabId);
  return { ...response, tab: after };
}

async function scanTab(tabId) {
  const response = await sendContentCommand(tabId, { type: "scan" });
  return response.snapshot;
}

function routeLabel(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") return parsed.pathname || parsed.href;
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
}

function stateTitle(snapshot) {
  const dialog = snapshot.dialogs?.[0];
  const heading = snapshot.headings?.[0]?.text;
  return normalizeText(
    dialog ? `${snapshot.title} — ${dialog}` : snapshot.title || heading || routeLabel(snapshot.url),
  );
}

function semanticActionKey(action, policy) {
  return [
    policy.category,
    normalizeText(action.role, 50).toLowerCase(),
    normalizeText(action.name, 160).toLowerCase(),
    policy.destination || "",
    action.type || "",
  ].join("|");
}

function actionFamily(action, policy) {
  return `family-${hashText([
    policy.category,
    action.role || "",
    action.tag || "",
    typeof action.expanded === "boolean" ? "expandable" : "static",
    action.hasPopup ? "popup" : "",
    action.type || "",
  ].join("|"))}`;
}

function classifyActions(snapshot, rootUrl) {
  const results = [];
  const seen = new Set();
  let blockedActionCount = 0;
  for (const action of snapshot.actions || []) {
    const policy = actionSafety(action, rootUrl);
    if (!policy.safe) {
      blockedActionCount += 1;
      continue;
    }
    const semanticKey = semanticActionKey(action, policy);
    if (seen.has(semanticKey)) continue;
    seen.add(semanticKey);
    results.push({
      ...action,
      ...policy,
      semanticKey,
      family: actionFamily(action, policy),
    });
  }
  return { safeActions: results, blockedActionCount };
}

function screenRecord(snapshot, item, ordinal, classification) {
  const { safeActions, blockedActionCount } = classification;
  return {
    id: `screen-${String(ordinal).padStart(3, "0")}`,
    fingerprint: stateFingerprint(snapshot),
    url: canonicalizePageUrl(snapshot.url),
    route: routeLabel(snapshot.url),
    title: stateTitle(snapshot),
    depth: item.depth,
    discoveredVia: item.discoveredVia || "Start URL",
    headings: snapshot.headings || [],
    landmarks: snapshot.landmarks || [],
    dialogs: snapshot.dialogs || [],
    forms: snapshot.forms || [],
    selectedStates: snapshot.stateSignals?.selected || [],
    expandedStates: snapshot.stateSignals?.expanded || [],
    tableHeaders: snapshot.stateSignals?.tableHeaders || [],
    safeActions: safeActions.map((action) => ({
      key: action.key,
      semanticKey: action.semanticKey,
      family: action.family,
      name: action.name,
      role: action.role,
      category: action.category,
      reason: action.reason,
      destination: action.destination || "",
    })),
    blockedActionCount,
    stats: snapshot.stats || {},
    indexedAt: new Date().toISOString(),
  };
}

function enqueue(run, item) {
  if (run.queue.length >= run.options.maxStates * 12) return false;
  const key = queueFingerprint(item);
  if (run.queuedKeys.has(key)) return false;
  run.queuedKeys.add(key);
  run.queue.push({ ...item, queueKey: key });
  return true;
}

function actionPruneKey(item) {
  if (!item.parentStateId || !item.actionFamily) return "";
  return `${item.parentStateId}|${item.actionFamily}`;
}

function recordNoOpAction(run, item) {
  run.result.noOpActionCount += 1;
  const pruneKey = actionPruneKey(item);
  if (pruneKey) {
    const count = (run.noOpFamilyCounts.get(pruneKey) || 0) + 1;
    run.noOpFamilyCounts.set(pruneKey, count);
    if (count >= NOOP_FAMILY_THRESHOLD) run.prunedFamilies.add(pruneKey);
  }
  if (run.result.noOpSamples.length >= MAX_NOOP_SAMPLES) return;
  run.result.noOpSamples.push({
    screen: item.parentStateId,
    action: normalizeText(item.discoveredVia, 160),
    family: item.actionFamily || "",
  });
}

function takeNextQueueItem(run) {
  while (run.queue.length) {
    const item = run.queue.shift();
    const pruneKey = actionPruneKey(item);
    if (pruneKey && run.prunedFamilies.has(pruneKey)) {
      run.result.prunedActionCount += 1;
      continue;
    }
    return item;
  }
  return null;
}

function transitionRecord(item, targetId) {
  if (!item.parentStateId) return null;
  return {
    from: item.parentStateId,
    to: targetId,
    action: item.discoveredVia || "Navigate",
    category: item.transitionCategory || "navigation",
  };
}

function addTransition(result, transition) {
  if (!transition) return;
  const duplicate = result.transitions.some((item) => (
    item.from === transition.from
    && item.to === transition.to
    && item.action === transition.action
  ));
  if (!duplicate) result.transitions.push(transition);
}

async function restoreQueueState(run, worker, item) {
  let tab = await navigateTab(worker.tabId, item.baseUrl, run.options.settleMs);
  if (!sameSiteOrigin(tab.url, run.startUrl)) {
    throw new Error("Navigation left the indexed website origin.");
  }
  for (const action of item.actionPath) {
    if (run.cancelled) throw new DOMException("Index build stopped.", "AbortError");
    worker.currentAction = `Replaying: ${action.name}`;
    worker.currentUrl = tab.url;
    const clicked = await clickIndexedAction(
      worker.tabId,
      action,
      run.options.settleMs,
    );
    tab = clicked.tab;
    if (!sameSiteOrigin(tab.url, run.startUrl)) {
      throw new Error(`Skipped a transition outside ${run.origin}.`);
    }
  }
  return tab;
}

function expandState(run, item, screen, safeActions) {
  if (item.depth >= run.options.maxDepth) return;
  for (const action of safeActions) {
    if (action.category === "navigation" && action.destination) {
      enqueue(run, {
        baseUrl: action.destination,
        actionPath: [],
        depth: item.depth + 1,
        parentStateId: screen.id,
        discoveredVia: action.name,
        transitionCategory: action.category,
        actionFamily: "",
      });
      continue;
    }
    enqueue(run, {
      baseUrl: item.baseUrl,
      actionPath: [...item.actionPath, {
        key: action.key,
        selector: action.selector,
        tag: action.tag,
        role: action.role,
        name: action.name,
        type: action.type,
        formAction: action.formAction,
        download: action.download,
      }],
      depth: item.depth + 1,
      parentStateId: screen.id,
      discoveredVia: action.name,
      transitionCategory: action.category,
      actionFamily: action.family,
    });
  }
}

async function createWorkerPool(workerCount) {
  const workers = [];
  try {
    for (let index = 0; index < workerCount; index += 1) {
      const tab = await chrome.tabs.create({
        url: "about:blank",
        active: false,
      });
      if (!tab.id) throw new Error("Chrome did not create an indexer worker tab.");
      await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
      workers.push({
        id: `worker-${index + 1}`,
        tabId: tab.id,
        busy: false,
        currentAction: "Waiting for work",
        currentUrl: "",
      });
    }
  } catch (error) {
    const tabIds = workers.map((worker) => worker.tabId);
    if (tabIds.length) await chrome.tabs.remove(tabIds).catch(() => {});
    throw error;
  }

  let groupId = chrome.tabGroups.TAB_GROUP_ID_NONE;
  if (workers.length > 1) {
    try {
      groupId = await chrome.tabs.group({
        tabIds: workers.map((worker) => worker.tabId),
      });
      await chrome.tabGroups.update(groupId, {
        title: `Site Indexer · ${workers.length} workers`,
        color: "green",
        collapsed: true,
      });
    } catch {
      groupId = chrome.tabGroups.TAB_GROUP_ID_NONE;
    }
  }
  return { workers, groupId };
}

async function releaseWorkerPool(pool, keepTabsOpen) {
  await Promise.all(pool.workers.map((worker) => (
    chrome.tabs.update(worker.tabId, { autoDiscardable: true }).catch(() => {})
  )));
  if (keepTabsOpen) {
    if (pool.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      await chrome.tabGroups.update(pool.groupId, {
        title: `Site Indexer · ${pool.workers.length} completed`,
      }).catch(() => {});
    }
    return;
  }
  const tabIds = pool.workers.map((worker) => worker.tabId);
  if (tabIds.length) await chrome.tabs.remove(tabIds).catch(() => {});
}

async function processQueueItem(run, worker, item) {
  const jobStartedAt = Date.now();
  worker.busy = true;
  worker.currentAction = item.discoveredVia || "Scanning page";
  worker.currentUrl = item.baseUrl;
  try {
    if (run.cancelled) throw new DOMException("Index build stopped.", "AbortError");
    const tab = await restoreQueueState(run, worker, item);
    if (run.cancelled) throw new DOMException("Index build stopped.", "AbortError");
    const snapshot = await scanTab(worker.tabId);
    snapshot.url = tab.url || snapshot.url;
    if (!sameSiteOrigin(snapshot.url, run.startUrl)) {
      throw new Error(`Skipped a state outside ${run.origin}.`);
    }

    const fingerprint = stateFingerprint(snapshot);
    const existingId = run.visitedStates.get(fingerprint);
    if (existingId) {
      if (item.parentStateId && existingId === item.parentStateId) {
        recordNoOpAction(run, item);
      } else {
        addTransition(run.result, transitionRecord(item, existingId));
      }
      return;
    }
    if (run.result.screens.length >= run.options.maxStates) return;

    const classification = classifyActions(snapshot, run.startUrl);
    const screen = screenRecord(
      snapshot,
      item,
      run.result.screens.length + 1,
      classification,
    );
    screen.workerId = worker.id;
    screen.scanDurationMs = Math.max(0, Date.now() - jobStartedAt);
    run.result.screens.push(screen);
    run.result.siteTitle = run.result.screens[0]?.title || run.result.siteTitle;
    run.visitedStates.set(fingerprint, screen.id);
    addTransition(run.result, transitionRecord(item, screen.id));
    expandState(run, item, screen, classification.safeActions);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      recordRunError(
        error instanceof Error ? error.message : "Could not inspect this state.",
        item.discoveredVia || item.baseUrl,
      );
    }
  } finally {
    const durationMs = Math.max(0, Date.now() - jobStartedAt);
    run.result.processedJobCount += 1;
    run.result.totalJobDurationMs += durationMs;
    worker.busy = false;
    worker.currentAction = "Waiting for work";
    worker.currentUrl = "";
  }
}

async function runWorkStealingScheduler(run, normalizedUrl) {
  const availableWorkers = [...run.workers];
  const activeJobs = new Map();

  const dispatchAvailableWork = () => {
    while (
      availableWorkers.length
      && run.queue.length
      && run.result.screens.length < run.options.maxStates
      && !run.cancelled
    ) {
      const item = takeNextQueueItem(run);
      if (!item) break;
      const worker = availableWorkers.shift();
      const promise = processQueueItem(run, worker, item)
        .then(() => ({ worker }));
      activeJobs.set(worker.id, promise);
    }
    run.activeWorkers = activeJobs.size;
    const representative = run.workers.find((worker) => worker.busy);
    run.currentAction = activeJobs.size
      ? `${activeJobs.size}/${run.options.workerCount} workers scanning continuously`
      : "Waiting for work";
    run.currentUrl = representative?.currentUrl || normalizedUrl;
    run.updatedAt = new Date().toISOString();
  };

  dispatchAvailableWork();
  await publishRunState();

  while (activeJobs.size) {
    const { worker } = await Promise.race(activeJobs.values());
    activeJobs.delete(worker.id);
    availableWorkers.push(worker);

    // Refill all free slots before storage/UI work. A fast worker therefore
    // never waits for the slowest page from its previous batch.
    dispatchAvailableWork();
    run.result.updatedAt = new Date().toISOString();
    run.updatedAt = run.result.updatedAt;
    await persistResult(run);
    await publishRunState();
  }

  run.activeWorkers = 0;
}

async function persistResult(run, force = false) {
  const now = Date.now();
  if (
    !force
    && now - run.lastResultPersistAt < RESULT_PERSIST_INTERVAL_MS
  ) {
    return;
  }
  run.lastResultPersistAt = now;
  await chrome.storage.local.set({ [INDEX_STORAGE_KEY]: run.result });
}

async function runIndexer(startUrl, options) {
  const normalizedUrl = normalizeScanUrl(startUrl);
  const parsed = new URL(normalizedUrl);
  const result = {
    schemaVersion: 3,
    buildMode: "deterministic-code-only",
    startUrl: normalizedUrl,
    origin: parsed.protocol === "file:" ? "file://" : parsed.origin,
    siteTitle: parsed.hostname || "Local website",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: "",
    stoppedEarly: false,
    workerCount: options.workerCount,
    noOpActionCount: 0,
    prunedActionCount: 0,
    processedJobCount: 0,
    totalJobDurationMs: 0,
    noOpSamples: [],
    screens: [],
    transitions: [],
    errors: [],
  };
  const workerPool = await createWorkerPool(options.workerCount);

  const run = {
    id: crypto.randomUUID(),
    status: "running",
    startUrl: normalizedUrl,
    origin: result.origin,
    currentUrl: normalizedUrl,
    currentAction: "Opening start page",
    startedAt: result.startedAt,
    updatedAt: result.startedAt,
    completedAt: "",
    cancelled: false,
    options,
    workers: workerPool.workers,
    activeWorkers: 0,
    queue: [],
    queuedKeys: new Set(),
    visitedStates: new Map(),
    noOpFamilyCounts: new Map(),
    prunedFamilies: new Set(),
    lastResultPersistAt: 0,
    result,
  };
  activeRun = run;
  enqueue(run, {
    baseUrl: normalizedUrl,
    actionPath: [],
    depth: 0,
    parentStateId: "",
    discoveredVia: "Start URL",
    transitionCategory: "navigation",
  });

  try {
    await publishRunState();
    await runWorkStealingScheduler(run, normalizedUrl);
    result.stoppedEarly = run.cancelled
      || Boolean(run.queue.length && result.screens.length >= options.maxStates);
    result.completedAt = new Date().toISOString();
    result.updatedAt = result.completedAt;
    run.status = run.cancelled ? "stopped" : "completed";
    run.currentAction = run.cancelled
      ? "Index build stopped"
      : result.stoppedEarly ? "Index limit reached" : "Index build complete";
    run.completedAt = result.completedAt;
    await persistResult(run, true);
    await chrome.storage.local.set({
      [RUN_STORAGE_KEY]: publicRunState(run),
    });
    await publishRunState();
  } catch (error) {
    recordRunError(error instanceof Error ? error.message : "Index build failed.");
    result.completedAt = new Date().toISOString();
    result.updatedAt = result.completedAt;
    run.status = "error";
    run.currentAction = "Index build failed";
    run.completedAt = result.completedAt;
    await persistResult(run, true);
    await chrome.storage.local.set({
      [RUN_STORAGE_KEY]: publicRunState(run),
    });
    await publishRunState();
  } finally {
    run.activeWorkers = 0;
    await releaseWorkerPool(workerPool, options.keepTabOpen);
  }
}

async function startIndexer(message) {
  if (startPending || activeRun?.status === "running") {
    throw new Error("An index build is already running.");
  }
  const startUrl = normalizeScanUrl(message.url);
  const options = normalizeOptions(message.options);
  startPending = true;
  void runIndexer(startUrl, options)
    .catch(async (error) => {
      await chrome.storage.local.set({
        [RUN_STORAGE_KEY]: {
          id: crypto.randomUUID(),
          status: "error",
          startUrl,
          origin: new URL(startUrl).origin,
          currentUrl: startUrl,
          currentAction: error instanceof Error ? error.message : "Index build failed.",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          scannedStates: 0,
          mappedTransitions: 0,
          queuedStates: 0,
          workerCount: options.workerCount,
          activeWorkers: 0,
          maxStates: options.maxStates,
          errors: [],
        },
      });
    })
    .finally(() => {
      startPending = false;
    });
  return { started: true };
}

async function stopIndexer() {
  if (!activeRun || activeRun.status !== "running") return { stopped: false };
  activeRun.cancelled = true;
  await updateRun({ currentAction: "Stopping after the current page…" });
  return { stopped: true };
}

async function clearIndex() {
  if (activeRun?.status === "running") {
    throw new Error("Stop the current index build before clearing its data.");
  }
  await chrome.storage.local.remove([INDEX_STORAGE_KEY, RUN_STORAGE_KEY]);
  activeRun = null;
  return { cleared: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.scope !== MESSAGE_SCOPE) return false;
  const operation = (() => {
    if (message.type === "start") return startIndexer(message);
    if (message.type === "stop") return stopIndexer();
    if (message.type === "clear") return clearIndex();
    if (message.type === "status") {
      return Promise.resolve({ state: publicRunState() });
    }
    return Promise.reject(new Error("Unsupported indexer command."));
  })();
  operation
    .then((result) => sendResponse({ success: true, ...result }))
    .catch((error) => sendResponse({
      success: false,
      error: error instanceof Error ? error.message : "Indexer command failed.",
    }));
  return true;
});

void chrome.storage.local.get(RUN_STORAGE_KEY).then(async (stored) => {
  const previousRun = stored[RUN_STORAGE_KEY];
  if (activeRun || startPending || previousRun?.status !== "running") return;
  const interruptedAt = new Date().toISOString();
  await chrome.storage.local.set({
    [RUN_STORAGE_KEY]: {
      ...previousRun,
      status: "stopped",
      currentAction: "Index build was interrupted. Keep the dashboard open and start again.",
      updatedAt: interruptedAt,
      completedAt: interruptedAt,
    },
  });
});
