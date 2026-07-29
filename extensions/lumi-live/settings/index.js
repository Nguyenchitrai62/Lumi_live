import { createMcpSettingsController } from "./mcp-settings-controller.js";
import { EXTENSION_EVENTS, STORAGE_KEYS } from "../core/extension-config.js";
import { DEFAULT_VOICE_NAME } from "../core/ui-config.js";
import {
  createVoicePreviewController,
  VOICE_PROFILES,
} from "./voice-preview-controller.js";

const MESSAGE_TYPE = EXTENSION_EVENTS.request;
const API_KEY_STORAGE_KEY = STORAGE_KEYS.apiKey;
const VOICE_STORAGE_KEY = STORAGE_KEYS.voice;
const ELEMENT_HIGHLIGHTS_STORAGE_KEY = STORAGE_KEYS.elementHighlights;
const MCP_DISABLED_TOOLS_STORAGE_KEY = STORAGE_KEYS.mcpDisabledTools;
const MCP_TOOL_POLICIES_STORAGE_KEY = STORAGE_KEYS.mcpToolPolicies;
const QC_DEFAULT_SERVICE_URL = "http://127.0.0.1:8765";
const QC_DEFAULT_ALLOWED_DOMAINS = "sit.hawee.hicas.vn";
const elements = {
  extensionVersion: document.querySelector("#extensionVersion"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  voiceInput: document.querySelector("#voiceInput"),
  toggleKeyButton: document.querySelector("#toggleKeyButton"),
  previewVoiceButton: document.querySelector("#previewVoiceButton"),
  saveSettingsButton: document.querySelector("#saveSettingsButton"),
  saveNote: document.querySelector("#saveNote"),
  microphonePermissionStatus: document.querySelector("#microphonePermissionStatus"),
  enableMicrophoneButton: document.querySelector("#enableMicrophoneButton"),
  showElementHighlightsInput: document.querySelector("#showElementHighlightsInput"),
  qcServiceUrlInput: document.querySelector("#qcServiceUrlInput"),
  qcServiceTokenInput: document.querySelector("#qcServiceTokenInput"),
  qcAllowedDomainsInput: document.querySelector("#qcAllowedDomainsInput"),
  qcDiscoveryModeInput: document.querySelector("#qcDiscoveryModeInput"),
  qcTestServiceButton: document.querySelector("#qcTestServiceButton"),
  qcSaveSettingsButton: document.querySelector("#qcSaveSettingsButton"),
  qcSettingsNote: document.querySelector("#qcSettingsNote"),
  showAddMcpButton: document.querySelector("#showAddMcpButton"),
  mcpAddModal: document.querySelector("#mcpAddModal"),
  cancelAddMcpButton: document.querySelector("#cancelAddMcpButton"),
  mcpAddForm: document.querySelector("#mcpAddForm"),
  mcpUrlInput: document.querySelector("#mcpUrlInput"),
  connectMcpButton: document.querySelector("#connectMcpButton"),
  mcpStatus: document.querySelector("#mcpStatus"),
  mcpToolAlert: document.querySelector("#mcpToolAlert"),
  mcpToolAlertMessage: document.querySelector("#mcpToolAlertMessage"),
  dismissMcpToolAlertButton: document.querySelector("#dismissMcpToolAlertButton"),
  mcpConnectorCatalog: document.querySelector("#mcpConnectorCatalog"),
  mcpConnectorList: document.querySelector("#mcpConnectorList"),
  mcpConnectorModal: document.querySelector("#mcpConnectorModal"),
  mcpConnectorModalForm: document.querySelector("#mcpConnectorModalForm"),
  mcpConnectorModalFields: document.querySelector("#mcpConnectorModalFields"),
  mcpConnectorModalStatus: document.querySelector("#mcpConnectorModalStatus"),
  cancelConnectorModalButton: document.querySelector("#cancelConnectorModalButton"),
  confirmConnectorButton: document.querySelector("#confirmConnectorButton"),
  settingsShell: document.querySelector(".settings-shell"),
  mcpToolsView: document.querySelector("#mcpToolsView"),
  backToMcpServersButton: document.querySelector("#backToMcpServersButton"),
  mcpToolsViewTitle: document.querySelector("#mcpToolsViewTitle"),
  mcpToolsViewSubtitle: document.querySelector("#mcpToolsViewSubtitle"),
  mcpBulkPermissionOptions: document.querySelector("#mcpBulkPermissionOptions"),
  mcpToolPermissionList: document.querySelector("#mcpToolPermissionList"),
  mcpServerCount: document.querySelector("#mcpServerCount"),
  mcpEmptyState: document.querySelector("#mcpEmptyState"),
  mcpServerList: document.querySelector("#mcpServerList"),
};

const voicePreview = createVoicePreviewController({
  apiKeyInput: elements.apiKeyInput,
  voiceInput: elements.voiceInput,
  previewButton: elements.previewVoiceButton,
  statusElement: elements.saveNote,
});

function sendRuntime(command, payload = {}) {
  return chrome.runtime.sendMessage({ type: MESSAGE_TYPE, command, ...payload }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "The Lumi extension did not respond.");
    return response.result;
  });
}

const mcpSettings = createMcpSettingsController({
  elements,
  sendRuntime,
  MCP_DISABLED_TOOLS_STORAGE_KEY,
  MCP_TOOL_POLICIES_STORAGE_KEY,
});

async function queryMicrophonePermission() {
  try {
    const permission = await navigator.permissions.query({ name: "microphone" });
    return permission.state;
  } catch {
    return "prompt";
  }
}

async function refreshMicrophonePermission() {
  const state = await queryMicrophonePermission();
  elements.microphonePermissionStatus.dataset.state = state;
  elements.enableMicrophoneButton.dataset.state = state;
  if (state === "granted") {
    elements.microphonePermissionStatus.textContent = "Allowed for Lumi Live";
    elements.enableMicrophoneButton.textContent = "Allowed";
    elements.enableMicrophoneButton.disabled = true;
  } else if (state === "denied") {
    elements.microphonePermissionStatus.textContent = "Blocked in Chrome";
    elements.enableMicrophoneButton.textContent = "Fix access";
    elements.enableMicrophoneButton.disabled = false;
  } else {
    elements.microphonePermissionStatus.textContent = "Chrome will ask once";
    elements.enableMicrophoneButton.textContent = "Enable";
    elements.enableMicrophoneButton.disabled = false;
  }
}

async function openMicrophonePermissionPage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("settings/microphone-permission.html"), active: true });
}

async function saveSettings() {
  const apiKey = elements.apiKeyInput.value.trim();
  if (!apiKey) {
    elements.saveNote.dataset.state = "error";
    elements.saveNote.textContent = "Enter a Gemini API key before saving.";
    elements.apiKeyInput.focus();
    return;
  }
  await chrome.storage.local.set({
    [API_KEY_STORAGE_KEY]: apiKey,
    [VOICE_STORAGE_KEY]: elements.voiceInput.value || DEFAULT_VOICE_NAME,
  });
  elements.saveNote.dataset.state = "saved";
  elements.saveNote.textContent = `Saved. Lumi will use ${elements.voiceInput.value} for the next voice session.`;
}

async function saveVisualPreference() {
  const showElementHighlights = elements.showElementHighlightsInput.checked;
  await sendRuntime("set_visual_preferences", { showElementHighlights });
}

function normalizeQcServiceUrl(value) {
  const url = new URL(String(value || QC_DEFAULT_SERVICE_URL).trim());
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("QC Service must use http://127.0.0.1 or http://localhost.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function saveQcSettings({ showConfirmation = true } = {}) {
  try {
    const serviceUrl = normalizeQcServiceUrl(elements.qcServiceUrlInput.value);
    const token = elements.qcServiceTokenInput.value.trim();
    if (!token) throw new Error("Enter the Local QC Service installation token.");
    const domains = elements.qcAllowedDomainsInput.value
      .split(/[\s,;]+/)
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean)
      .filter((domain, index, values) => values.indexOf(domain) === index)
      .join(", ");
    if (!domains) throw new Error("Enter at least one allowed ERP domain.");
    elements.qcServiceUrlInput.value = serviceUrl;
    elements.qcAllowedDomainsInput.value = domains;
    await chrome.storage.local.set({
      [STORAGE_KEYS.qcServiceUrl]: serviceUrl,
      [STORAGE_KEYS.qcServiceToken]: token,
      [STORAGE_KEYS.qcAllowedDomains]: domains,
      [STORAGE_KEYS.qcDiscoveryEnabled]: elements.qcDiscoveryModeInput.checked,
    });
    if (showConfirmation) {
      elements.qcSettingsNote.dataset.state = "saved";
      elements.qcSettingsNote.textContent =
        "QC settings saved. Attach an .xlsx workbook in Lumi chat to create a Run Plan.";
    }
    return { serviceUrl, token };
  } catch (error) {
    elements.qcSettingsNote.dataset.state = "error";
    elements.qcSettingsNote.textContent =
      error instanceof Error ? error.message : "Could not save QC settings.";
    throw error;
  }
}

async function testQcService() {
  elements.qcTestServiceButton.disabled = true;
  elements.qcSettingsNote.dataset.state = "";
  elements.qcSettingsNote.textContent = "Checking Local QC Service…";
  try {
    const { serviceUrl } = await saveQcSettings({ showConfirmation: false });
    const response = await fetch(`${serviceUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`QC Service returned HTTP ${response.status}.`);
    const health = await response.json();
    elements.qcSettingsNote.dataset.state = "saved";
    elements.qcSettingsNote.textContent =
      `Local QC Service ${health.version || ""} is ready.`.replace(/\s+\./, ".");
  } catch (error) {
    elements.qcSettingsNote.dataset.state = "error";
    elements.qcSettingsNote.textContent =
      error instanceof Error ? error.message : "Local QC Service is unavailable.";
  } finally {
    elements.qcTestServiceButton.disabled = false;
  }
}

elements.toggleKeyButton.addEventListener("click", () => {
  const shouldShow = elements.apiKeyInput.type === "password";
  elements.apiKeyInput.type = shouldShow ? "text" : "password";
  elements.toggleKeyButton.textContent = shouldShow ? "Hide" : "Show";
});
elements.saveSettingsButton.addEventListener("click", () => void saveSettings());
elements.previewVoiceButton.addEventListener("click", () => void voicePreview.toggle());
elements.voiceInput.addEventListener("change", () => {
  const profile = VOICE_PROFILES.find(([name]) => name === elements.voiceInput.value) || VOICE_PROFILES[0];
  voicePreview.stop(`${profile[0]} selected · ${profile[1]} · ${profile[2]}`);
  voicePreview.updateVoiceProfiles();
  if (!voicePreview.isActive()) {
    elements.saveNote.dataset.state = "";
    elements.saveNote.textContent = `${profile[0]} selected · ${profile[1]} · ${profile[2]}`;
  }
});
elements.enableMicrophoneButton.addEventListener("click", () => void openMicrophonePermissionPage());
elements.showElementHighlightsInput.addEventListener("change", () => {
  void saveVisualPreference().catch((error) => {
    elements.saveNote.dataset.state = "error";
    elements.saveNote.textContent = error instanceof Error ? error.message : "Could not update PageAgent guides.";
  });
});
elements.qcSaveSettingsButton.addEventListener("click", () => {
  void saveQcSettings().catch(() => {});
});
elements.qcTestServiceButton.addEventListener("click", () => void testQcService());
window.addEventListener("focus", () => void refreshMicrophonePermission());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshMicrophonePermission();
});
window.addEventListener("unload", () => voicePreview.stop());
async function initialize() {
  const manifest = chrome.runtime.getManifest();
  elements.extensionVersion.textContent = `v${manifest.version}`;
  const stored = await chrome.storage.local.get([
    API_KEY_STORAGE_KEY,
    VOICE_STORAGE_KEY,
    ELEMENT_HIGHLIGHTS_STORAGE_KEY,
    STORAGE_KEYS.qcServiceUrl,
    STORAGE_KEYS.qcServiceToken,
    STORAGE_KEYS.qcAllowedDomains,
    STORAGE_KEYS.qcDiscoveryEnabled,
  ]);
  elements.apiKeyInput.value = String(stored[API_KEY_STORAGE_KEY] || "");
  elements.voiceInput.value = String(stored[VOICE_STORAGE_KEY] || DEFAULT_VOICE_NAME);
  voicePreview.updateVoiceProfiles();
  elements.showElementHighlightsInput.checked = stored[ELEMENT_HIGHLIGHTS_STORAGE_KEY] === true;
  elements.qcServiceUrlInput.value =
    String(stored[STORAGE_KEYS.qcServiceUrl] || QC_DEFAULT_SERVICE_URL);
  elements.qcServiceTokenInput.value =
    String(stored[STORAGE_KEYS.qcServiceToken] || "");
  elements.qcAllowedDomainsInput.value =
    String(stored[STORAGE_KEYS.qcAllowedDomains] || QC_DEFAULT_ALLOWED_DOMAINS);
  elements.qcDiscoveryModeInput.checked =
    stored[STORAGE_KEYS.qcDiscoveryEnabled] === true;
  elements.connectMcpButton.disabled = true;
  await Promise.all([
    refreshMicrophonePermission(),
    mcpSettings.load(true).catch((error) => {
      mcpSettings.showAddForm(true);
      mcpSettings.setStatus("error", error instanceof Error ? error.message : "Could not load MCP servers.");
    }),
  ]);
}

void initialize();
