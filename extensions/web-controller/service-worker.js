const LUMI_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const BRIDGE_REQUEST_TYPE = "lumi_page_agent_request";
const CONTENT_REQUEST_SOURCE = "lumi-page-agent-service";
const TARGET_STORAGE_KEY = "lumiConnectedTabId";

let connectedTabId = null;

async function loadConnectedTab() {
  const stored = await chrome.storage.session.get(TARGET_STORAGE_KEY);
  connectedTabId = Number.isInteger(stored[TARGET_STORAGE_KEY])
    ? stored[TARGET_STORAGE_KEY]
    : null;
}

const ready = loadConnectedTab();

function isWebPage(url = "") {
  return /^https?:\/\//i.test(url);
}

function isLumiPage(url = "") {
  try {
    return LUMI_LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function setConnectedTab(tabId) {
  if (connectedTabId && connectedTabId !== tabId) {
    await chrome.action.setBadgeText({ tabId: connectedTabId, text: "" }).catch(() => {});
  }
  connectedTabId = tabId;
  if (tabId === null) {
    await chrome.storage.session.remove(TARGET_STORAGE_KEY);
    return;
  }
  await chrome.storage.session.set({ [TARGET_STORAGE_KEY]: tabId });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#745bc4" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });
}

async function pingController(tabId) {
  return chrome.tabs.sendMessage(tabId, {
    source: CONTENT_REQUEST_SOURCE,
    tool: "bridge_controller_ping",
    args: {},
  }).then((result) => Boolean(result?.success)).catch(() => false);
}

async function ensureController(tabId, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await pingController(tabId)) return true;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["dist/controller.js"],
      });
      if (await pingController(tabId)) return true;
    } catch {
      // Navigation can briefly make the tab unavailable; retry below.
    }
    await new Promise((resolve) => setTimeout(resolve, 180 + attempt * 220));
  }
  return false;
}

async function getConnectedStatus() {
  await ready;
  if (!connectedTabId) return { connected: false };
  try {
    const tab = await chrome.tabs.get(connectedTabId);
    if (!isWebPage(tab.url)) {
      await setConnectedTab(null);
      return { connected: false };
    }
    const controllerReady = await ensureController(connectedTabId, 2);
    return {
      connected: true,
      controllerReady,
      recovering: !controllerReady,
      tabId: tab.id,
      title: tab.title || "Connected tab",
      url: tab.url || "",
      active: Boolean(tab.active),
    };
  } catch {
    await setConnectedTab(null);
    return { connected: false };
  }
}

async function sendToConnectedTab(tool, args) {
  const status = await getConnectedStatus();
  if (!status.connected || !status.tabId) {
    throw new Error("No target tab is connected. Click the Lumi controller icon on the web tab you want to control.");
  }
  if (!(await ensureController(status.tabId, 4))) {
    throw new Error("The PageAgent controller is still recovering after navigation.");
  }
  const result = await chrome.tabs.sendMessage(status.tabId, {
    source: CONTENT_REQUEST_SOURCE,
    tool,
    args: args || {},
  });
  if (result?.success === false) {
    throw new Error(result.error || result.message || "PageAgent action failed.");
  }
  return result;
}

async function handleTool(tool, args = {}) {
  await ready;
  if (tool === "bridge_get_status") return getConnectedStatus();
  if (tool === "bridge_disconnect_shared_tab") {
    await setConnectedTab(null);
    return { success: true, connected: false };
  }
  return sendToConnectedTab(tool, args);
}

chrome.action.onClicked.addListener(async (tab) => {
  await ready;
  if (!tab.id || !isWebPage(tab.url) || isLumiPage(tab.url)) {
    if (tab.id) {
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#ce6b82" }).catch(() => {});
      await chrome.action.setBadgeText({ tabId: tab.id, text: "!" }).catch(() => {});
    }
    return;
  }

  if (connectedTabId === tab.id) {
    await setConnectedTab(null);
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["dist/controller.js"],
    });
    await setConnectedTab(tab.id);
  } catch {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#ce6b82" }).catch(() => {});
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === connectedTabId) void setConnectedTab(null);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== connectedTabId || changeInfo.status !== "complete") return;
  void ensureController(tabId, 5).then((controllerReady) => {
    if (controllerReady) return chrome.action.setBadgeText({ tabId, text: "ON" });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== BRIDGE_REQUEST_TYPE) return false;
  if (!sender.tab?.url || !isLumiPage(sender.tab.url)) {
    sendResponse({ ok: false, error: "This page is not allowed to control Lumi's browser bridge." });
    return false;
  }

  handleTool(message.tool, message.args)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Browser tool failed.",
    }));
  return true;
});
