import { createMcpService } from "./mcp-service.js";
import {
  extractActiveContextIdentifiers,
  sanitizeActiveContextUrl,
} from "../core/active-tab-context.js";
import { EXTENSION_EVENTS, STORAGE_KEYS } from "../core/extension-config.js";
import { normalizeVisualPreferences } from "../core/visual-preferences.js";
import { saveCapturedTabAsset } from "./captured-tab-assets.js";

const MESSAGE_TYPE = EXTENSION_EVENTS.request;
const CONTENT_REQUEST_SOURCE = "lumi-page-agent-service";
const TARGET_STORAGE_KEY = STORAGE_KEYS.targetTabId;
const TARGET_CHANGED_MESSAGE = EXTENSION_EVENTS.targetChanged;
const PANEL_LIFECYCLE_MESSAGE = EXTENSION_EVENTS.lifecycle;
const ELEMENT_HIGHLIGHTS_STORAGE_KEY = STORAGE_KEYS.elementHighlights;
const OFFSCREEN_DOCUMENT_PATH = "offscreen/index.html";
const OFFSCREEN_TARGET = "lumi_live_offscreen";
const TAB_TRANSITION_FALLBACK_URL = "https://www.google.com/";
const TAB_CAPTURE_RETRY_DELAY_MS = 550;

let connectedTabId = null;
let listedTabIds = new Set();
let listedTabsExpireAt = 0;
let activeBrowserAction = null;
let creatingOffscreenDocument = null;
const sidePanelPorts = new Set();
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

async function loadTarget() {
  const stored = await chrome.storage.session.get(TARGET_STORAGE_KEY);
  connectedTabId = Number.isInteger(stored[TARGET_STORAGE_KEY])
    ? stored[TARGET_STORAGE_KEY]
    : null;
}

const ready = loadTarget();

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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "lumi_live_side_panel") return;
  sidePanelPorts.add(port);
  void chrome.runtime.sendMessage({ type: PANEL_LIFECYCLE_MESSAGE, state: "opened" }).catch(() => {});
  port.onDisconnect.addListener(() => {
    sidePanelPorts.delete(port);
    if (sidePanelPorts.size > 0) return;
    void chrome.runtime.sendMessage({ type: PANEL_LIFECYCLE_MESSAGE, state: "closed" }).catch(() => {});
    void releaseTranslationCapture().catch(() => {});
  });
});

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
  const stored = await chrome.storage.local.get(ELEMENT_HIGHLIGHTS_STORAGE_KEY);
  return normalizeVisualPreferences({
    showElementHighlights: stored[ELEMENT_HIGHLIGHTS_STORAGE_KEY] === true,
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

async function followActiveTab(windowId) {
  await ready;
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

async function cancelActiveBrowserAction() {
  const action = activeBrowserAction;
  if (action) action.cancelled = true;
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

async function sendControllerBridge(tabId, tool, args = {}) {
  return chrome.tabs.sendMessage(tabId, {
    source: CONTENT_REQUEST_SOURCE,
    tool,
    args,
  });
}

function serializeTab(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title || "Untitled page",
    url: tab.url || "",
    active: Boolean(tab.active),
    controllable: isControllablePage(tab.url),
  };
}

async function getActivePageContext() {
  const status = await getStatus();
  if (!status.connected) {
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
  const focusedWindow = await chrome.windows.getLastFocused();
  const tabs = await chrome.tabs.query({ windowId: focusedWindow.id });
  const listedTabs = tabs.filter((tab) => Number.isInteger(tab.id));
  listedTabIds = new Set(listedTabs.map((tab) => tab.id));
  listedTabsExpireAt = Date.now() + 30000;
  return {
    windowId: focusedWindow.id,
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
  const tab = await getActiveTab();
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
  const tab = await getActiveTab(windowId);
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

async function findExistingTabForUrl(url) {
  const focusedWindow = await chrome.windows.getLastFocused();
  const tabs = await chrome.tabs.query({ windowId: focusedWindow.id });
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

async function openBrowserTab(args = {}, action) {
  const url = requirePageUrl(args.url);
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
  const action = { cancelled: false, tabIds: new Set() };
  activeBrowserAction = action;
  let timeoutId = null;
  const execute = async () => {
    if (tool === "browser_get_active_context") return getActivePageContext();
    if (tool === "browser_capture_screenshot") return captureVisibleTab(args, action);
    if (tool === "browser_list_tabs") return listBrowserTabs();
    if (tool === "browser_open_tab") return openBrowserTab(args, action);
    if (tool === "browser_switch_tab") return switchBrowserTab(args, action);
    return sendBrowserTool(tool, args, action);
  };
  const timeoutMs = tool === "browser_open_tab" ? 30000 : 12000;
  try {
    return await Promise.race([
      execute(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          action.cancelled = true;
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
  if (message.command === "connect_active_tab") return getStatus();
  if (message.command === "disconnect_tab") return getStatus();
  if (message.command === "get_status") return getStatus();
  if (message.command === "set_visual_preferences") {
    const visualPreferences = normalizeVisualPreferences({
      showElementHighlights: message.showElementHighlights === true,
    });
    await chrome.storage.local.set({
      [ELEMENT_HIGHLIGHTS_STORAGE_KEY]: visualPreferences.showElementHighlights,
    });
    if (connectedTabId) {
      await applyControllerVisualPreferences(connectedTabId, visualPreferences);
    }
    return visualPreferences;
  }
  if (message.command === "cancel_active_browser_action") return cancelActiveBrowserAction();
  if (message.command === "cancel_active_mcp_calls") return cancelActiveMcpCalls();
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
  if (tabId !== connectedTabId) return;
  void setConnectedTab(null).then(() => followActiveTab());
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void releaseTranslationCapture(tabId).catch(() => {});
    return;
  }
  if (changeInfo.status !== "complete") return;
  void getActiveTab().then(async (tab) => {
    if (tab?.id !== tabId || !isControllablePage(tab.url)) return;
    await setConnectedTab(tabId);
    const controllerReady = await ensureController(tabId, 5);
    if (tabId !== connectedTabId) return;
    if (controllerReady) await chrome.action.setBadgeText({ tabId, text: "ON" });
    notifyTargetChanged();
  }).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
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
  void getActiveTab(windowId).then(async (tab) => {
    await releaseCaptureForDifferentTab(tab?.id ?? null).catch(() => {});
    await followActiveTab(windowId);
  }).catch(() => {
    void followActiveTab(windowId);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const visualPreferenceChanged = areaName === "local" && changes[ELEMENT_HIGHLIGHTS_STORAGE_KEY];
  if (!visualPreferenceChanged || !connectedTabId) return;
  void applyControllerVisualPreferences(connectedTabId);
});

void ready.then(() => followActiveTab()).catch(() => {
  void setConnectedTab(null);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Lumi Live request failed.",
    }));
  return true;
});
