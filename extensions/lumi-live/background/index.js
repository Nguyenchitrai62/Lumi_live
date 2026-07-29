import { createMcpService } from "./mcp-service.js";
import {
  extractActiveContextIdentifiers,
  sanitizeActiveContextUrl,
} from "../core/active-tab-context.js";
import { EXTENSION_EVENTS, STORAGE_KEYS } from "../core/extension-config.js";
import { normalizeVisualPreferences } from "../core/visual-preferences.js";
import { saveCapturedTabAsset } from "./captured-tab-assets.js";
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
import {
  collectRuntimeDiagnosticsInPage,
  installRuntimeDiagnosticsProbeInPage,
  removeRuntimeDiagnosticsProbeInPage,
} from "../browser/runtime-diagnostics.js";

const MESSAGE_TYPE = EXTENSION_EVENTS.request;
const CONTENT_REQUEST_SOURCE = "lumi-page-agent-service";
const TARGET_STORAGE_KEY = STORAGE_KEYS.targetTabId;
const TARGET_CHANGED_MESSAGE = EXTENSION_EVENTS.targetChanged;
const ATTENTION_MESSAGE = EXTENSION_EVENTS.attention;
const SCHEDULED_RUN_MESSAGE = EXTENSION_EVENTS.scheduledRun;
const PANEL_LIFECYCLE_MESSAGE = EXTENSION_EVENTS.lifecycle;
const ELEMENT_HIGHLIGHTS_STORAGE_KEY = STORAGE_KEYS.elementHighlights;
const OFFSCREEN_DOCUMENT_PATH = "offscreen/index.html";
const OFFSCREEN_TARGET = "lumi_live_offscreen";
const TAB_TRANSITION_FALLBACK_URL = "https://www.google.com/";
const TAB_CAPTURE_RETRY_DELAY_MS = 550;
const WINDOW_OPEN_PROBE_KEY = "__LUMI_WINDOW_OPEN_PROBE__";
const CLICK_NEW_TAB_WATCH_MS = 2500;
const FILE_CHOOSER_WAIT_MS = 10000;
const QC_SCHEDULE_ALARM_PREFIX = "lumi-qc-schedule:";
const HICAS_HOST = "sit.hawee.hicas.vn";

let connectedTabId = null;
let listedTabIds = new Set();
let listedTabsExpireAt = 0;
let activeBrowserAction = null;
let creatingOffscreenDocument = null;
let lockedTaskTarget = null;
let attentionState = null;
let qcExecutionMode = "step";
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

function publishAttention() {
  void chrome.runtime.sendMessage({
    type: ATTENTION_MESSAGE,
    attention: attentionState,
  }).catch(() => {});
}

async function returnToTaskTarget() {
  const tabId = attentionState?.tabId ?? lockedTaskTarget?.tabId;
  if (!Number.isInteger(tabId)) throw new Error("The original task tab is no longer available.");
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await setConnectedTab(tabId);
  return serializeTab(await chrome.tabs.get(tabId));
}

async function raiseAttention(value = {}) {
  const targetTabId = Number.isInteger(value.tabId)
    ? value.tabId
    : lockedTaskTarget?.tabId ?? connectedTabId;
  attentionState = {
    id: `attention-${Date.now()}`,
    taskId: String(value.taskId || lockedTaskTarget?.taskId || ""),
    runId: String(value.runId || lockedTaskTarget?.runId || ""),
    tabId: Number.isInteger(targetTabId) ? targetTabId : null,
    title: String(value.title || "LUMI needs your attention").slice(0, 200),
    message: String(value.message || "The current workflow stopped.").slice(0, 1200),
    createdAt: Date.now(),
  };
  const activeTab = await getActiveTab().catch(() => null);
  const badgeTargets = new Set([attentionState.tabId, activeTab?.id].filter(Number.isInteger));
  await Promise.all([...badgeTargets].map(async (tabId) => {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c82f47" }).catch(() => {});
    await chrome.action.setBadgeText({ tabId, text: "!" }).catch(() => {});
  }));
  if (sidePanelPorts.size === 0) {
    await chrome.notifications.create(`lumi-attention-${attentionState.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/lumi-live.png"),
      title: attentionState.title,
      message: attentionState.message,
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: "Return to ERP tab" }],
    }).catch(() => {});
  }
  publishAttention();
  return attentionState;
}

async function acknowledgeAttention() {
  const previous = attentionState;
  attentionState = null;
  if (previous?.tabId) {
    await chrome.action.setBadgeBackgroundColor({
      tabId: previous.tabId,
      color: "#745bc4",
    }).catch(() => {});
    await chrome.action.setBadgeText({
      tabId: previous.tabId,
      text: previous.tabId === connectedTabId ? "ON" : "",
    }).catch(() => {});
  }
  const activeTab = await getActiveTab().catch(() => null);
  if (activeTab?.id && activeTab.id !== previous?.tabId) {
    await chrome.action.setBadgeText({
      tabId: activeTab.id,
      text: activeTab.id === connectedTabId ? "ON" : "",
    }).catch(() => {});
  }
  publishAttention();
  return { acknowledged: true };
}

async function executeMainWorldProbe(tabId, func, args = []) {
  if (!Number.isInteger(tabId)) return null;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
  });
  return results?.[0]?.result || null;
}

function scheduleParts(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "Asia/Bangkok",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function nextScheduleTimestamp(schedule, now = Date.now()) {
  const [hour, minute] = String(schedule.local_time || "").split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  const dayMap = new Map([
    ["Mon", 0], ["Tue", 1], ["Wed", 2], ["Thu", 3],
    ["Fri", 4], ["Sat", 5], ["Sun", 6],
  ]);
  const days = new Set((schedule.days_of_week || []).map(Number));
  const start = Math.floor(now / 60000) * 60000 + 60000;
  for (let offset = 0; offset < 8 * 24 * 60; offset += 1) {
    const timestamp = start + offset * 60000;
    const parts = scheduleParts(timestamp, schedule.timezone);
    if (
      Number(parts.hour) === hour
      && Number(parts.minute) === minute
      && days.has(dayMap.get(parts.weekday))
    ) return timestamp;
  }
  return null;
}

async function qcServiceRequest(path, { method = "GET", body } = {}) {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.qcServiceUrl,
    STORAGE_KEYS.qcServiceToken,
  ]);
  const token = String(stored[STORAGE_KEYS.qcServiceToken] || "").trim();
  const endpoint = new URL(String(
    stored[STORAGE_KEYS.qcServiceUrl] || "http://127.0.0.1:8765",
  ));
  if (
    endpoint.protocol !== "http:"
    || !["127.0.0.1", "localhost"].includes(endpoint.hostname)
    || !token
  ) throw new Error("Local QC Service is not configured.");
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") + path;
  endpoint.search = "";
  endpoint.hash = "";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "X-Lumi-Installation-Token": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = String((await response.json())?.detail || "");
      } catch {
        detail = "";
      }
      throw new Error(detail || `Local QC Service returned ${response.status}.`);
    }
    return response.status === 204 ? null : response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function syncQcScheduleAlarms(schedules = []) {
  const existing = await chrome.alarms.getAll();
  await Promise.all(existing
    .filter((alarm) => alarm.name.startsWith(QC_SCHEDULE_ALARM_PREFIX))
    .map((alarm) => chrome.alarms.clear(alarm.name)));
  for (const schedule of schedules) {
    if (!schedule?.enabled || !schedule?.id) continue;
    const when = nextScheduleTimestamp(schedule);
    if (!when) continue;
    await chrome.alarms.create(`${QC_SCHEDULE_ALARM_PREFIX}${schedule.id}`, { when });
  }
  return {
    scheduled: schedules.filter((schedule) => schedule?.enabled).length,
  };
}

async function refreshQcScheduleAlarms() {
  const schedules = await qcServiceRequest("/v1/schedules");
  return syncQcScheduleAlarms(schedules);
}

function routeMatchesTarget(tabUrl, targetUrl) {
  try {
    const tab = new URL(tabUrl);
    const target = new URL(targetUrl);
    if (tab.hostname !== target.hostname) return false;
    const targetRoot = target.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
    return !targetRoot || tab.pathname.includes(targetRoot);
  } catch {
    return false;
  }
}

function skillRoutePattern(template) {
  const escaped = String(template).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped
    .replace(/\\\{project_id\\\}/g, "[^/]+")
    .replace(/\\\{entity_id\\\}/g, "[^/]+")}/?$`, "i");
}

async function hicasRouteFingerprint(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.hostname !== HICAS_HOST) return null;
    const response = await fetch(
      chrome.runtime.getURL("skills/hicas-erp-qc/runtime-index.json"),
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const index = await response.json();
    const routeUrl = `${url.pathname}${url.search}`;
    const route = (index.routes || []).find((item) => item.template === routeUrl)
      || (index.routes || []).find((item) => item.template === url.pathname)
      || (index.routes || []).find((item) =>
        skillRoutePattern(item.template).test(routeUrl)
        || skillRoutePattern(item.template).test(url.pathname));
    return route || null;
  } catch {
    return null;
  }
}

async function scheduledRunBlock(result, reason, tabId = null) {
  const runId = result?.run?.run_id || "";
  if (runId) {
    await qcServiceRequest(`/v1/runs/${encodeURIComponent(runId)}/block`, {
      method: "POST",
      body: { reason },
    }).catch(() => null);
  }
  await raiseAttention({
    runId,
    tabId,
    title: "LUMI scheduled run blocked",
    message: reason,
  });
}

async function handleQcScheduleAlarm(scheduleId) {
  let result = null;
  try {
    result = await qcServiceRequest(
      `/v1/schedules/${encodeURIComponent(scheduleId)}/run-now`,
      { method: "POST" },
    );
    const session = await chrome.storage.session.get(STORAGE_KEYS.qcActiveRun);
    const conflictingRunId = String(session[STORAGE_KEYS.qcActiveRun] || "");
    if (conflictingRunId && conflictingRunId !== result.run.run_id) {
      const conflicting = await qcServiceRequest(
        `/v1/runs/${encodeURIComponent(conflictingRunId)}`,
      ).catch(() => null);
      if (["approved", "running", "paused"].includes(conflicting?.status)) {
        await scheduledRunBlock(result, `Another QC run ${conflictingRunId} is still active.`);
        return;
      }
    }
    const targetUrl = result.run.plan?.comparison_specs?.[0]?.target_url
      || result.run.plan?.test_cases?.[0]?.steps?.find((step) =>
        /^https?:\/\//i.test(step.target || ""))?.target
      || `https://${HICAS_HOST}/`;
    const tabs = await chrome.tabs.query({});
    const targetTab = tabs.find((tab) =>
      routeMatchesTarget(tab.url || "", targetUrl))
      || tabs.find((tab) => {
        try {
          return new URL(tab.url || "").hostname === HICAS_HOST;
        } catch {
          return false;
        }
      });
    if (!targetTab?.id) {
      await scheduledRunBlock(result, "No HICAS ERP tab is open.");
      return;
    }
    if (sidePanelPorts.size === 0) {
      await scheduledRunBlock(
        result,
        "LUMI side panel is closed, so the scheduled agent runtime is unavailable.",
        targetTab.id,
      );
      return;
    }
    if (!await ensureController(targetTab.id, 4)) {
      await scheduledRunBlock(result, "The HICAS tab controller is unavailable.", targetTab.id);
      return;
    }
    const expectedFingerprint = String(result.run.plan?.target_fingerprint || "").trim();
    if (expectedFingerprint) {
      const route = await hicasRouteFingerprint(targetTab.url || "");
      if (!route || route.fingerprint !== expectedFingerprint) {
        await scheduledRunBlock(
          result,
          "The HICAS route fingerprint no longer matches the approved run template.",
          targetTab.id,
        );
        return;
      }
    }
    const pageState = await chrome.tabs.sendMessage(targetTab.id, {
      source: CONTENT_REQUEST_SOURCE,
      tool: "browser_get_page_state",
      args: { query: "Đăng nhập" },
    }).catch(() => null);
    const pageText = String(pageState?.content || pageState?.message || "");
    if (
      /\/login(?:\/|$|\?)/i.test(targetTab.url || "")
      || /password.*(?:đăng nhập|login)|(?:đăng nhập|login).*password/i.test(pageText)
    ) {
      await scheduledRunBlock(result, "The ERP session is logged out.", targetTab.id);
      return;
    }
    await setConnectedTab(targetTab.id);
    lockedTaskTarget = {
      tabId: targetTab.id,
      taskId: `scheduled-${result.run.run_id}`,
      runId: result.run.run_id,
    };
    await executeMainWorldProbe(
      targetTab.id,
      installRuntimeDiagnosticsProbeInPage,
    ).catch(() => null);
    qcExecutionMode = result.run.plan?.execution_mode === "fast_verified"
      ? "fast_verified"
      : "step";
    await applyControllerVisualPreferences(targetTab.id);
    await chrome.storage.session.set({
      [STORAGE_KEYS.qcActiveRun]: result.run.run_id,
      [STORAGE_KEYS.qcRunApprovalToken]: result.approval_token,
    });
    await chrome.runtime.sendMessage({
      type: SCHEDULED_RUN_MESSAGE,
      result,
      tabId: targetTab.id,
    });
  } catch (error) {
    await scheduledRunBlock(
      result,
      error instanceof Error ? error.message : "The scheduled run could not start.",
    );
  } finally {
    void refreshQcScheduleAlarms().catch(() => {});
  }
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
    executionMode: qcExecutionMode,
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

async function activateClickedNewTab(tab, action) {
  if (!Number.isInteger(tab?.id)) {
    throw new Error("Chrome reported a new tab without an ID.");
  }
  trackBrowserActionTab(action, tab.id);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  const settledTab = await waitForClickedTabToSettle(tab.id, action);
  const controllable = isControllablePage(settledTab.url);
  await setConnectedTab(controllable ? tab.id : null);
  const controllerReady = controllable ? await ensureController(tab.id, 5) : false;
  assertBrowserActionActive(action);
  return {
    ...serializeTab(await chrome.tabs.get(tab.id)),
    controllerReady,
  };
}

async function executeBrowserClick(args, action) {
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
  const tabsBeforeClick = await chrome.tabs.query({});
  const beforeTabIds = new Set(tabsBeforeClick.map((tab) => tab.id).filter(Number.isInteger));
  const probeToken = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
  const newTabWatcher = watchForNewTabCreation({
    tabsApi: chrome.tabs,
    beforeTabIds,
    sourceTab,
    timeoutMs: CLICK_NEW_TAB_WATCH_MS,
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
          active: true,
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
      const newTab = await activateClickedNewTab(openedTab, action);
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
  const action = { cancelled: false, tabIds: new Set(), cancelHandlers: new Set() };
  activeBrowserAction = action;
  let timeoutId = null;
  const execute = async () => {
    if (tool === "browser_get_active_context") return getActivePageContext();
    if (tool === "browser_capture_screenshot") return captureVisibleTab(args, action);
    if (tool === "browser_list_tabs") return listBrowserTabs();
    if (tool === "browser_open_tab") return openBrowserTab(args, action);
    if (tool === "browser_switch_tab") return switchBrowserTab(args, action);
    if (tool === "browser_click") return executeBrowserClick(args, action);
    if (tool === "browser_upload_file") return executeBrowserFileUpload(args, action);
    return sendBrowserTool(tool, args, action);
  };
  const timeoutMs = tool === "browser_open_tab"
    ? 30000
    : tool === "browser_click"
      ? 18000
      : tool === "browser_upload_file"
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
  if (message.command === "connect_active_tab") return getStatus();
  if (message.command === "disconnect_tab") return getStatus();
  if (message.command === "get_status") return getStatus();
  if (message.command === "task_target_lock") {
    const tabId = Number.isInteger(message.tabId) ? message.tabId : connectedTabId;
    if (!Number.isInteger(tabId)) throw new Error("A controllable task tab is required.");
    lockedTaskTarget = {
      tabId,
      taskId: String(message.taskId || ""),
      runId: String(message.runId || ""),
    };
    void executeMainWorldProbe(
      tabId,
      installRuntimeDiagnosticsProbeInPage,
    ).catch(() => {});
    return { locked: true, ...lockedTaskTarget };
  }
  if (message.command === "task_target_release") {
    const releasedTabId = lockedTaskTarget?.tabId;
    if (!message.taskId || lockedTaskTarget?.taskId === message.taskId) {
      lockedTaskTarget = null;
      void executeMainWorldProbe(
        releasedTabId,
        removeRuntimeDiagnosticsProbeInPage,
      ).catch(() => {});
      void followActiveTab();
    }
    return { locked: Boolean(lockedTaskTarget), target: lockedTaskTarget };
  }
  if (message.command === "attention_raise") return raiseAttention(message);
  if (message.command === "attention_acknowledge") return acknowledgeAttention();
  if (message.command === "attention_status") return attentionState;
  if (message.command === "attention_return_to_target") return returnToTaskTarget();
  if (message.command === "qc_schedules_sync") {
    return syncQcScheduleAlarms(Array.isArray(message.schedules) ? message.schedules : []);
  }
  if (message.command === "collect_runtime_diagnostics") {
    const tabId = Number.isInteger(message.tabId)
      ? message.tabId
      : lockedTaskTarget?.tabId ?? connectedTabId;
    return executeMainWorldProbe(
      tabId,
      collectRuntimeDiagnosticsInPage,
      [message.clear !== false],
    );
  }
  if (message.command === "set_qc_execution_mode") {
    qcExecutionMode = message.executionMode === "fast_verified" ? "fast_verified" : "step";
    const current = await getVisualPreferences();
    const visualPreferences = normalizeVisualPreferences({
      ...current,
      executionMode: qcExecutionMode,
    });
    const tabId = Number.isInteger(message.tabId)
      ? message.tabId
      : lockedTaskTarget?.tabId ?? connectedTabId;
    if (Number.isInteger(tabId)) {
      await applyControllerVisualPreferences(tabId, visualPreferences);
    }
    return visualPreferences;
  }
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
  if (lockedTaskTarget?.tabId === tabId) {
    void raiseAttention({
      taskId: lockedTaskTarget.taskId,
      runId: lockedTaskTarget.runId,
      tabId: null,
      title: "LUMI task tab was closed",
      message: "Reopen the approved ERP page and review the blocked run.",
    });
    lockedTaskTarget = null;
  }
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
    if (lockedTaskTarget?.tabId && lockedTaskTarget.tabId !== tabId) {
      notifyTargetChanged();
      return;
    }
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

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("lumi-attention-")) return;
  void returnToTaskTarget().catch(() => {});
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith("lumi-attention-") || buttonIndex !== 0) return;
  void returnToTaskTarget().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(QC_SCHEDULE_ALARM_PREFIX)) return;
  const scheduleId = alarm.name.slice(QC_SCHEDULE_ALARM_PREFIX.length);
  if (scheduleId) void handleQcScheduleAlarm(scheduleId);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const visualPreferenceChanged = areaName === "local" && changes[ELEMENT_HIGHLIGHTS_STORAGE_KEY];
  if (!visualPreferenceChanged || !connectedTabId) return;
  void applyControllerVisualPreferences(connectedTabId);
});

void ready.then(() => followActiveTab()).catch(() => {
  void setConnectedTab(null);
});
void ready.then(() => refreshQcScheduleAlarms()).catch(() => {});

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
