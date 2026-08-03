import { createMcpService } from "./mcp-service.js";
import {
  extractActiveContextIdentifiers,
  sanitizeActiveContextUrl,
} from "../core/active-tab-context.js";
import { EXTENSION_EVENTS, STORAGE_KEYS } from "../core/extension-config.js";
import { normalizeVisualPreferences } from "../core/visual-preferences.js";
import { saveCapturedTabAsset } from "./captured-tab-assets.js";
import { createFastWorkspace } from "./fast-workspace.js";
import { createSidePanelLifecycle } from "./side-panel-lifecycle.js";
import {
  collectWindowOpenCallsInPage,
  findWindowOpenNewTabUrl,
  installWindowOpenProbeInPage,
  resolveNewTabUrl,
  selectNewlyOpenedTab,
  watchForNewTabCreation,
} from "../browser/new-tab-navigation.js";
import {
  isFileChooserDebuggerEvent,
  localFileName,
  normalizeUploadFilePaths,
} from "../browser/file-upload.js";
import { createRecordedFlowService } from "./recorded-flow-service.js";
import { createVideoAnalysisService } from "./video-analysis-service.js";

const MESSAGE_TYPE = EXTENSION_EVENTS.request;
const CONTENT_REQUEST_SOURCE = "lumi-page-agent-service";
const TARGET_STORAGE_KEY = STORAGE_KEYS.targetTabId;
const TARGET_CHANGED_MESSAGE = EXTENSION_EVENTS.targetChanged;
const PANEL_LIFECYCLE_MESSAGE = EXTENSION_EVENTS.lifecycle;
const ELEMENT_HIGHLIGHTS_STORAGE_KEY = STORAGE_KEYS.elementHighlights;
const FAST_MODE_STORAGE_KEY = STORAGE_KEYS.fastMode;
const FAST_WORKSPACE_STORAGE_KEY = STORAGE_KEYS.fastWorkspaceGroupId;
const OFFSCREEN_DOCUMENT_PATH = "offscreen/index.html";
const OFFSCREEN_TARGET = "lumi_live_offscreen";
const TAB_TRANSITION_FALLBACK_URL = "https://www.google.com/";
const TAB_CAPTURE_RETRY_DELAY_MS = 550;
const WINDOW_OPEN_PROBE_KEY = "__LUMI_WINDOW_OPEN_PROBE__";
const CLICK_NEW_TAB_WATCH_MS = 2500;
const FILE_CHOOSER_WAIT_MS = 10000;
const RECORDED_FLOWS_STORAGE_KEY = STORAGE_KEYS.recordedFlows;
const RECORDED_FLOW_DRAFT_STORAGE_KEY = STORAGE_KEYS.recordedFlowDraft;

let connectedTabId = null;
let fastModeEnabled = false;
let fastPromptTargetTabId = null;
let fastLastActiveWorkspaceTabId = null;
let listedTabIds = new Set();
let listedTabsExpireAt = 0;
let activeBrowserAction = null;
let creatingOffscreenDocument = null;
const {
  addMcpServer,
  callMcpTool,
  cancelActiveMcpCalls,
  connectMcpConnector,
  disableMcpTool,
  enableMcpTool,
  getConfiguredMcps,
  listMcpServers,
  reconnectMcpServer,
  removeMcpServer,
  setMcpServerEnabled,
  setMcpServerToolPolicy,
  setMcpToolPolicy,
} = createMcpService();
const fastWorkspace = createFastWorkspace({ storageKey: FAST_WORKSPACE_STORAGE_KEY });
const recordedFlows = createRecordedFlowService({
  localStorageArea: chrome.storage.local,
  sessionStorageArea: chrome.storage.session,
  flowsStorageKey: RECORDED_FLOWS_STORAGE_KEY,
  draftStorageKey: RECORDED_FLOW_DRAFT_STORAGE_KEY,
});
const videoAnalysis = createVideoAnalysisService({
  chromeApi: chrome,
  storageKey: STORAGE_KEYS.videoAnalyses,
  getTargetTab: async () => {
    const activeTab = await getActiveTab();
    if (activeTab?.id && /^https?:\/\//i.test(activeTab.url || "")) return activeTab;
    const status = await getStatus();
    if (!status.connected || !Number.isInteger(status.tabId)) return null;
    return chrome.tabs.get(status.tabId).catch(() => null);
  },
});

async function loadTarget() {
  const stored = await chrome.storage.session.get(TARGET_STORAGE_KEY);
  connectedTabId = Number.isInteger(stored[TARGET_STORAGE_KEY])
    ? stored[TARGET_STORAGE_KEY]
    : null;
}

async function loadBackgroundState() {
  const [, stored] = await Promise.all([
    Promise.all([loadTarget(), fastWorkspace.initialize(), recordedFlows.initialize()]),
    chrome.storage.local.get(FAST_MODE_STORAGE_KEY),
  ]);
  fastModeEnabled = normalizeVisualPreferences({
    fastMode: stored[FAST_MODE_STORAGE_KEY],
  }).fastMode;
}

function broadcastFlowRecordingChanged(draft = recordedFlows.snapshot()) {
  void recordedFlows.list().then((flows) => chrome.runtime.sendMessage({
    type: EXTENSION_EVENTS.flowRecordingChanged,
    draft,
    flows,
  })).catch(() => {});
}

async function startFlowRecording() {
  let tab = connectedTabId
    ? await chrome.tabs.get(connectedTabId).catch(() => null)
    : await getActiveTab();
  if (!tab?.id || !isControllablePage(tab.url)) tab = await getActiveTab();
  if (!tab?.id || !isControllablePage(tab.url)) {
    throw new Error("Open an http, https, or permitted file page before recording a flow.");
  }
  if (!await ensureController(tab.id, 5)) {
    throw new Error("Lumi could not prepare the active page for action recording.");
  }
  const sessionId = crypto.randomUUID();
  const draft = await recordedFlows.start({
    sessionId,
    tabId: tab.id,
    startUrl: sanitizeActiveContextUrl(tab.url || ""),
    startTitle: tab.title || "",
  });
  try {
    const result = await sendControllerBridge(tab.id, "bridge_flow_record_start", { sessionId });
    if (result?.success === false) {
      throw new Error(result.error || "The page action recorder could not start.");
    }
  } catch (error) {
    await recordedFlows.clearDraft();
    throw error;
  }
  broadcastFlowRecordingChanged(draft);
  return { draft, tab: serializeTab(tab) };
}

async function stopFlowRecording() {
  const draft = recordedFlows.snapshot();
  if (!draft) return { draft: null };
  if (draft.recording && Number.isInteger(draft.tabId)) {
    await sendControllerBridge(draft.tabId, "bridge_flow_record_stop").catch(() => null);
  }
  const stopped = await recordedFlows.stop();
  broadcastFlowRecordingChanged(stopped);
  return { draft: stopped };
}

async function resumeFlowRecording(tabId) {
  if (!recordedFlows.isRecordingTab(tabId)) return;
  const sessionId = recordedFlows.sessionId();
  if (!sessionId) return;
  await sendControllerBridge(tabId, "bridge_flow_record_start", { sessionId }).catch(() => null);
}

async function handleRecordedFlowStep(message, sender) {
  const tabId = sender.tab?.id;
  if (
    !Number.isInteger(tabId)
    || !recordedFlows.isRecordingTab(tabId)
    || message.sessionId !== recordedFlows.sessionId()
  ) return;
  const draft = await recordedFlows.append(message.step);
  broadcastFlowRecordingChanged(draft);
}

const ready = loadBackgroundState();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Process active-video audio and play the translated speech.",
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function sendOffscreenCommand(command, payload = {}, create = false) {
  if (create) await ensureOffscreenDocument();
  else if (!await hasOffscreenDocument()) {
    if (command === "translation_status") {
      return { prepared: false, state: "off", targetLanguageCode: "", source: null };
    }
    throw new Error("Video audio is not prepared. Activate a web tab with a playing video and try again.");
  }
  const response = await chrome.runtime.sendMessage({
    target: OFFSCREEN_TARGET,
    command,
    ...payload,
  });
  if (!response?.ok) throw new Error(response?.error || "The offscreen tab-audio runtime did not respond.");
  return response.result;
}

async function releaseTranslationCapture(expectedTabId = null) {
  const status = await sendOffscreenCommand("translation_status");
  if (!status.source?.tabId) return status;
  if (Number.isInteger(expectedTabId) && status.source.tabId !== expectedTabId) return status;
  if (status.source.mode === "mediaElement") {
    await sendControllerBridge(status.source.tabId, "bridge_stop_media_element_audio").catch(() => null);
  }
  return sendOffscreenCommand("release_capture", { expectedTabId: status.source.tabId });
}

async function releaseCaptureForDifferentTab(tabId) {
  const status = await sendOffscreenCommand("translation_status");
  if (status.source?.mode === "sharedTab") return status;
  if (!status.source?.tabId || status.source.tabId === tabId) return status;
  return releaseTranslationCapture(status.source.tabId);
}

async function prepareDirectMediaElementAudio(tab) {
  const controllerReady = await ensureController(tab.id, 4);
  if (!controllerReady) throw new Error("PageAgent could not prepare the active video page.");
  const prepared = await sendControllerBridge(tab.id, "bridge_prepare_media_element_audio");
  if (prepared?.success === false) {
    throw new Error(prepared.error || prepared.message || "The active video element could not expose audio.");
  }
  try {
    return await sendOffscreenCommand("prepare_external_capture", {
      tabId: tab.id,
      title: tab.title || "Active video tab",
      url: sanitizeActiveContextUrl(tab.url || ""),
    }, true);
  } catch (error) {
    await sendControllerBridge(tab.id, "bridge_stop_media_element_audio").catch(() => null);
    throw error;
  }
}

async function startPreparedTranslation(status, tab, message) {
  let result;
  try {
    result = await sendOffscreenCommand("start_translation", {
      apiKey: message.apiKey,
      targetLanguageCode: message.targetLanguageCode,
    });
    if (status.source?.mode === "mediaElement") {
      const started = await sendControllerBridge(tab.id, "bridge_start_media_element_audio");
      if (started?.success === false) {
        const detail = started.error || started.message || "Direct video audio capture could not start.";
        throw new Error(`${detail} Keep the video tab active and try Live Translate again.`);
      }
      result = {
        ...result,
        sourcePlaybackVolume: started.sourcePlaybackVolume ?? 0.06,
        captureMode: "mediaElement",
      };
    }
    return result;
  } catch (error) {
    if (status.source?.mode === "mediaElement") await releaseTranslationCapture(tab.id).catch(() => {});
    throw error;
  }
}

const hasNativeSidePanelCloseEvents = Boolean(chrome.sidePanel.onClosed?.addListener);
const sidePanelLifecycle = createSidePanelLifecycle({
  nativeCloseEvents: hasNativeSidePanelCloseEvents,
  async onClosed({ isCurrent }) {
    await ready;
    if (!isCurrent()) return;
    await chrome.runtime.sendMessage({
      type: PANEL_LIFECYCLE_MESSAGE,
      state: "closed",
    }).catch(() => {});
    if (!isCurrent()) return;
    await releaseTranslationCapture().catch(() => {});
    if (!isCurrent()) return;
    if (fastModeEnabled) {
      fastPromptTargetTabId = null;
      fastLastActiveWorkspaceTabId = null;
    }
    await fastWorkspace.release({ shouldRelease: isCurrent });
    if (!isCurrent()) return;
    if (fastModeEnabled) await setConnectedTab(null);
    notifyTargetChanged();
  },
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "lumi_live_side_panel") return;
  sidePanelLifecycle.connect(port);
});

if (hasNativeSidePanelCloseEvents) {
  chrome.sidePanel.onOpened?.addListener(() => {
    void sidePanelLifecycle.nativeOpened();
  });
  chrome.sidePanel.onClosed.addListener(() => {
    sidePanelLifecycle.nativeClosed();
  });
}

function isWebPage(url = "") {
  return /^https?:\/\//i.test(url);
}

function isFilePage(url = "") {
  return /^file:\/\//i.test(url);
}

function isControllablePage(url = "") {
  return isWebPage(url) || isFilePage(url);
}

function isCapturableTab(tab) {
  return Number.isInteger(tab?.id) && Boolean(String(tab.url || ""));
}

function notifyTargetChanged() {
  void chrome.runtime.sendMessage({ type: TARGET_CHANGED_MESSAGE }).catch(() => {});
}

async function setConnectedTab(tabId) {
  if (connectedTabId === tabId) return;
  if (connectedTabId && connectedTabId !== tabId) {
    await chrome.action.setBadgeText({ tabId: connectedTabId, text: "" }).catch(() => {});
  }
  connectedTabId = tabId;
  if (tabId === null) {
    await chrome.storage.session.remove(TARGET_STORAGE_KEY);
    notifyTargetChanged();
    return;
  }
  await chrome.storage.session.set({ [TARGET_STORAGE_KEY]: tabId });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#745bc4" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });
  notifyTargetChanged();
}

async function pingController(tabId) {
  return chrome.tabs.sendMessage(tabId, {
    source: CONTENT_REQUEST_SOURCE,
    tool: "bridge_controller_ping",
    args: {},
  }).then((result) => Boolean(result?.success)).catch(() => false);
}

async function getVisualPreferences() {
  const stored = await chrome.storage.local.get([
    ELEMENT_HIGHLIGHTS_STORAGE_KEY,
    FAST_MODE_STORAGE_KEY,
  ]);
  return normalizeVisualPreferences({
    showElementHighlights: stored[ELEMENT_HIGHLIGHTS_STORAGE_KEY] === true,
    fastMode: stored[FAST_MODE_STORAGE_KEY],
  });
}

async function applyControllerVisualPreferences(tabId, preferences) {
  const visualPreferences = preferences || await getVisualPreferences();
  return chrome.tabs.sendMessage(tabId, {
    source: CONTENT_REQUEST_SOURCE,
    tool: "bridge_set_visual_preferences",
    args: visualPreferences,
  }).then((result) => Boolean(result?.success)).catch(() => false);
}

async function ensureController(tabId, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await pingController(tabId)) {
      await applyControllerVisualPreferences(tabId);
      return true;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["dist/controller.js"],
      });
      if (await pingController(tabId)) {
        await applyControllerVisualPreferences(tabId);
        return true;
      }
    } catch {
      // Retry while a navigation is settling or report the page as unavailable.
    }
    await new Promise((resolve) => setTimeout(resolve, 180 + attempt * 220));
  }
  return false;
}

async function getActiveTab(windowId) {
  const query = Number.isInteger(windowId) && windowId !== chrome.windows.WINDOW_ID_NONE
    ? { active: true, windowId }
    : { active: true, lastFocusedWindow: true };
  const [tab] = await chrome.tabs.query(query);
  return tab || null;
}

async function resolveFastWorkspaceTarget() {
  const workspaceTabs = await fastWorkspace.listTabs();
  const preferredIds = [
    fastPromptTargetTabId,
    connectedTabId,
    fastLastActiveWorkspaceTabId,
  ].filter(Number.isInteger);
  const tab = preferredIds
    .map((tabId) => workspaceTabs.find((candidate) => candidate.id === tabId))
    .find((candidate) => isControllablePage(candidate?.url))
    || workspaceTabs.find((candidate) => isControllablePage(candidate?.url))
    || null;
  if (!tab?.id) {
    fastPromptTargetTabId = null;
    await setConnectedTab(null);
    return null;
  }
  await setConnectedTab(tab.id);
  const controllerReady = await ensureController(tab.id, 4);
  return { tab, controllerReady };
}

async function activateFastWorkspace(preferredTabId = null) {
  let tab = null;
  if (Number.isInteger(preferredTabId)) {
    tab = await chrome.tabs.get(preferredTabId).catch(() => null);
  }
  if (!tab || !isControllablePage(tab.url)) tab = await getActiveTab();
  if (!tab?.id || !isControllablePage(tab.url)) {
    const restored = await resolveFastWorkspaceTarget();
    if (restored) return restored;
    await setConnectedTab(null);
    return null;
  }
  await fastWorkspace.addTab(tab.id);
  fastPromptTargetTabId = tab.id;
  fastLastActiveWorkspaceTabId = tab.id;
  await setConnectedTab(tab.id);
  const controllerReady = await ensureController(tab.id, 4);
  return { tab: await chrome.tabs.get(tab.id), controllerReady };
}

async function restoreOrActivateFastWorkspace() {
  const existingGroup = await fastWorkspace.getGroup();
  if (existingGroup) return resolveFastWorkspaceTarget();

  // If Chrome discarded stale group metadata between panel documents, restore
  // the persisted agent target instead of adopting whichever unrelated tab
  // happens to be active when the panel initializes.
  if (Number.isInteger(connectedTabId)) {
    const persistedTarget = await chrome.tabs.get(connectedTabId).catch(() => null);
    if (persistedTarget?.id && isControllablePage(persistedTarget.url)) {
      return activateFastWorkspace(persistedTarget.id);
    }
  }
  return activateFastWorkspace();
}

async function applyFastModeEnabled(
  enabled,
  {
    preferredTabId = null,
    activateWorkspace = sidePanelLifecycle.isOpen,
  } = {},
) {
  fastModeEnabled = enabled === true;
  if (fastModeEnabled) {
    if (!activateWorkspace) {
      fastPromptTargetTabId = null;
      fastLastActiveWorkspaceTabId = null;
      await fastWorkspace.release();
      await setConnectedTab(null);
      notifyTargetChanged();
      return { target: null, workspace: fastWorkspace.state() };
    }
    const target = await activateFastWorkspace(preferredTabId);
    notifyTargetChanged();
    return { target, workspace: fastWorkspace.state() };
  }
  fastPromptTargetTabId = null;
  fastLastActiveWorkspaceTabId = null;
  await fastWorkspace.release();
  const target = await followActiveTab(undefined, { force: true });
  notifyTargetChanged();
  return { target, workspace: fastWorkspace.state() };
}

async function prepareBrowserPrompt() {
  await ready;
  if (!fastModeEnabled) {
    const target = await followActiveTab(undefined, { force: true });
    return {
      mode: "normal",
      target: target?.tab ? serializeTab(target.tab) : null,
    };
  }

  const activeTab = await getActiveTab();
  if (activeTab?.id && isControllablePage(activeTab.url)) {
    const workspaceGroup = await fastWorkspace.getGroup();
    const canJoinActiveWorkspace = !workspaceGroup
      || workspaceGroup.windowId === activeTab.windowId;
    if (canJoinActiveWorkspace && !await fastWorkspace.containsTab(activeTab.id)) {
      await fastWorkspace.addTab(activeTab.id);
    }
  }

  const workspaceTabs = await fastWorkspace.listTabs();
  const promptedActiveTab = workspaceTabs.find(
    (tab) => tab.id === activeTab?.id && isControllablePage(tab.url),
  );
  const lastActiveWorkspaceTab = workspaceTabs.find(
    (tab) => tab.id === fastLastActiveWorkspaceTabId && isControllablePage(tab.url),
  );
  const connectedWorkspaceTab = workspaceTabs.find(
    (tab) => tab.id === connectedTabId && isControllablePage(tab.url),
  );
  const tab = promptedActiveTab
    || lastActiveWorkspaceTab
    || connectedWorkspaceTab
    || workspaceTabs.find((candidate) => isControllablePage(candidate.url))
    || null;
  if (!tab?.id) {
    fastPromptTargetTabId = null;
    await setConnectedTab(null);
    return {
      mode: "fast",
      workspace: fastWorkspace.state(),
      target: null,
      controllerReady: false,
      restriction: "workspace_tabs_only",
    };
  }

  fastPromptTargetTabId = tab.id;
  if (promptedActiveTab?.id === tab.id) fastLastActiveWorkspaceTabId = tab.id;
  await setConnectedTab(tab.id);
  const controllerReady = await ensureController(tab.id, 4);
  return {
    mode: "fast",
    workspace: fastWorkspace.state({ windowId: tab.windowId }),
    target: serializeTab(await chrome.tabs.get(tab.id)),
    controllerReady,
    restriction: "workspace_tabs_only",
  };
}

async function followActiveTab(windowId, { force = false } = {}) {
  await ready;
  if (fastModeEnabled && !force) return resolveFastWorkspaceTarget();
  const tab = await getActiveTab(windowId);
  if (!tab?.id || !isControllablePage(tab.url)) {
    await setConnectedTab(null);
    return null;
  }
  await setConnectedTab(tab.id);
  const controllerReady = await ensureController(tab.id, 4);
  return { tab, controllerReady };
}

async function getStatus() {
  await ready;
  if (fastModeEnabled) {
    const workspaceTarget = await resolveFastWorkspaceTarget();
    if (!workspaceTarget || !connectedTabId) {
      return {
        connected: false,
        mode: "fast",
        navigationReady: true,
        workspace: fastWorkspace.state(),
        reason: "Fast workspace has no controllable page. Open an http, https, or permitted file tab, then enable Fast mode again.",
      };
    }
    const tab = workspaceTarget.tab;
    return {
      connected: true,
      controllerReady: workspaceTarget.controllerReady,
      recovering: !workspaceTarget.controllerReady,
      mode: "fast",
      workspace: fastWorkspace.state({ windowId: tab.windowId }),
      tabId: tab.id,
      title: tab.title || "Fast workspace page",
      url: tab.url || "",
      active: Boolean(tab.active),
    };
  }
  const activeTarget = await followActiveTab();
  if (!activeTarget || !connectedTabId) {
    return {
      connected: false,
      navigationReady: true,
      reason: "This tab cannot expose PageAgent content, but Lumi can still identify, capture, open, or switch tabs when Chrome permits it.",
    };
  }
  try {
    const tab = await chrome.tabs.get(connectedTabId);
    if (!isControllablePage(tab.url)) {
      await setConnectedTab(null);
      return { connected: false };
    }
    const controllerReady = activeTarget.tab.id === tab.id
      ? activeTarget.controllerReady
      : await ensureController(connectedTabId, 2);
    return {
      connected: true,
      controllerReady,
      recovering: !controllerReady,
      tabId: tab.id,
      title: tab.title || "Active web page",
      url: tab.url || "",
      active: Boolean(tab.active),
      mode: "normal",
    };
  } catch {
    await setConnectedTab(null);
    return { connected: false };
  }
}

function assertBrowserActionActive(action) {
  if (action?.cancelled) throw new Error("The browser action was cancelled by the user.");
}

function trackBrowserActionTab(action, tabId) {
  if (action && Number.isInteger(tabId)) action.tabIds.add(tabId);
}

function cancelBrowserAction(action, reason = "The browser action was cancelled by the user.") {
  if (!action || action.cancelled) return;
  action.cancelled = true;
  for (const cancel of action.cancelHandlers || []) {
    try {
      cancel(reason);
    } catch {
      // Cancellation is best-effort; controller cleanup still runs below.
    }
  }
  action.cancelHandlers?.clear();
}

async function cancelActiveBrowserAction() {
  const action = activeBrowserAction;
  cancelBrowserAction(action);
  const tabIds = new Set(action ? action.tabIds : []);
  if (Number.isInteger(connectedTabId)) tabIds.add(connectedTabId);
  listedTabIds = new Set();
  listedTabsExpireAt = 0;
  await Promise.all([...tabIds].map((tabId) =>
    sendControllerBridge(tabId, "bridge_cancel_active_action").catch(() => null)));
  return { cancelled: Boolean(action), resetTabCount: tabIds.size };
}

async function sendBrowserTool(tool, args, action) {
  const status = await getStatus();
  assertBrowserActionActive(action);
  if (!status.connected || !status.tabId) {
    throw new Error("No controllable page is active. Use an http, https, or permitted file tab and try again.");
  }
  trackBrowserActionTab(action, status.tabId);
  if (!(await ensureController(status.tabId, 4))) {
    throw new Error("The PageAgent controller is still recovering after navigation.");
  }
  assertBrowserActionActive(action);
  const result = await chrome.tabs.sendMessage(status.tabId, {
    source: CONTENT_REQUEST_SOURCE,
    tool,
    args: args || {},
  });
  assertBrowserActionActive(action);
  if (result?.success === false) {
    throw new Error(result.error || result.message || "PageAgent action failed.");
  }
  return result;
}

async function installWindowOpenProbe(tabId, token) {
  try {
    const executions = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: installWindowOpenProbeInPage,
      args: [WINDOW_OPEN_PROBE_KEY, token],
    });
    return executions.some((execution) => execution?.result === true);
  } catch {
    return false;
  }
}

async function collectWindowOpenCalls(tabId, token) {
  try {
    const executions = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: collectWindowOpenCallsInPage,
      args: [WINDOW_OPEN_PROBE_KEY, token],
    });
    return executions.flatMap((execution) =>
      Array.isArray(execution?.result) ? execution.result : []);
  } catch {
    return [];
  }
}

async function activateClickedNewTab(tab, action, { fastMode = false, restoreTabId = null } = {}) {
  if (!Number.isInteger(tab?.id)) {
    throw new Error("Chrome reported a new tab without an ID.");
  }
  trackBrowserActionTab(action, tab.id);
  if (fastMode) {
    await fastWorkspace.addTab(tab.id);
    fastPromptTargetTabId = tab.id;
    fastLastActiveWorkspaceTabId = tab.id;
    const currentActiveTab = await getActiveTab(tab.windowId);
    if (currentActiveTab?.id === tab.id && Number.isInteger(restoreTabId) && restoreTabId !== tab.id) {
      await chrome.tabs.update(restoreTabId, { active: true }).catch(() => {});
    }
  } else {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  const settledTab = await waitForClickedTabToSettle(tab.id, action);
  const controllable = isControllablePage(settledTab.url);
  await setConnectedTab(controllable ? tab.id : null);
  const controllerReady = controllable ? await ensureController(tab.id, 5) : false;
  assertBrowserActionActive(action);
  return {
    ...serializeTab(await chrome.tabs.get(tab.id)),
    controllerReady,
    workspace: fastMode,
  };
}

async function executeBrowserClick(args, action, { fastMode = false } = {}) {
  const status = await getStatus();
  assertBrowserActionActive(action);
  if (!status.connected || !status.tabId) {
    throw new Error("No controllable page is active. Use an http, https, or permitted file tab and try again.");
  }
  trackBrowserActionTab(action, status.tabId);
  if (!(await ensureController(status.tabId, 4))) {
    throw new Error("The PageAgent controller is still recovering after navigation.");
  }

  const sourceTab = await chrome.tabs.get(status.tabId);
  const userActiveTab = fastMode ? await getActiveTab(sourceTab.windowId) : null;
  const tabsBeforeClick = await chrome.tabs.query({});
  const beforeTabIds = new Set(tabsBeforeClick.map((tab) => tab.id).filter(Number.isInteger));
  const probeToken = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
  const newTabWatcher = watchForNewTabCreation({
    tabsApi: chrome.tabs,
    beforeTabIds,
    sourceTab,
    timeoutMs: fastMode ? 160 : CLICK_NEW_TAB_WATCH_MS,
  });
  let probeInstalled = false;
  let probeCollected = false;
  let result = null;
  let clickError = null;
  let windowOpenCalls = [];
  let openedTab = null;
  let popupRecovered = false;

  try {
    probeInstalled = await installWindowOpenProbe(status.tabId, probeToken);
    try {
      result = await chrome.tabs.sendMessage(status.tabId, {
        source: CONTENT_REQUEST_SOURCE,
        tool: "browser_click",
        args: args || {},
      });
      if (result?.success === false) {
        clickError = new Error(result.error || result.message || "PageAgent action failed.");
      }
    } catch (error) {
      clickError = error;
    }
    assertBrowserActionActive(action);

    const tabsAfterClick = await chrome.tabs.query({});
    openedTab = selectNewlyOpenedTab(beforeTabIds, tabsAfterClick, sourceTab);
    if (!openedTab) openedTab = await newTabWatcher.promise;
    assertBrowserActionActive(action);

    if (probeInstalled) {
      windowOpenCalls = await collectWindowOpenCalls(status.tabId, probeToken);
      probeCollected = true;
    }

    if (!openedTab && !clickError) {
      const fallbackUrl =
        findWindowOpenNewTabUrl(windowOpenCalls, sourceTab.url)
        || resolveNewTabUrl(result?.newTabIntent?.url, sourceTab.url);
      if (fallbackUrl) {
        const createProperties = {
          url: fallbackUrl,
          active: !fastMode,
          windowId: sourceTab.windowId,
          openerTabId: sourceTab.id,
        };
        if (Number.isInteger(sourceTab.index)) {
          createProperties.index = sourceTab.index + 1;
        }
        openedTab = await chrome.tabs.create(createProperties);
        popupRecovered = true;
      }
    }

    if (openedTab) {
      const newTab = await activateClickedNewTab(openedTab, action, {
        fastMode,
        restoreTabId: userActiveTab?.id,
      });
      return {
        ...(result || {
          success: true,
          message: "Clicked the element and followed the new tab.",
        }),
        success: true,
        openedNewTab: true,
        popupRecovered,
        newTab,
        message: popupRecovered
          ? "Clicked the element. Chrome blocked its scripted popup, so Lumi opened and switched to the intended tab."
          : "Clicked the element and switched to the newly opened tab.",
      };
    }

    if (clickError) throw clickError;
    return result;
  } finally {
    newTabWatcher.stop();
    if (probeInstalled && !probeCollected) {
      await collectWindowOpenCalls(status.tabId, probeToken);
    }
  }
}

function waitForFileChooser(tabId, timeoutMs = FILE_CHOOSER_WAIT_MS) {
  let settled = false;
  let timeoutId = null;
  let rejectWait = null;

  const cleanup = () => {
    chrome.debugger.onEvent.removeListener(onEvent);
    clearTimeout(timeoutId);
  };
  const onEvent = (source, method, params) => {
    if (!isFileChooserDebuggerEvent(source, method, tabId) || settled) return;
    settled = true;
    cleanup();
    resolveWait({ source, params });
  };
  let resolveWait;
  const promise = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
    chrome.debugger.onEvent.addListener(onEvent);
    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(
        "The selected control did not open a file chooser. Read fresh page state, open any upload menu, and use the final upload control index.",
      ));
    }, timeoutMs);
  });

  return {
    promise,
    cancel(reason = "File upload was cancelled.") {
      if (settled) return;
      settled = true;
      cleanup();
      rejectWait(new Error(reason));
    },
  };
}

function describeDebuggerAttachError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/another debugger|already attached|debuggee/i.test(message)) {
    return "Lumi could not start the upload because this tab is already being controlled by DevTools or another debugger. Close DevTools for this tab and try again.";
  }
  if (/permission|not allowed/i.test(message)) {
    return "Lumi needs Chrome's debugger permission to automate the native file chooser. Reload the unpacked extension and approve its updated permissions.";
  }
  return message || "Lumi could not start Chrome's file-upload controller.";
}

async function setPreparedFileInputFiles(debuggee, token, filePaths) {
  await chrome.debugger.sendCommand(debuggee, "DOM.enable");
  await chrome.debugger.sendCommand(
    debuggee,
    "DOM.getDocument",
    { depth: 1, pierce: true },
  );
  const search = await chrome.debugger.sendCommand(
    debuggee,
    "DOM.performSearch",
    {
      query: `[data-lumi-file-upload-target="${token}"]`,
      includeUserAgentShadowDOM: true,
    },
  );
  const searchId = String(search?.searchId || "");
  try {
    if (!searchId || search?.resultCount !== 1) {
      throw new Error(
        `Lumi prepared a file input, but Chrome found ${Number(search?.resultCount) || 0} matching DOM targets.`,
      );
    }
    const result = await chrome.debugger.sendCommand(
      debuggee,
      "DOM.getSearchResults",
      { searchId, fromIndex: 0, toIndex: 1 },
    );
    const nodeId = Number(result?.nodeIds?.[0]);
    if (!Number.isInteger(nodeId)) {
      throw new Error("Chrome could not address the prepared file input.");
    }
    await chrome.debugger.sendCommand(
      debuggee,
      "DOM.setFileInputFiles",
      { files: filePaths, nodeId },
    );
  } finally {
    if (searchId) {
      await chrome.debugger.sendCommand(
        debuggee,
        "DOM.discardSearchResults",
        { searchId },
      ).catch(() => {});
    }
  }
}

async function executeBrowserFileUpload(args, action) {
  if (args?.confirmed !== true) {
    throw new Error(
      "Uploading transmits local files to the current website. Ask the user to authorize the exact absolute path(s) and destination, then retry with confirmed=true.",
    );
  }
  const index = Number(args?.index);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("browser_upload_file requires a non-negative control index from the latest page state.");
  }
  const filePaths = normalizeUploadFilePaths(args?.filePaths);
  const status = await getStatus();
  assertBrowserActionActive(action);
  if (!status.connected || !status.tabId) {
    throw new Error("No controllable page is active. Open the destination http or https page and try again.");
  }
  trackBrowserActionTab(action, status.tabId);
  if (!(await ensureController(status.tabId, 4))) {
    throw new Error("The PageAgent controller is still recovering after navigation.");
  }

  const rootDebuggee = { tabId: status.tabId };
  const uploadToken = crypto.randomUUID().toLowerCase();
  const fileNames = filePaths.map(localFileName);
  let attached = false;
  let chooserWaiter = null;
  const cancelUpload = (reason) => chooserWaiter?.cancel(reason);
  action?.cancelHandlers?.add(cancelUpload);
  try {
    const preparedTarget = await sendControllerBridge(
      status.tabId,
      "bridge_prepare_file_upload_target",
      { index, token: uploadToken, fileNames },
    );
    if (preparedTarget?.success === false) {
      throw new Error(
        preparedTarget.error
        || preparedTarget.message
        || "The page could not prepare a compatible file input.",
      );
    }
    try {
      await chrome.debugger.attach(rootDebuggee, "1.3");
      attached = true;
    } catch (error) {
      throw new Error(describeDebuggerAttachError(error));
    }
    if (preparedTarget?.prepared) {
      await setPreparedFileInputFiles(rootDebuggee, uploadToken, filePaths);
      assertBrowserActionActive(action);
      const finalized = await sendControllerBridge(
        status.tabId,
        "bridge_finalize_file_upload_target",
        { token: uploadToken },
      );
      if (finalized?.success === false) {
        throw new Error(
          finalized.error
          || finalized.message
          || "The page did not retain the selected local files.",
        );
      }
      return {
        success: true,
        fileSelectionComplete: true,
        uploadCompletionVerified: false,
        uploadStatus: "files_selected",
        requiresPageVerification: true,
        fileCount: finalized.fileCount || filePaths.length,
        fileNames: finalized.fileNames || fileNames,
        strategy: preparedTarget.strategy,
        nextPageStateQuery: fileNames[0],
        message: `Assigned ${filePaths.length} local file${filePaths.length === 1 ? "" : "s"} to the page without opening the operating-system picker. This proves file selection, not transfer completion. Observe the page with query="${fileNames[0]}", wait for any transfer/status change, and continue every remaining authorized step.`,
      };
    }

    await chrome.debugger.sendCommand(rootDebuggee, "Page.enable");
    await chrome.debugger.sendCommand(
      rootDebuggee,
      "Page.setInterceptFileChooserDialog",
      { enabled: true },
    );
    chooserWaiter = waitForFileChooser(status.tabId);
    void chooserWaiter.promise.catch(() => {});
    const clickResult = await sendControllerBridge(
      status.tabId,
      "bridge_click_file_upload_target",
      { index },
    );
    if (clickResult?.success === false) {
      throw new Error(clickResult.error || clickResult.message || "The upload control could not be clicked.");
    }
    assertBrowserActionActive(action);

    const chooser = await chooserWaiter.promise;
    chooserWaiter = null;
    assertBrowserActionActive(action);
    const backendNodeId = Number(chooser.params?.backendNodeId);
    if (!Number.isInteger(backendNodeId)) {
      throw new Error("Chrome opened a file chooser without an addressable file input.");
    }
    const chooserDebuggee = chooser.source?.sessionId
      ? { tabId: status.tabId, sessionId: chooser.source.sessionId }
      : rootDebuggee;
    await chrome.debugger.sendCommand(
      chooserDebuggee,
      "DOM.setFileInputFiles",
      { files: filePaths, backendNodeId },
    );
    assertBrowserActionActive(action);
    return {
      success: true,
      fileSelectionComplete: true,
      uploadCompletionVerified: false,
      uploadStatus: "files_selected",
      requiresPageVerification: true,
      fileCount: filePaths.length,
      fileNames,
      strategy: "intercepted_dynamic_file_chooser",
      nextPageStateQuery: fileNames[0],
      message: `Assigned ${filePaths.length} local file${filePaths.length === 1 ? "" : "s"} through the page's file chooser. This proves file selection, not transfer completion. Observe the page with query="${fileNames[0]}", wait for any transfer/status change, and continue every remaining authorized step.`,
    };
  } finally {
    action?.cancelHandlers?.delete(cancelUpload);
    chooserWaiter?.cancel();
    await sendControllerBridge(
      status.tabId,
      "bridge_cleanup_file_upload_target",
      { token: uploadToken },
    ).catch(() => {});
    if (attached) {
      await chrome.debugger.sendCommand(
        rootDebuggee,
        "Page.setInterceptFileChooserDialog",
        { enabled: false },
      ).catch(() => {});
      await chrome.debugger.detach(rootDebuggee).catch(() => {});
    }
  }
}

async function sendControllerBridge(tabId, tool, args = {}) {
  return chrome.tabs.sendMessage(tabId, {
    source: CONTENT_REQUEST_SOURCE,
    tool,
    args,
  });
}

function serializeTab(tab) {
  const url = sanitizeActiveContextUrl(tab.url || "");
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title || "Untitled page",
    url,
    active: Boolean(tab.active),
    controllable: isControllablePage(url),
    groupId: Number.isInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : null,
    workspace: fastModeEnabled && tab.groupId === fastWorkspace.state().groupId,
    agentTarget: tab.id === connectedTabId,
  };
}

async function getActivePageContext() {
  const status = await getStatus();
  if (!status.connected) {
    if (fastModeEnabled) {
      return {
        connected: false,
        mode: "fast",
        workspace: fastWorkspace.state(),
        reason: status.reason || "Fast workspace has no controllable page.",
        identifiers: [],
        pathSegments: [],
      };
    }
    const tab = await getActiveTab();
    if (isCapturableTab(tab)) {
      const url = sanitizeActiveContextUrl(tab.url);
      return {
        connected: false,
        controllable: false,
        tabId: tab.id,
        title: tab.title || "Active tab",
        url,
        ...extractActiveContextIdentifiers(url),
        reason: status.reason || "Chrome exposes this tab's identity, but not controllable page content.",
      };
    }
    return {
      connected: false,
      reason: status.reason || "No controllable http/https/file tab is active.",
      identifiers: [],
      pathSegments: [],
    };
  }
  const url = sanitizeActiveContextUrl(status.url);
  const derived = extractActiveContextIdentifiers(url);
  return {
    connected: true,
    tabId: status.tabId,
    title: status.title,
    url,
    ...derived,
    guidance: "Use an identifier only when it semantically matches a parameter declared by the MCP tool. Do not add undeclared arguments.",
  };
}

async function listBrowserTabs() {
  const workspaceGroup = fastModeEnabled ? await fastWorkspace.getGroup() : null;
  if (fastModeEnabled && !workspaceGroup) {
    listedTabIds = new Set();
    listedTabsExpireAt = Date.now() + 30000;
    return {
      windowId: null,
      mode: "fast",
      workspace: fastWorkspace.state(),
      tabs: [],
    };
  }
  const focusedWindow = workspaceGroup || await chrome.windows.getLastFocused();
  const tabs = await chrome.tabs.query(fastModeEnabled && workspaceGroup?.id !== undefined
    ? { groupId: workspaceGroup.id }
    : { windowId: focusedWindow.windowId ?? focusedWindow.id });
  const listedTabs = tabs.filter((tab) => Number.isInteger(tab.id));
  listedTabIds = new Set(listedTabs.map((tab) => tab.id));
  listedTabsExpireAt = Date.now() + 30000;
  return {
    windowId: focusedWindow.windowId ?? focusedWindow.id,
    mode: fastModeEnabled ? "fast" : "normal",
    workspace: fastModeEnabled ? fastWorkspace.state({ windowId: focusedWindow.windowId }) : null,
    tabs: listedTabs.map(serializeTab),
  };
}

function requirePageUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("Open-tab URL must be an absolute http, https, or file address.");
  }
  if (!isControllablePage(url.href)) {
    throw new Error("Lumi can open only http, https, or file pages.");
  }
  return url.href;
}

function tabTransitionSearchText(url) {
  return String(url || "new tab");
}

function capturedTabFilename(requestedName, tabTitle) {
  const baseName = String(requestedName || tabTitle || "lumi-tab-capture")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    || "lumi-tab-capture";
  return /\.(?:jpe?g)$/i.test(baseName) ? baseName : `${baseName}.jpg`;
}

function isTabCaptureRateLimitError(error) {
  const detail = error instanceof Error ? error.message : String(error || "");
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|too many capture/i.test(detail);
}

function describeTabCaptureError(error, tab = null) {
  const detail = error instanceof Error ? error.message : String(error || "");
  if (isTabCaptureRateLimitError(error)) {
    return "Chrome's screenshot limit was reached. Wait a moment and try again.";
  }
  if (/activeTab.*not in effect|cannot access contents|permission/i.test(detail)) {
    if (isFilePage(tab?.url)) {
      return "Chrome has not granted Lumi access to local files. Open Lumi's extension details and enable Allow access to file URLs.";
    }
    return "Chrome has not granted Lumi screenshot access to this page. Click the Lumi toolbar icon on this tab, then try again.";
  }
  if (/screenshots?.*disabled/i.test(detail)) {
    return "Screenshots are disabled by Chrome or an administrator policy.";
  }
  return detail
    ? `Chrome could not capture the active tab: ${detail}`
    : "Chrome could not capture the active tab.";
}

async function captureContextDataUrl(tab) {
  const options = {
    format: "jpeg",
    quality: 72,
  };
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, options);
  } catch (error) {
    if (!isTabCaptureRateLimitError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, TAB_CAPTURE_RETRY_DELAY_MS));
    const activeTab = await getActiveTab(tab.windowId);
    if (activeTab?.id !== tab.id) {
      throw new Error("The active tab changed while Lumi was waiting to retry the screenshot.");
    }
    return chrome.tabs.captureVisibleTab(tab.windowId, options);
  }
}

async function captureVisibleTab(args = {}, action) {
  await ready;
  let tab = null;
  if (fastModeEnabled) {
    const status = await getStatus();
    const visibleTab = await getActiveTab(status.workspace?.windowId);
    if (!status.connected || visibleTab?.id !== status.tabId) {
      throw new Error("Fast workspace keeps the agent tab in the background. Use semantic page inspection, or activate the agent tab before requesting a screenshot.");
    }
    tab = visibleTab;
  }
  if (!tab) tab = await getActiveTab();
  if (!isCapturableTab(tab)) {
    throw new Error("No visible active Chrome tab is available to capture.");
  }
  trackBrowserActionTab(action, tab.id);
  assertBrowserActionActive(action);
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 88,
    });
  } catch (error) {
    throw new Error(describeTabCaptureError(error, tab));
  }
  assertBrowserActionActive(action);
  const activeTab = await getActiveTab(tab.windowId);
  if (activeTab?.id !== tab.id) {
    throw new Error("The active tab changed while Lumi was taking the screenshot. Try again on the intended tab.");
  }
  const asset = await saveCapturedTabAsset({
    dataUrl,
    filename: capturedTabFilename(args.filename, tab.title),
    contentType: "image/jpeg",
    source: {
      tabId: tab.id,
      title: tab.title || "Active tab",
      url: sanitizeActiveContextUrl(tab.url || ""),
    },
  });
  return {
    captured: true,
    attachmentId: asset.id,
    filename: asset.filename,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    source: asset.source,
    previewDataUrl: asset.dataUrl,
    guidance: "Use attachmentId only in a connector tool that explicitly declares an attachmentId parameter.",
  };
}

async function captureActiveTabContextFrame(windowId) {
  await ready;
  let tab = null;
  if (fastModeEnabled) {
    const status = await getStatus();
    const visibleTab = await getActiveTab(status.workspace?.windowId ?? windowId);
    if (!status.connected || visibleTab?.id !== status.tabId) {
      return {
        captured: false,
        reason: "Fast workspace is controlling a background tab, so Lumi is using semantic DOM context without stealing focus.",
      };
    }
    tab = visibleTab;
  }
  if (!tab) tab = await getActiveTab(windowId);
  if (!isCapturableTab(tab)) {
    return {
      captured: false,
      reason: "This Lumi window does not have a visible active tab to capture.",
    };
  }

  let dataUrl;
  try {
    dataUrl = await captureContextDataUrl(tab);
  } catch (error) {
    return {
      captured: false,
      reason: describeTabCaptureError(error, tab),
    };
  }
  const activeTab = await getActiveTab(tab.windowId);
  if (activeTab?.id !== tab.id) {
    return {
      captured: false,
      reason: "The active tab changed while Lumi was capturing visual context.",
    };
  }

  const separatorIndex = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/jpeg;base64,") || separatorIndex < 0) {
    return {
      captured: false,
      reason: "Chrome returned an unsupported visual context format.",
    };
  }

  return {
    captured: true,
    data: dataUrl.slice(separatorIndex + 1),
    mimeType: "image/jpeg",
    source: {
      tabId: tab.id,
      title: tab.title || "Active tab",
      url: sanitizeActiveContextUrl(tab.url || ""),
    },
  };
}

async function findExistingTabForUrl(url, windowId = null, groupId = null) {
  const focusedWindow = Number.isInteger(windowId) ? null : await chrome.windows.getLastFocused();
  const targetWindowId = Number.isInteger(windowId) ? windowId : focusedWindow.id;
  const tabs = await chrome.tabs.query(Number.isInteger(groupId)
    ? { groupId }
    : { windowId: targetWindowId });
  const listedTabs = tabs.filter((tab) => Number.isInteger(tab.id));
  listedTabIds = new Set(listedTabs.map((tab) => tab.id));
  listedTabsExpireAt = Date.now() + 30000;
  return listedTabs.find((tab) => {
    try {
      return new URL(tab.url).href === url;
    } catch {
      return false;
    }
  }) || null;
}

async function waitForTabToSettle(tabId, action) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assertBrowserActionActive(action);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return chrome.tabs.get(tabId);
}

async function waitForClickedTabToSettle(tabId, action) {
  let latestTab = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assertBrowserActionActive(action);
    latestTab = await chrome.tabs.get(tabId);
    const destinationUrl = String(latestTab.pendingUrl || latestTab.url || "").trim();
    const waitingForDestination = !destinationUrl || destinationUrl === "about:blank";
    if (!waitingForDestination && latestTab.status === "complete") return latestTab;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return latestTab || chrome.tabs.get(tabId);
}

async function openBrowserTab(args = {}, action) {
  const url = requirePageUrl(args.url);
  if (fastModeEnabled) {
    let group = await fastWorkspace.getGroup();
    if (!group) {
      await activateFastWorkspace();
      group = await fastWorkspace.getGroup();
    }
    if (!group) throw new Error("Fast workspace could not attach to a controllable Chrome window.");
    const existingTab = await findExistingTabForUrl(url, group.windowId, group.id);
    assertBrowserActionActive(action);
    if (existingTab?.id) return switchBrowserTab({ tabId: existingTab.id }, action);

    let createdTab = null;
    try {
      createdTab = await chrome.tabs.create({ url, active: false, windowId: group.windowId });
      if (!createdTab.id) throw new Error("Chrome created the Fast workspace tab without an ID.");
      trackBrowserActionTab(action, createdTab.id);
      await fastWorkspace.addTab(createdTab.id);
      fastPromptTargetTabId = createdTab.id;
      fastLastActiveWorkspaceTabId = createdTab.id;
      await setConnectedTab(createdTab.id);
      await waitForTabToSettle(createdTab.id, action);
      const settledTab = await chrome.tabs.get(createdTab.id);
      const controllerReady = isControllablePage(settledTab.url)
        ? await ensureController(createdTab.id, 5)
        : false;
      assertBrowserActionActive(action);
      if (!controllerReady) {
        const detail = isFilePage(settledTab.url)
          ? " Enable Allow access to file URLs in Lumi's extension details."
          : "";
        throw new Error(`The Fast workspace tab could not prepare Lumi's page controller.${detail}`);
      }
      return {
        opened: true,
        controllerReady,
        mode: "fast",
        fastWorkspace: fastWorkspace.state({ windowId: settledTab.windowId }),
        ...serializeTab(settledTab),
      };
    } catch (error) {
      if (createdTab?.id) await chrome.tabs.remove(createdTab.id).catch(() => {});
      throw error;
    }
  }

  const existingTab = await findExistingTabForUrl(url);
  assertBrowserActionActive(action);
  if (existingTab?.id) {
    return switchBrowserTab({ tabId: existingTab.id }, action);
  }
  const previousTab = await getActiveTab();
  const previousTabId = previousTab?.id;
  let departureTab = previousTabId && isWebPage(previousTab?.url) ? previousTab : null;
  if (departureTab?.id) trackBrowserActionTab(action, departureTab.id);
  let createdTab = null;
  let activated = false;
  let departureShown = false;
  try {
    if (!departureTab) {
      createdTab = await chrome.tabs.create({ url: TAB_TRANSITION_FALLBACK_URL, active: true });
      if (!createdTab.id) throw new Error("Chrome created the transition tab without an ID.");
      activated = true;
      trackBrowserActionTab(action, createdTab.id);
      await chrome.windows.update(createdTab.windowId, { focused: true });
      await setConnectedTab(createdTab.id);
      departureTab = await waitForTabToSettle(createdTab.id, action);
    }

    const departureReady = await ensureController(departureTab.id, 5);
    assertBrowserActionActive(action);
    if (departureReady) {
      try {
        await sendControllerBridge(departureTab.id, "bridge_show_google_search_departure", {
          searchText: tabTransitionSearchText(url),
        });
        departureShown = true;
      } catch {
        // The transition is decorative; navigation must still finish if the page
        // stops accepting extension messages at this moment.
      }
      assertBrowserActionActive(action);
    }

    if (createdTab?.id) {
      createdTab = await chrome.tabs.update(createdTab.id, { url, active: true });
    } else {
      createdTab = await chrome.tabs.create({ url, active: true });
      if (!createdTab.id) throw new Error("Chrome created the tab without an ID.");
      activated = true;
      trackBrowserActionTab(action, createdTab.id);
    }
    if (departureShown) {
      void sendControllerBridge(departureTab.id, "bridge_clear_tab_transition").catch(() => {});
    }
    await chrome.windows.update(createdTab.windowId, { focused: true });
    await setConnectedTab(createdTab.id);
    await waitForTabToSettle(createdTab.id, action);
    const settledTab = await chrome.tabs.get(createdTab.id);
    const controllerReady = isControllablePage(settledTab.url)
      ? await ensureController(createdTab.id, 5)
      : false;
    assertBrowserActionActive(action);
    if (!controllerReady) {
      const detail = isFilePage(settledTab.url)
        ? " Enable Allow access to file URLs in Lumi's extension details."
        : "";
      throw new Error(`The new tab could not prepare Lumi's page controller.${detail}`);
    }
    assertBrowserActionActive(action);
    return {
      opened: true,
      controllerReady,
      ...serializeTab(await chrome.tabs.get(createdTab.id)),
    };
  } catch (error) {
    if (departureShown) {
      void sendControllerBridge(departureTab.id, "bridge_clear_tab_transition").catch(() => {});
    }
    if (!activated && createdTab?.id) {
      await chrome.tabs.remove(createdTab.id).catch(() => {});
    }
    throw error;
  }
}

async function switchBrowserTab(args = {}, action) {
  const tabId = Number(args.tabId);
  if (!Number.isInteger(tabId)) {
    throw new Error("browser_switch_tab requires a numeric tabId from browser_list_tabs.");
  }
  if (Date.now() > listedTabsExpireAt || !listedTabIds.has(tabId)) {
    throw new Error("That tabId is stale or was not returned by the latest browser_list_tabs call. List tabs again.");
  }
  const tab = await chrome.tabs.get(tabId);
  const controllable = isControllablePage(tab.url);
  if (fastModeEnabled) {
    if (!controllable) {
      throw new Error("Fast workspace can control only http, https, or permitted file tabs.");
    }
    if (!await fastWorkspace.containsTab(tabId)) {
      throw new Error("Fast mode can switch only to tabs already inside Agent Space. Use browser_open_tab when a new workspace tab is required.");
    }
    trackBrowserActionTab(action, tabId);
    const controllerReady = await ensureController(tabId, 5);
    assertBrowserActionActive(action);
    if (!controllerReady) {
      const detail = isFilePage(tab.url)
        ? " Enable Allow access to file URLs in Lumi's extension details."
        : "";
      throw new Error(`The Fast workspace tab could not prepare Lumi's page controller.${detail}`);
    }
    fastPromptTargetTabId = tabId;
    fastLastActiveWorkspaceTabId = tabId;
    await setConnectedTab(tabId);
    return {
      switched: true,
      controllable: true,
      controllerReady,
      mode: "fast",
      fastWorkspace: fastWorkspace.state({ windowId: tab.windowId }),
      ...serializeTab(await chrome.tabs.get(tabId)),
    };
  }
  const previousTab = await getActiveTab(tab.windowId);
  if (previousTab?.id === tabId) {
    await setConnectedTab(controllable ? tabId : null);
    return {
      switched: true,
      controllable,
      controllerReady: controllable ? await ensureController(tabId, 3) : false,
      ...serializeTab(tab),
    };
  }

  trackBrowserActionTab(action, tabId);
  const controllerReady = controllable ? await ensureController(tabId, 5) : false;
  assertBrowserActionActive(action);
  if (controllable && !controllerReady) {
    const detail = isFilePage(tab.url)
      ? " Enable Allow access to file URLs in Lumi's extension details."
      : "";
    throw new Error(`The destination tab could not prepare Lumi's page controller.${detail}`);
  }
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await setConnectedTab(controllable ? tabId : null);
  assertBrowserActionActive(action);
  const activeTab = await chrome.tabs.get(tabId);
  return {
    switched: true,
    controllable,
    controllerReady,
    ...serializeTab(activeTab),
  };
}

async function executeBrowserTool(tool, args = {}) {
  const action = { cancelled: false, tabIds: new Set(), cancelHandlers: new Set() };
  activeBrowserAction = action;
  let timeoutId = null;
  const execute = async () => {
    if (tool === "browser_get_active_context") return getActivePageContext();
    if (tool === "browser_capture_screenshot") return captureVisibleTab(args, action);
    if (tool === "browser_list_tabs") return listBrowserTabs();
    if (tool === "browser_open_tab") return openBrowserTab(args, action);
    if (tool === "browser_switch_tab") return switchBrowserTab(args, action);
    if (tool === "browser_click") {
      const visualPreferences = await getVisualPreferences();
      return executeBrowserClick(args, action, { fastMode: visualPreferences.fastMode });
    }
    if (tool === "browser_upload_file") return executeBrowserFileUpload(args, action);
    return sendBrowserTool(tool, args, action);
  };
  const timeoutMs = tool === "browser_open_tab"
    ? 30000
    : tool === "browser_click"
      ? 18000
      : tool === "browser_upload_file"
        ? 25000
        : tool === "browser_batch_actions" || tool === "browser_set_selection"
          ? 25000
          : 12000;
  try {
    return await Promise.race([
      execute(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          cancelBrowserAction(
            action,
            `${tool} timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
          );
          void Promise.all([...action.tabIds].map((tabId) =>
            sendControllerBridge(tabId, "bridge_cancel_active_action").catch(() => null)));
          reject(new Error(`${tool} timed out after ${Math.round(timeoutMs / 1000)} seconds. Page state was reset; observe the page again before retrying.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
    if (activeBrowserAction === action) activeBrowserAction = null;
  }
}

async function handleMessage(message) {
  if (message.command === "initialize_side_panel") {
    if (!fastModeEnabled) return { mode: "normal", workspace: null };
    const target = await restoreOrActivateFastWorkspace();
    notifyTargetChanged();
    return {
      mode: "fast",
      workspace: fastWorkspace.state({ windowId: target?.tab?.windowId }),
      target: target?.tab ? serializeTab(target.tab) : null,
      controllerReady: Boolean(target?.controllerReady),
    };
  }
  if (message.command === "connect_active_tab") return getStatus();
  if (message.command === "disconnect_tab") return getStatus();
  if (message.command === "get_status") return getStatus();
  if (message.command === "prepare_browser_prompt") return prepareBrowserPrompt();
  if (message.command === "set_visual_preferences") {
    const currentPreferences = await getVisualPreferences();
    const visualPreferences = normalizeVisualPreferences({
      showElementHighlights: typeof message.showElementHighlights === "boolean"
        ? message.showElementHighlights
        : currentPreferences.showElementHighlights,
      fastMode: typeof message.fastMode === "boolean"
        ? message.fastMode
        : currentPreferences.fastMode,
    });
    const previousFastMode = fastModeEnabled;
    const fastModeChanged = visualPreferences.fastMode !== previousFastMode;
    let workspace = fastModeEnabled ? fastWorkspace.state() : null;
    if (fastModeChanged) {
      try {
        const modeResult = await applyFastModeEnabled(visualPreferences.fastMode);
        workspace = fastModeEnabled ? modeResult.workspace : null;
      } catch (error) {
        fastModeEnabled = previousFastMode;
        throw error;
      }
    }
    try {
      await chrome.storage.local.set({
        [ELEMENT_HIGHLIGHTS_STORAGE_KEY]: visualPreferences.showElementHighlights,
        [FAST_MODE_STORAGE_KEY]: visualPreferences.fastMode,
      });
    } catch (error) {
      if (fastModeChanged) await applyFastModeEnabled(previousFastMode).catch(() => {});
      throw error;
    }
    if (connectedTabId) {
      await applyControllerVisualPreferences(connectedTabId, visualPreferences);
    }
    return { ...visualPreferences, workspace };
  }
  if (message.command === "cancel_active_browser_action") return cancelActiveBrowserAction();
  if (message.command === "cancel_active_mcp_calls") return cancelActiveMcpCalls();
  if (message.command === "cancel_video_analysis") return videoAnalysis.cancelActive();
  if (message.command === "analyze_current_video") {
    return videoAnalysis.analyze({
      apiKey: message.apiKey,
      args: message.args || {},
    });
  }
  if (message.command === "live_translation_status") {
    return sendOffscreenCommand("translation_status");
  }
  if (message.command === "prepare_shared_tab_audio") {
    await releaseTranslationCapture();
    return sendOffscreenCommand("prepare_external_capture", {
      mode: "sharedTab",
      tabId: null,
      title: String(message.title || "Shared Chrome tab").slice(0, 240),
      url: "",
      sourcePlaybackVolume: Number(message.sourcePlaybackVolume) === 0.06 ? 0.06 : 1,
    }, true);
  }
  if (message.command === "start_live_translation") {
    let status = await sendOffscreenCommand("translation_status");
    const tab = await getActiveTab();
    if (status.prepared && status.source?.mode === "sharedTab") {
      return startPreparedTranslation(status, tab || {}, message);
    }
    if (!tab?.id || !isControllablePage(tab.url)) {
      return {
        requiresSharedTabAudio: true,
        reason: "No active web video could be captured automatically.",
      };
    }
    if (status.source?.tabId && status.source.tabId !== tab.id) {
      await releaseTranslationCapture(status.source.tabId);
      status = await sendOffscreenCommand("translation_status");
    }
    if (!status.prepared) {
      try {
        status = await prepareDirectMediaElementAudio(tab);
      } catch (fallbackError) {
        const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        return {
          requiresSharedTabAudio: true,
          reason: `Automatic video audio capture was unavailable: ${detail}`,
        };
      }
    }
    const activeTab = await getActiveTab();
    if (activeTab?.id !== tab.id) {
      await releaseTranslationCapture(tab.id);
      throw new Error("The active tab changed while Lumi was preparing video audio. Ask to translate again on the video tab.");
    }
    return startPreparedTranslation(status, tab, message);
  }
  if (message.command === "stop_live_translation") {
    const status = await sendOffscreenCommand("translation_status");
    if (status.source?.mode === "mediaElement" || status.source?.mode === "sharedTab") {
      const wasActive = status.state !== "off";
      await releaseTranslationCapture(status.source.tabId);
      return { prepared: false, state: "off", source: null, wasActive };
    }
    return sendOffscreenCommand("stop_translation");
  }
  if (message.command === "release_tab_audio") {
    return releaseTranslationCapture();
  }
  if (message.command === "flow_record_status") {
    const currentDraft = recordedFlows.snapshot();
    if (currentDraft?.recording && Number.isInteger(currentDraft.tabId)) {
      const tab = await chrome.tabs.get(currentDraft.tabId).catch(() => null);
      if (tab?.id && isControllablePage(tab.url) && await ensureController(tab.id, 3)) {
        await resumeFlowRecording(tab.id);
      }
    }
    return {
      draft: recordedFlows.snapshot(),
      flows: await recordedFlows.list(),
    };
  }
  if (message.command === "flow_record_start") return startFlowRecording();
  if (message.command === "flow_record_stop") return stopFlowRecording();
  if (message.command === "flow_record_update") {
    const draft = await recordedFlows.updateDraft({
      name: message.name,
      stepId: message.stepId,
      prompt: message.prompt,
      move: message.move,
      remove: message.remove === true,
    });
    broadcastFlowRecordingChanged(draft);
    return { draft };
  }
  if (message.command === "flow_record_save") {
    await stopFlowRecording();
    const result = await recordedFlows.saveDraft();
    broadcastFlowRecordingChanged(result.draft);
    return result;
  }
  if (message.command === "flow_record_open") {
    if (recordedFlows.snapshot()?.recording) {
      throw new Error("Stop the current recording before opening another flow.");
    }
    const draft = await recordedFlows.load(message.flowId);
    broadcastFlowRecordingChanged(draft);
    return { draft };
  }
  if (message.command === "flow_record_delete") {
    const flows = await recordedFlows.remove(message.flowId);
    broadcastFlowRecordingChanged();
    return { flows, draft: recordedFlows.snapshot() };
  }
  if (message.command === "flow_record_clear") {
    await stopFlowRecording();
    await recordedFlows.clearDraft();
    broadcastFlowRecordingChanged(null);
    return { draft: null };
  }
  if (message.command === "browser_tool") {
    return executeBrowserTool(message.tool, message.args || {});
  }
  if (message.command === "capture_tab_context_frame") {
    return captureActiveTabContextFrame(message.windowId);
  }
  if (message.command === "mcp_list_servers") return listMcpServers();
  if (message.command === "mcp_add_server") return addMcpServer(message.url);
  if (message.command === "mcp_connect_connector") {
    return connectMcpConnector(message.connectorId, message.config || {});
  }
  if (message.command === "mcp_reconnect_server") return reconnectMcpServer(message.serverId);
  if (message.command === "mcp_set_server_enabled") {
    return setMcpServerEnabled(message.serverId, message.enabled);
  }
  if (message.command === "mcp_remove_server") return removeMcpServer(message.serverId);
  if (message.command === "mcp_get_tools") return getConfiguredMcps(true);
  if (message.command === "mcp_inspect_tools") return getConfiguredMcps(true, false);
  if (message.command === "mcp_disable_tool") {
    return disableMcpTool(message.serverId, message.tool, message.reason, message.source);
  }
  if (message.command === "mcp_enable_tool") return enableMcpTool(message.serverId, message.tool);
  if (message.command === "mcp_set_tool_policy") {
    return setMcpToolPolicy(message.serverId, message.tool, message.mode);
  }
  if (message.command === "mcp_set_server_tool_policy") {
    return setMcpServerToolPolicy(message.serverId, message.mode);
  }
  if (message.command === "mcp_call_tool") {
    return callMcpTool(
      message.serverId,
      message.tool,
      message.args || {},
      message.permissionGranted === true,
    );
  }
  throw new Error(`Unsupported Lumi Live command: ${message.command}`);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void releaseTranslationCapture(tabId).catch(() => {});
  if (recordedFlows.isRecordingTab(tabId)) {
    void recordedFlows.stop().then((draft) => broadcastFlowRecordingChanged(draft));
  }
  if (tabId === fastPromptTargetTabId) fastPromptTargetTabId = null;
  if (tabId === fastLastActiveWorkspaceTabId) fastLastActiveWorkspaceTabId = null;
  if (tabId !== connectedTabId) return;
  void setConnectedTab(null).then(() => (
    fastModeEnabled ? resolveFastWorkspaceTarget() : followActiveTab()
  ));
});

function recordInPageNavigation(details) {
  if (
    details.frameId !== 0
    || !isControllablePage(details.url)
  ) return;
  setTimeout(() => {
    if (!recordedFlows.isRecordingTab(details.tabId)) return;
    void chrome.tabs.get(details.tabId).then(async (tab) => {
      const draft = await recordedFlows.recordNavigation({
        url: sanitizeActiveContextUrl(details.url),
        title: tab.title || details.url,
      });
      broadcastFlowRecordingChanged(draft);
    }).catch(() => {});
  }, 120);
}

chrome.webNavigation.onHistoryStateUpdated.addListener(recordInPageNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(recordInPageNavigation);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (Object.hasOwn(changeInfo, "groupId")) {
    void ready.then(async () => {
      if (!fastModeEnabled) return;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const workspaceGroupId = fastWorkspace.state().groupId;
      const joinedWorkspace = Number.isInteger(workspaceGroupId)
        && tab?.groupId === workspaceGroupId;

      if (joinedWorkspace) {
        await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
        if (!tab.active) {
          notifyTargetChanged();
          return;
        }
        fastPromptTargetTabId = tabId;
        fastLastActiveWorkspaceTabId = tabId;
        if (!isControllablePage(tab.url)) {
          await setConnectedTab(null);
          notifyTargetChanged();
          return;
        }
        await setConnectedTab(tabId);
        const controllerReady = await ensureController(tabId, 5);
        if (tabId !== connectedTabId) return;
        if (controllerReady) await chrome.action.setBadgeText({ tabId, text: "ON" });
        notifyTargetChanged();
        return;
      }

      const wasPromptTarget = tabId === fastPromptTargetTabId;
      const wasLastActiveTarget = tabId === fastLastActiveWorkspaceTabId;
      const wasConnectedTarget = tabId === connectedTabId;
      if (!wasPromptTarget && !wasLastActiveTarget && !wasConnectedTarget) return;
      if (wasPromptTarget) fastPromptTargetTabId = null;
      if (wasLastActiveTarget) fastLastActiveWorkspaceTabId = null;
      if (wasConnectedTarget) await setConnectedTab(null);
      await resolveFastWorkspaceTarget();
      notifyTargetChanged();
    }).catch(() => {});
  }
  if (changeInfo.status === "loading") {
    void releaseTranslationCapture(tabId).catch(() => {});
    return;
  }
  if (changeInfo.status !== "complete") return;
  if (fastModeEnabled) {
    if (tabId !== connectedTabId) return;
    void chrome.tabs.get(tabId).then(async (tab) => {
      if (!isControllablePage(tab.url)) {
        await resolveFastWorkspaceTarget();
        return;
      }
      const controllerReady = await ensureController(tabId, 5);
      if (tabId !== connectedTabId) return;
      if (controllerReady) await chrome.action.setBadgeText({ tabId, text: "ON" });
      if (controllerReady && recordedFlows.isRecordingTab(tabId)) {
        await resumeFlowRecording(tabId);
        const draft = await recordedFlows.recordNavigation({
          url: sanitizeActiveContextUrl(tab.url || ""),
          title: tab.title || "",
        });
        broadcastFlowRecordingChanged(draft);
      }
      notifyTargetChanged();
    }).catch(() => {});
    return;
  }
  void getActiveTab().then(async (tab) => {
    if (tab?.id !== tabId || !isControllablePage(tab.url)) return;
    await setConnectedTab(tabId);
    const controllerReady = await ensureController(tabId, 5);
    if (tabId !== connectedTabId) return;
    if (controllerReady) await chrome.action.setBadgeText({ tabId, text: "ON" });
    if (controllerReady && recordedFlows.isRecordingTab(tabId)) {
      await resumeFlowRecording(tabId);
      const draft = await recordedFlows.recordNavigation({
        url: sanitizeActiveContextUrl(tab.url || ""),
        title: tab.title || "",
      });
      broadcastFlowRecordingChanged(draft);
    }
    notifyTargetChanged();
  }).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (fastModeEnabled) {
    void fastWorkspace.containsTab(tabId).then((insideWorkspace) => {
      if (insideWorkspace) fastLastActiveWorkspaceTabId = tabId;
    });
    return;
  }
  void releaseCaptureForDifferentTab(tabId).catch(() => {});
  void getActiveTab(windowId).then(async (tab) => {
    if (tab?.id !== tabId) return;
    if (!isControllablePage(tab.url)) {
      await setConnectedTab(null);
      return;
    }
    await setConnectedTab(tabId);
    await ensureController(tabId, 4);
    if (tabId === connectedTabId) notifyTargetChanged();
  }).catch(() => followActiveTab(windowId));
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (fastModeEnabled) return;
  void getActiveTab(windowId).then(async (tab) => {
    await releaseCaptureForDifferentTab(tab?.id ?? null).catch(() => {});
    await followActiveTab(windowId);
  }).catch(() => {
    void followActiveTab(windowId);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const visualPreferenceChanged = areaName === "local"
    && (changes[ELEMENT_HIGHLIGHTS_STORAGE_KEY] || changes[FAST_MODE_STORAGE_KEY]);
  if (!visualPreferenceChanged) return;
  const nextFastMode = normalizeVisualPreferences({
    fastMode: changes[FAST_MODE_STORAGE_KEY]?.newValue,
  }).fastMode;
  if (changes[FAST_MODE_STORAGE_KEY] && nextFastMode !== fastModeEnabled) {
    void applyFastModeEnabled(nextFastMode).then(() => {
      if (connectedTabId) return applyControllerVisualPreferences(connectedTabId);
      return null;
    });
    return;
  }
  if (connectedTabId) void applyControllerVisualPreferences(connectedTabId);
});

void ready.then(async () => {
  if (fastModeEnabled) return;
  await followActiveTab();
}).catch(() => {
  void setConnectedTab(null);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === EXTENSION_EVENTS.flowRecordedStep && sender.id === chrome.runtime.id) {
    ready
      .then(() => handleRecordedFlowStep(message, sender))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Could not record this browser action.",
      }));
    return true;
  }
  if (message?.type === EXTENSION_EVENTS.translationState && message.state === "error") {
    void sendOffscreenCommand("translation_status")
      .then((status) => {
        if (status.source?.mode === "mediaElement") {
          return releaseTranslationCapture(status.source.tabId);
        }
        return null;
      })
      .catch(() => {});
    return false;
  }
  if (message?.type !== MESSAGE_TYPE || sender.id !== chrome.runtime.id) return false;
  ready.then(() => handleMessage(message))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Lumi Live request failed.",
    }));
  return true;
});
