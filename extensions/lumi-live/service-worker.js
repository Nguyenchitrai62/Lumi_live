import { McpHttpClient, normalizeMcpUrl } from "./mcp-client.js";
import { prepareGeminiMcpTool } from "./gemini-tool-schema.js";
import {
  extractActiveContextIdentifiers,
  sanitizeActiveContextUrl,
} from "./active-tab-context.js";
import { EXTENSION_EVENTS, STORAGE_KEYS } from "./extension-config.js";
import { normalizeVisualPreferences } from "./visual-preferences.js";

const MESSAGE_TYPE = EXTENSION_EVENTS.request;
const CONTENT_REQUEST_SOURCE = "lumi-page-agent-service";
const TARGET_STORAGE_KEY = STORAGE_KEYS.targetTabId;
const TARGET_CHANGED_MESSAGE = EXTENSION_EVENTS.targetChanged;
const PANEL_LIFECYCLE_MESSAGE = EXTENSION_EVENTS.lifecycle;
const ELEMENT_HIGHLIGHTS_STORAGE_KEY = STORAGE_KEYS.elementHighlights;
const MCP_URL_STORAGE_KEY = STORAGE_KEYS.legacyMcpUrl;
const MCP_SERVERS_STORAGE_KEY = STORAGE_KEYS.mcpServers;
const MCP_DISABLED_TOOLS_STORAGE_KEY = STORAGE_KEYS.mcpDisabledTools;
const MCP_TOOL_POLICIES_STORAGE_KEY = STORAGE_KEYS.mcpToolPolicies;
const DEFAULT_MCP_TOOL_POLICY = "allow";

let connectedTabId = null;
let listedTabIds = new Set();
let listedTabsExpireAt = 0;
let activeBrowserAction = null;
const mcpConnections = new Map();
const activeMcpCallControllers = new Set();

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

chrome.sidePanel.onOpened?.addListener(() => {
  void chrome.runtime.sendMessage({ type: PANEL_LIFECYCLE_MESSAGE, state: "opened" }).catch(() => {});
});

chrome.sidePanel.onClosed?.addListener(() => {
  void chrome.runtime.sendMessage({ type: PANEL_LIFECYCLE_MESSAGE, state: "closed" }).catch(() => {});
});

function isWebPage(url = "") {
  return /^https?:\/\//i.test(url);
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
  if (!tab?.id || !isWebPage(tab.url)) {
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
      reason: "Switch to a normal http/https page and Lumi will target it automatically.",
    };
  }
  try {
    const tab = await chrome.tabs.get(connectedTabId);
    if (!isWebPage(tab.url)) {
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

function cancelActiveMcpCalls() {
  const controllers = [...activeMcpCallControllers];
  for (const controller of controllers) controller.abort();
  return { cancelled: controllers.length > 0, count: controllers.length };
}

async function sendBrowserTool(tool, args, action) {
  const status = await getStatus();
  assertBrowserActionActive(action);
  if (!status.connected || !status.tabId) {
    throw new Error("No controllable web page is active. Switch to a normal http/https tab and try again.");
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
  };
}

async function getActivePageContext() {
  const status = await getStatus();
  if (!status.connected) {
    return {
      connected: false,
      reason: status.reason || "No controllable http/https tab is active.",
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
  const controllableTabs = tabs.filter((tab) => Number.isInteger(tab.id) && isWebPage(tab.url));
  listedTabIds = new Set(controllableTabs.map((tab) => tab.id));
  listedTabsExpireAt = Date.now() + 30000;
  return {
    windowId: focusedWindow.id,
    tabs: controllableTabs.map(serializeTab),
  };
}

function requireWebUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("Open-tab URL must be an absolute http/https address.");
  }
  if (!isWebPage(url.href)) {
    throw new Error("Lumi can open only normal http/https pages.");
  }
  return url.href;
}

function tabTransitionSearchText(url) {
  const parsed = new URL(url);
  for (const parameter of ["q", "query", "search_query"]) {
    const value = parsed.searchParams.get(parameter)?.replace(/\s+/g, " ").trim();
    if (value) return value.slice(0, 120);
  }
  return parsed.hostname.replace(/^www\./i, "").slice(0, 120) || "new tab";
}

async function findExistingTabForUrl(url) {
  const focusedWindow = await chrome.windows.getLastFocused();
  const tabs = await chrome.tabs.query({ windowId: focusedWindow.id });
  const controllableTabs = tabs.filter((tab) => Number.isInteger(tab.id) && isWebPage(tab.url));
  listedTabIds = new Set(controllableTabs.map((tab) => tab.id));
  listedTabsExpireAt = Date.now() + 30000;
  return controllableTabs.find((tab) => {
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
  const url = requireWebUrl(args.url);
  const existingTab = await findExistingTabForUrl(url);
  assertBrowserActionActive(action);
  if (existingTab?.id) {
    return switchBrowserTab({ tabId: existingTab.id }, action);
  }
  const previousTab = await getActiveTab();
  const previousTabId = previousTab?.id;
  trackBrowserActionTab(action, previousTabId);
  let createdTab = null;
  let activated = false;
  try {
    if (!previousTabId || !isWebPage(previousTab?.url)) {
      throw new Error("Lumi needs a controllable current page to show the required Google Search transition before opening a new tab.");
    }
    const departureReady = await ensureController(previousTabId, 3);
    assertBrowserActionActive(action);
    if (!departureReady) {
      throw new Error("The current page could not prepare the required Google Search transition.");
    }
    await sendControllerBridge(previousTabId, "bridge_show_google_search_departure", {
      searchText: tabTransitionSearchText(url),
    });
    assertBrowserActionActive(action);

    createdTab = await chrome.tabs.create({ url, active: true });
    if (!createdTab.id) throw new Error("Chrome created the tab without an ID.");
    activated = true;
    trackBrowserActionTab(action, createdTab.id);
    void sendControllerBridge(previousTabId, "bridge_clear_tab_transition").catch(() => {});
    await chrome.windows.update(createdTab.windowId, { focused: true });
    await setConnectedTab(createdTab.id);
    await waitForTabToSettle(createdTab.id, action);
    const controllerReady = await ensureController(createdTab.id, 5);
    assertBrowserActionActive(action);
    if (!controllerReady) throw new Error("The new tab could not prepare Lumi's page controller.");
    assertBrowserActionActive(action);
    return {
      opened: true,
      controllerReady,
      ...serializeTab(await chrome.tabs.get(createdTab.id)),
    };
  } catch (error) {
    if (previousTabId) {
      void sendControllerBridge(previousTabId, "bridge_clear_tab_transition").catch(() => {});
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
  if (!isWebPage(tab.url)) throw new Error("The selected tab is not a controllable http/https page.");
  const previousTab = await getActiveTab(tab.windowId);
  if (previousTab?.id === tabId) {
    await setConnectedTab(tabId);
    return {
      switched: true,
      controllerReady: await ensureController(tabId, 3),
      ...serializeTab(tab),
    };
  }

  trackBrowserActionTab(action, tabId);
  const controllerReady = await ensureController(tabId, 5);
  assertBrowserActionActive(action);
  if (!controllerReady) throw new Error("The destination tab could not prepare Lumi's page controller.");
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await setConnectedTab(tabId);
  assertBrowserActionActive(action);
  const activeTab = await chrome.tabs.get(tabId);
  return {
    switched: true,
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
    if (tool === "browser_list_tabs") return listBrowserTabs();
    if (tool === "browser_open_tab") return openBrowserTab(args, action);
    if (tool === "browser_switch_tab") return switchBrowserTab(args, action);
    return sendBrowserTool(tool, args, action);
  };
  const timeoutMs = tool === "browser_open_tab" ? 20000 : 12000;
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

function fallbackMcpServerName(url) {
  try {
    return new URL(url).hostname || "MCP server";
  } catch {
    return "MCP server";
  }
}

function normalizeMcpServerRecord(value) {
  if (!value || typeof value !== "object") return null;
  let url;
  try {
    url = normalizeMcpUrl(value.url);
  } catch {
    return null;
  }
  return {
    id: typeof value.id === "string" && value.id ? value.id : crypto.randomUUID(),
    url,
    serverName: typeof value.serverName === "string" && value.serverName
      ? value.serverName.slice(0, 160)
      : fallbackMcpServerName(url),
    serverVersion: typeof value.serverVersion === "string" ? value.serverVersion.slice(0, 80) : "",
    protocolVersion: typeof value.protocolVersion === "string" ? value.protocolVersion.slice(0, 40) : "",
    toolCount: Number.isInteger(value.toolCount) && value.toolCount >= 0 ? value.toolCount : 0,
  };
}

async function loadMcpServerRecords() {
  const stored = await chrome.storage.local.get([MCP_SERVERS_STORAGE_KEY, MCP_URL_STORAGE_KEY]);
  const storedList = stored[MCP_SERVERS_STORAGE_KEY];
  const source = Array.isArray(storedList) ? storedList : [];
  if (!Array.isArray(storedList) && stored[MCP_URL_STORAGE_KEY]) {
    source.push({ url: stored[MCP_URL_STORAGE_KEY] });
  }

  const records = [];
  const urls = new Set();
  const ids = new Set();
  for (const candidate of source) {
    const record = normalizeMcpServerRecord(candidate);
    if (!record || urls.has(record.url)) continue;
    while (ids.has(record.id)) record.id = crypto.randomUUID();
    urls.add(record.url);
    ids.add(record.id);
    records.push(record);
  }

  const needsMigration = !Array.isArray(storedList)
    || JSON.stringify(storedList) !== JSON.stringify(records)
    || Object.hasOwn(stored, MCP_URL_STORAGE_KEY);
  if (needsMigration) {
    await chrome.storage.local.set({ [MCP_SERVERS_STORAGE_KEY]: records });
    await chrome.storage.local.remove(MCP_URL_STORAGE_KEY);
  }
  return records;
}

async function saveMcpServerRecords(records) {
  await chrome.storage.local.set({ [MCP_SERVERS_STORAGE_KEY]: records });
  await chrome.storage.local.remove(MCP_URL_STORAGE_KEY);
}

function recordFromMcpConnection(connection) {
  return {
    id: connection.id,
    url: connection.url,
    serverName: connection.client.serverInfo?.name || fallbackMcpServerName(connection.url),
    serverVersion: connection.client.serverInfo?.version || "",
    protocolVersion: connection.client.protocolVersion || "",
    toolCount: connection.tools.length,
  };
}

function disabledMcpToolKey(serverId, toolName) {
  return `${serverId}\u0000${toolName}`;
}

async function loadMcpToolPolicies() {
  const stored = await chrome.storage.local.get(MCP_TOOL_POLICIES_STORAGE_KEY);
  const records = Array.isArray(stored[MCP_TOOL_POLICIES_STORAGE_KEY])
    ? stored[MCP_TOOL_POLICIES_STORAGE_KEY]
    : [];
  return new Map(records
    .filter((record) => record
      && typeof record.serverId === "string"
      && typeof record.toolName === "string"
      && ["block", "allow", "ask"].includes(record.mode))
    .map((record) => [disabledMcpToolKey(record.serverId, record.toolName), record]));
}

async function saveMcpToolPolicies(policies) {
  await chrome.storage.local.set({
    [MCP_TOOL_POLICIES_STORAGE_KEY]: [...policies.values()],
  });
}

async function setMcpToolPolicy(serverId, toolName, mode) {
  if (typeof serverId !== "string" || !serverId || typeof toolName !== "string" || !toolName) {
    throw new Error("A valid MCP server and tool are required.");
  }
  if (!["block", "allow", "ask"].includes(mode)) {
    throw new Error("MCP tool permission must be block, allow, or ask.");
  }
  const policies = await loadMcpToolPolicies();
  policies.set(disabledMcpToolKey(serverId, toolName), { serverId, toolName, mode });
  await saveMcpToolPolicies(policies);
  return { serverId, toolName, mode };
}

async function setMcpServerToolPolicy(serverId, mode) {
  if (typeof serverId !== "string" || !serverId) {
    throw new Error("A valid MCP server is required.");
  }
  if (!["block", "allow", "ask"].includes(mode)) {
    throw new Error("MCP tool permission must be block, allow, or ask.");
  }
  const records = await loadMcpServerRecords();
  const record = records.find((item) => item.id === serverId);
  if (!record) throw new Error("That MCP server is no longer in your list.");
  const connection = await connectMcpRecord(record);
  const policies = await loadMcpToolPolicies();
  let updatedCount = 0;
  for (const tool of connection.tools) {
    const toolName = typeof tool?.name === "string" ? tool.name : "";
    if (!toolName) continue;
    policies.set(disabledMcpToolKey(serverId, toolName), { serverId, toolName, mode });
    updatedCount += 1;
  }
  await saveMcpToolPolicies(policies);
  return { serverId, mode, updatedCount };
}

async function clearMcpToolPolicies(serverId) {
  const policies = await loadMcpToolPolicies();
  let changed = false;
  for (const [key, record] of policies) {
    if (record.serverId !== serverId) continue;
    policies.delete(key);
    changed = true;
  }
  if (changed) await saveMcpToolPolicies(policies);
}

async function loadDisabledMcpTools() {
  const stored = await chrome.storage.session.get(MCP_DISABLED_TOOLS_STORAGE_KEY);
  const records = Array.isArray(stored[MCP_DISABLED_TOOLS_STORAGE_KEY])
    ? stored[MCP_DISABLED_TOOLS_STORAGE_KEY]
    : [];
  return new Map(records
    .filter((record) => record && typeof record.serverId === "string" && typeof record.toolName === "string")
    .map((record) => [disabledMcpToolKey(record.serverId, record.toolName), record]));
}

async function saveDisabledMcpTools(disabledTools) {
  await chrome.storage.session.set({
    [MCP_DISABLED_TOOLS_STORAGE_KEY]: [...disabledTools.values()],
  });
}

async function disableMcpTool(serverId, toolName, reason, source = "manual") {
  if (typeof serverId !== "string" || !serverId || typeof toolName !== "string" || !toolName) {
    throw new Error("A valid MCP server and tool are required.");
  }
  const disabledSource = ["gemini_setup", "runtime_user", "settings"].includes(source)
    ? source
    : "manual";
  const disabledTools = await loadDisabledMcpTools();
  disabledTools.set(disabledMcpToolKey(serverId, toolName), {
    serverId,
    toolName,
    reason: String(reason || "Gemini Live rejected this tool declaration.").slice(0, 1200),
    source: disabledSource,
    disabledAt: Date.now(),
  });
  await saveDisabledMcpTools(disabledTools);
  return { disabled: true, serverId, toolName, source: disabledSource };
}

async function enableMcpTool(serverId, toolName) {
  if (typeof serverId !== "string" || !serverId || typeof toolName !== "string" || !toolName) {
    throw new Error("A valid MCP server and tool are required.");
  }
  const disabledTools = await loadDisabledMcpTools();
  disabledTools.delete(disabledMcpToolKey(serverId, toolName));
  await saveDisabledMcpTools(disabledTools);
  return { disabled: false, serverId, toolName };
}

async function clearDisabledMcpTools(serverId) {
  const disabledTools = await loadDisabledMcpTools();
  let changed = false;
  for (const [key, record] of disabledTools) {
    if (record.serverId !== serverId) continue;
    disabledTools.delete(key);
    changed = true;
  }
  if (changed) await saveDisabledMcpTools(disabledTools);
}

function serializeMcpTool(serverId, tool, disabledTools, policies) {
  const compatibility = prepareGeminiMcpTool(tool);
  const toolKey = disabledMcpToolKey(serverId, String(tool?.name || ""));
  const temporaryBlock = disabledTools.get(toolKey);
  const permission = policies.get(toolKey)?.mode || DEFAULT_MCP_TOOL_POLICY;
  return {
    name: typeof tool?.name === "string" ? tool.name : "",
    description: typeof tool?.description === "string" ? tool.description : "",
    permission,
    gemini: {
      ...compatibility,
      schemaCompatible: compatibility.enabled,
      enabled: compatibility.enabled && !temporaryBlock,
      temporary: Boolean(temporaryBlock),
      disabledSource: temporaryBlock?.source || (compatibility.enabled ? "" : "schema"),
      errors: temporaryBlock ? [temporaryBlock.reason] : compatibility.errors,
    },
  };
}

function serializeMcpConnection(
  connection,
  includeTools = false,
  disabledTools = new Map(),
  policies = new Map(),
) {
  const tools = connection.tools.map((tool) =>
    serializeMcpTool(connection.id, tool, disabledTools, policies));
  const result = {
    id: connection.id,
    url: connection.url,
    serverName: connection.client.serverInfo?.name || "MCP server",
    serverVersion: connection.client.serverInfo?.version || "",
    protocolVersion: connection.client.protocolVersion || "",
    instructions: connection.client.instructions || "",
    toolCount: connection.tools.length,
    enabledToolCount: tools.filter((tool) => tool.gemini.enabled).length,
    disabledToolCount: tools.filter((tool) => !tool.gemini.enabled).length,
  };
  if (includeTools) result.tools = tools;
  return result;
}

async function connectMcpRecord(record, force = false) {
  const existing = mcpConnections.get(record.id);
  if (!force && existing?.url === record.url) return existing;

  const client = new McpHttpClient(record.url);
  await client.connect();
  const tools = await client.listTools();
  const connection = { id: record.id, url: record.url, client, tools };
  mcpConnections.set(record.id, connection);
  return connection;
}

async function addMcpServer(rawUrl) {
  const url = normalizeMcpUrl(rawUrl);
  const records = await loadMcpServerRecords();
  if (records.some((record) => record.url === url)) {
    throw new Error("This MCP server is already in your list.");
  }
  const draft = { id: crypto.randomUUID(), url };
  const connection = await connectMcpRecord(draft, true);
  records.push(recordFromMcpConnection(connection));
  await saveMcpServerRecords(records);
  return serializeMcpConnection(connection, true);
}

async function listMcpServers() {
  const servers = await loadMcpServerRecords();
  return { servers, count: servers.length };
}

async function reconnectMcpServer(serverId) {
  const records = await loadMcpServerRecords();
  const index = records.findIndex((record) => record.id === serverId);
  if (index < 0) throw new Error("That MCP server is no longer in your list.");
  const connection = await connectMcpRecord(records[index], true);
  await clearDisabledMcpTools(serverId);
  records[index] = recordFromMcpConnection(connection);
  await saveMcpServerRecords(records);
  return serializeMcpConnection(connection, true, new Map(), await loadMcpToolPolicies());
}

async function removeMcpServer(serverId) {
  const records = await loadMcpServerRecords();
  const nextRecords = records.filter((record) => record.id !== serverId);
  if (nextRecords.length === records.length) throw new Error("That MCP server is no longer in your list.");
  mcpConnections.delete(serverId);
  await clearDisabledMcpTools(serverId);
  await clearMcpToolPolicies(serverId);
  await saveMcpServerRecords(nextRecords);
  return { servers: nextRecords, count: nextRecords.length };
}

async function getConfiguredMcps(includeTools = false, force = true) {
  const records = await loadMcpServerRecords();
  if (!records.length) return { configured: false, serverCount: 0, connectedCount: 0, servers: [] };

  const states = await Promise.all(records.map(async (record) => {
    try {
      const connection = await connectMcpRecord(record, force);
      return { record: recordFromMcpConnection(connection), connection, error: "" };
    } catch (error) {
      mcpConnections.delete(record.id);
      return {
        record,
        connection: null,
        error: error instanceof Error ? error.message : "Could not connect to this MCP server.",
      };
    }
  }));

  const refreshedRecords = states.map((state) => state.record);
  if (JSON.stringify(refreshedRecords) !== JSON.stringify(records)) {
    await saveMcpServerRecords(refreshedRecords);
  }
  const disabledTools = await loadDisabledMcpTools();
  const policies = await loadMcpToolPolicies();
  return {
    configured: true,
    serverCount: records.length,
    connectedCount: states.filter((state) => state.connection).length,
    servers: states.map((state) => state.connection
      ? serializeMcpConnection(state.connection, includeTools, disabledTools, policies)
      : { ...state.record, enabledToolCount: 0, disabledToolCount: 0, tools: [], error: state.error }),
  };
}

async function callMcpTool(serverId, tool, args, permissionGranted = false) {
  const records = await loadMcpServerRecords();
  const record = records.find((candidate) => candidate.id === serverId);
  if (!record) throw new Error("The MCP server for this tool is no longer configured.");
  const connection = await connectMcpRecord(record);
  const candidate = connection.tools.find((item) => item.name === tool);
  if (!candidate) {
    throw new Error(`${record.serverName} does not expose tool: ${tool}`);
  }
  const policies = await loadMcpToolPolicies();
  const permission = policies.get(disabledMcpToolKey(serverId, tool))?.mode || DEFAULT_MCP_TOOL_POLICY;
  if (permission === "block") throw new Error("This MCP tool is blocked in Lumi Settings.");
  if (permission === "ask" && permissionGranted !== true) {
    throw new Error("This MCP tool requires user approval before every call.");
  }
  const disabledTools = await loadDisabledMcpTools();
  const temporaryBlock = disabledTools.get(disabledMcpToolKey(serverId, tool));
  if (temporaryBlock) throw new Error(`This MCP tool is temporarily disabled: ${temporaryBlock.reason}`);
  const compatibility = prepareGeminiMcpTool(candidate);
  if (!compatibility.enabled) throw new Error(`This MCP tool has an incompatible schema: ${compatibility.errors.join(" ")}`);
  const controller = new AbortController();
  activeMcpCallControllers.add(controller);
  try {
    return await connection.client.callTool(tool, args || {}, { signal: controller.signal });
  } finally {
    activeMcpCallControllers.delete(controller);
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
  if (message.command === "browser_tool") {
    return executeBrowserTool(message.tool, message.args || {});
  }
  if (message.command === "mcp_list_servers") return listMcpServers();
  if (message.command === "mcp_add_server") return addMcpServer(message.url);
  if (message.command === "mcp_reconnect_server") return reconnectMcpServer(message.serverId);
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
  if (tabId !== connectedTabId) return;
  void setConnectedTab(null).then(() => followActiveTab());
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  void getActiveTab().then(async (tab) => {
    if (tab?.id !== tabId || !isWebPage(tab.url)) return;
    await setConnectedTab(tabId);
    const controllerReady = await ensureController(tabId, 5);
    if (tabId !== connectedTabId) return;
    if (controllerReady) await chrome.action.setBadgeText({ tabId, text: "ON" });
    notifyTargetChanged();
  }).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void getActiveTab(windowId).then(async (tab) => {
    if (tab?.id !== tabId) return;
    if (!isWebPage(tab.url)) {
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
  void followActiveTab(windowId);
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
  if (message?.type !== MESSAGE_TYPE || sender.id !== chrome.runtime.id) return false;
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Lumi Live request failed.",
    }));
  return true;
});
