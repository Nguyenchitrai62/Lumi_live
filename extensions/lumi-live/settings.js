import { EXTENSION_EVENTS, STORAGE_KEYS } from "./extension-config.js";

const MESSAGE_TYPE = EXTENSION_EVENTS.request;
const API_KEY_STORAGE_KEY = STORAGE_KEYS.apiKey;
const VOICE_STORAGE_KEY = STORAGE_KEYS.voice;
const ELEMENT_HIGHLIGHTS_STORAGE_KEY = STORAGE_KEYS.elementHighlights;
const MCP_DISABLED_TOOLS_STORAGE_KEY = STORAGE_KEYS.mcpDisabledTools;
const MCP_TOOL_POLICIES_STORAGE_KEY = STORAGE_KEYS.mcpToolPolicies;
const MODEL = "gemini-3.1-flash-live-preview";
const DIRECT_WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const VOICE_PROFILES = [
  ["Zephyr", "Female", "Bright"], ["Puck", "Male", "Upbeat"], ["Charon", "Male", "Informative"],
  ["Kore", "Female", "Firm"], ["Fenrir", "Male", "Excitable"], ["Leda", "Female", "Youthful"],
  ["Orus", "Male", "Firm"], ["Aoede", "Female", "Breezy"], ["Callirrhoe", "Female", "Easy-going"],
  ["Autonoe", "Female", "Bright"], ["Enceladus", "Male", "Breathy"], ["Iapetus", "Male", "Clear"],
  ["Umbriel", "Male", "Easy-going"], ["Algieba", "Male", "Smooth"], ["Despina", "Female", "Smooth"],
  ["Erinome", "Female", "Clear"], ["Algenib", "Male", "Gravelly"], ["Rasalgethi", "Male", "Informative"],
  ["Laomedeia", "Female", "Upbeat"], ["Achernar", "Female", "Soft"], ["Alnilam", "Male", "Firm"],
  ["Schedar", "Male", "Even"], ["Gacrux", "Female", "Mature"], ["Pulcherrima", "Female", "Forward"],
  ["Achird", "Male", "Friendly"], ["Zubenelgenubi", "Male", "Casual"], ["Vindemiatrix", "Female", "Gentle"],
  ["Sadachbia", "Male", "Lively"], ["Sadaltager", "Male", "Knowledgeable"], ["Sulafat", "Female", "Warm"],
];

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
  showAddMcpButton: document.querySelector("#showAddMcpButton"),
  cancelAddMcpButton: document.querySelector("#cancelAddMcpButton"),
  mcpAddForm: document.querySelector("#mcpAddForm"),
  mcpUrlInput: document.querySelector("#mcpUrlInput"),
  connectMcpButton: document.querySelector("#connectMcpButton"),
  mcpStatus: document.querySelector("#mcpStatus"),
  mcpToolAlert: document.querySelector("#mcpToolAlert"),
  mcpToolAlertMessage: document.querySelector("#mcpToolAlertMessage"),
  dismissMcpToolAlertButton: document.querySelector("#dismissMcpToolAlertButton"),
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

let activeVoicePreview = null;
let mcpServers = [];
let selectedMcpServerId = null;
let currentMcpToolAlertSignature = "";
let dismissedMcpToolAlertSignature = "";

const MCP_PERMISSION_OPTIONS = [
  { mode: "allow", label: "Always allow", icon: "\u2713" },
  { mode: "ask", label: "Ask every time", icon: "?" },
  { mode: "block", label: "Block", icon: "\u00d7" },
];

function updateVoiceProfile() {
  for (const option of elements.voiceInput.options) {
    const optionProfile = VOICE_PROFILES.find(([name]) => name === option.value);
    if (optionProfile) option.textContent = `${optionProfile[0]} · ${optionProfile[1]} · ${optionProfile[2]}`;
  }
}

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer);
}

function stopVoicePreview(message = "Voice preview stopped.") {
  const preview = activeVoicePreview;
  if (!preview) return false;
  activeVoicePreview = null;
  preview.cancelled = true;
  preview.finish?.(new DOMException("Voice preview stopped.", "AbortError"));
  for (const source of preview.sources) {
    try { source.stop(); } catch { /* Source may already be stopped. */ }
  }
  preview.sources.clear();
  preview.websocket?.close();
  void preview.audioContext.close().catch(() => {});
  elements.previewVoiceButton.dataset.state = "";
  elements.previewVoiceButton.textContent = "▶ Test voice";
  elements.saveNote.dataset.state = "";
  elements.saveNote.textContent = message;
  return true;
}

async function previewVoice() {
  if (stopVoicePreview()) return;

  const apiKey = elements.apiKeyInput.value.trim();
  if (!apiKey) {
    elements.saveNote.dataset.state = "error";
    elements.saveNote.textContent = "Enter a Gemini API key to test this voice.";
    elements.apiKeyInput.focus();
    return;
  }

  const voiceName = elements.voiceInput.value || "Zephyr";
  const audioContext = new AudioContext();
  const preview = {
    audioContext,
    websocket: null,
    sources: new Set(),
    finish: null,
    cancelled: false,
  };
  activeVoicePreview = preview;
  await audioContext.resume();
  if (preview.cancelled) return;

  let nextPlaybackTime = audioContext.currentTime;
  let receivedAudio = false;
  let turnComplete = false;

  elements.previewVoiceButton.dataset.state = "playing";
  elements.previewVoiceButton.textContent = "■ Stop preview";
  elements.saveNote.dataset.state = "";
  elements.saveNote.textContent = `Preparing a short English ${voiceName} preview…`;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => finish(new Error("Voice preview timed out. Try again.")), 18000);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (error) reject(error);
        else resolve();
      };
      preview.finish = finish;

      const websocket = new WebSocket(`${DIRECT_WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`);
      preview.websocket = websocket;
      websocket.onopen = () => {
        websocket.send(JSON.stringify({
          setup: {
            model: `models/${MODEL}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            },
            systemInstruction: {
              parts: [{ text: "You are a voice preview. Read the requested English sentence naturally and do not add any other words." }],
            },
          },
        }));
      };

      websocket.onmessage = async (event) => {
        if (preview.cancelled) return;
        const raw = typeof event.data === "string" ? event.data : await event.data.text();
        const response = JSON.parse(raw);
        if (response.setupComplete) {
          websocket.send(JSON.stringify({
            realtimeInput: { text: "Have a wonderful day!" },
          }));
        }

        const parts = response.serverContent?.modelTurn?.parts ?? [];
        for (const part of parts) {
          if (!part.inlineData?.data || preview.cancelled) continue;
          receivedAudio = true;
          const pcm = base64ToInt16(part.inlineData.data);
          const floats = new Float32Array(pcm.length);
          for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index] / 32768;
          const buffer = audioContext.createBuffer(1, floats.length, 24000);
          buffer.copyToChannel(floats, 0);
          const source = audioContext.createBufferSource();
          source.buffer = buffer;
          source.connect(audioContext.destination);
          preview.sources.add(source);
          source.addEventListener("ended", () => preview.sources.delete(source), { once: true });
          const startAt = Math.max(audioContext.currentTime + 0.025, nextPlaybackTime);
          nextPlaybackTime = startAt + buffer.duration;
          source.start(startAt);
        }

        if (response.serverContent?.turnComplete) {
          turnComplete = true;
          websocket.close(1000, "Preview complete");
          const remainingMs = Math.max(0, (nextPlaybackTime - audioContext.currentTime) * 1000);
          setTimeout(() => finish(receivedAudio ? null : new Error("Gemini returned no preview audio.")), remainingMs + 80);
        }
      };
      websocket.onerror = () => finish(new Error("Could not connect to Gemini Live. Check the API key."));
      websocket.onclose = () => {
        if (!turnComplete && !preview.cancelled) finish(new Error("Gemini Live ended before the preview was ready."));
      };
    });
    if (!preview.cancelled) {
      elements.saveNote.dataset.state = "saved";
      elements.saveNote.textContent = `${voiceName} preview finished. Save when this voice feels right.`;
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      elements.saveNote.dataset.state = "error";
      elements.saveNote.textContent = error instanceof Error ? error.message : "Could not play the voice preview.";
    }
  } finally {
    if (activeVoicePreview === preview) {
      activeVoicePreview = null;
      for (const source of preview.sources) {
        try { source.stop(); } catch { /* Source may already be stopped. */ }
      }
      preview.websocket?.close();
      await audioContext.close().catch(() => {});
      elements.previewVoiceButton.dataset.state = "";
      elements.previewVoiceButton.textContent = "▶ Test voice";
    }
  }
}

function sendRuntime(command, payload = {}) {
  return chrome.runtime.sendMessage({ type: MESSAGE_TYPE, command, ...payload }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "The Lumi extension did not respond.");
    return response.result;
  });
}

function setMcpStatus(state, message) {
  elements.mcpStatus.dataset.state = state;
  elements.mcpStatus.textContent = message;
}

function toggleMcpAddForm(shouldOpen) {
  elements.mcpAddForm.hidden = !shouldOpen;
  elements.showAddMcpButton.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) {
    requestAnimationFrame(() => elements.mcpUrlInput.focus());
    return;
  }
  elements.mcpUrlInput.value = "";
  elements.connectMcpButton.disabled = true;
  elements.connectMcpButton.dataset.busy = "";
  elements.connectMcpButton.textContent = "Connect server";
  setMcpStatus("", "");
}

function createMcpMeta(text, className = "") {
  const item = document.createElement("span");
  item.className = className;
  item.textContent = text;
  return item;
}

function getMcpServerUiState(server) {
  if (server.error || server.uiError) return "error";
  if ((server.tools || []).some((tool) => !tool.gemini?.enabled)) return "warning";
  return "connected";
}

function updateMcpToolAlert() {
  const disabledTools = mcpServers.flatMap((server) =>
    (server.tools || [])
      .filter((tool) => !tool.gemini?.enabled)
      .map((tool) => ({ server, tool })));
  currentMcpToolAlertSignature = disabledTools
    .map(({ server, tool }) => `${server.id}:${tool.name}:${tool.gemini?.errors?.join(" ") || "disabled"}`)
    .sort()
    .join("|");
  if (!disabledTools.length) dismissedMcpToolAlertSignature = "";
  const shouldShow = disabledTools.length > 0
    && currentMcpToolAlertSignature !== dismissedMcpToolAlertSignature;
  elements.mcpToolAlert.hidden = !shouldShow;
  if (!shouldShow) return;
  const schemaErrorCount = disabledTools.filter(({ tool }) => !tool.gemini?.schemaCompatible).length;
  elements.mcpToolAlertMessage.textContent = schemaErrorCount
    ? `${disabledTools.length} tool(s) are disabled; ${schemaErrorCount} have schemas Gemini cannot use. Voice, chat, and the other tools remain available.`
    : `${disabledTools.length} tool(s) are currently disabled. Voice, chat, and the other tools remain available.`;
}

function normalizeMcpPermission(mode) {
  return ["block", "allow", "ask"].includes(mode) ? mode : "allow";
}

function createMcpPermissionButton(serverId, toolName, option, selected) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mcp-permission-icon";
  button.dataset.mode = option.mode;
  button.dataset.action = "set-tool-policy";
  button.dataset.serverId = serverId;
  button.dataset.toolName = toolName;
  button.textContent = option.icon;
  button.title = option.label;
  button.setAttribute("aria-label", `${option.label} for ${toolName}`);
  button.setAttribute("aria-pressed", String(selected));
  return button;
}

function renderMcpToolsView() {
  const server = mcpServers.find((item) => item.id === selectedMcpServerId);
  if (!server) {
    selectedMcpServerId = null;
    document.body.classList.remove("is-mcp-tools-view");
    elements.settingsShell.inert = false;
    elements.mcpToolsView.inert = true;
    elements.mcpToolsView.setAttribute("aria-hidden", "true");
    elements.mcpBulkPermissionOptions.replaceChildren();
    elements.mcpToolPermissionList.replaceChildren();
    return;
  }

  const tools = Array.isArray(server.tools) ? server.tools : [];
  elements.mcpToolsViewTitle.textContent = server.serverName || "MCP server";
  elements.mcpToolsViewSubtitle.textContent = `${tools.length} ${tools.length === 1 ? "tool" : "tools"} · Choose what Lumi may use.`;

  const permissions = new Set(tools.map((tool) => normalizeMcpPermission(tool.permission)));
  const aggregateMode = permissions.size === 1 ? [...permissions][0] : "custom";
  const bulkOptions = [
    ...MCP_PERMISSION_OPTIONS,
    { mode: "custom", label: "Custom", icon: "◐" },
  ];
  const bulkButtons = bulkOptions.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mcp-bulk-option";
    button.dataset.mode = option.mode;
    if (option.mode !== "custom") button.dataset.action = "set-all-tool-policies";
    button.disabled = option.mode === "custom";
    button.setAttribute("aria-pressed", String(aggregateMode === option.mode));
    button.title = option.mode === "custom"
      ? "Tools use a mix of permissions"
      : `Set all tools to ${option.label}`;
    const icon = document.createElement("span");
    icon.className = "mcp-bulk-option-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = option.icon;
    const label = document.createElement("span");
    label.textContent = option.label;
    button.append(icon, label);
    return button;
  });
  elements.mcpBulkPermissionOptions.replaceChildren(...bulkButtons);

  const rows = tools.map((tool) => {
    const permission = normalizeMcpPermission(tool.permission);
    const row = document.createElement("article");
    row.className = "mcp-permission-row";
    row.dataset.state = tool.gemini?.enabled === true ? permission : "disabled";
    row.setAttribute("role", "listitem");

    const copy = document.createElement("div");
    copy.className = "mcp-permission-copy";
    const name = document.createElement("code");
    name.textContent = tool.name || "Unnamed tool";
    copy.append(name);
    if (tool.description) {
      const description = document.createElement("p");
      description.className = "mcp-tool-description";
      description.textContent = tool.description;
      copy.append(description);
    }
    const errors = Array.isArray(tool.gemini?.errors) ? tool.gemini.errors : [];
    if (errors.length) {
      const warning = document.createElement("p");
      warning.className = "mcp-tool-warning";
      warning.textContent = errors.join(" ");
      copy.append(warning);
    }
    const controls = document.createElement("div");
    controls.className = "mcp-permission-icons";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", `Permission for ${tool.name || "unnamed tool"}`);
    for (const option of MCP_PERMISSION_OPTIONS) {
      controls.append(createMcpPermissionButton(server.id, tool.name, option, permission === option.mode));
    }
    row.append(copy, controls);
    return row;
  });

  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "mcp-tools-empty";
    empty.textContent = "This server did not publish any tools.";
    rows.push(empty);
  }
  elements.mcpToolPermissionList.replaceChildren(...rows);
}

function openMcpToolsView(serverId) {
  if (!mcpServers.some((server) => server.id === serverId)) return;
  selectedMcpServerId = serverId;
  renderMcpToolsView();
  elements.mcpToolsView.scrollTop = 0;
  document.body.classList.add("is-mcp-tools-view");
  elements.settingsShell.inert = true;
  elements.mcpToolsView.inert = false;
  elements.backToMcpServersButton.disabled = false;
  elements.mcpToolsView.setAttribute("aria-hidden", "false");
  window.setTimeout(() => elements.backToMcpServersButton.focus(), 260);
}

function closeMcpToolsView() {
  const previousServerId = selectedMcpServerId;
  selectedMcpServerId = null;
  document.body.classList.remove("is-mcp-tools-view");
  elements.settingsShell.inert = false;
  elements.mcpToolsView.inert = true;
  elements.mcpToolsView.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    const serverRow = previousServerId
      ? elements.mcpServerList.querySelector(`[data-server-id="${CSS.escape(previousServerId)}"]`)
      : null;
    serverRow?.focus();
  }, 260);
}

function renderMcpServers() {
  const count = mcpServers.length;
  const toolCount = mcpServers.reduce((total, server) => total + (Number(server.toolCount) || 0), 0);
  elements.mcpServerCount.textContent = `${count} ${count === 1 ? "server" : "servers"} · ${toolCount} tools`;
  elements.mcpEmptyState.hidden = count > 0;
  elements.mcpServerList.replaceChildren();

  for (const server of mcpServers) {
    const item = document.createElement("article");
    const state = server.uiState || getMcpServerUiState(server);
    item.className = "mcp-server";
    item.dataset.serverId = server.id;
    item.dataset.state = state;
    item.setAttribute("role", "listitem");
    item.tabIndex = 0;
    item.setAttribute("aria-label", `Open tool permissions for ${server.serverName || "MCP server"}`);

    const icon = document.createElement("span");
    icon.className = "mcp-server-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "MCP";

    const main = document.createElement("div");
    main.className = "mcp-server-main";
    const title = document.createElement("div");
    title.className = "mcp-server-title";
    const name = document.createElement("strong");
    name.textContent = server.serverName || "MCP server";
    const status = document.createElement("span");
    status.className = "mcp-server-status";
    status.textContent = state === "connected"
      ? "Connected"
      : state === "warning" ? "Tool warning" : state === "error" ? "Error" : "Saved";
    title.append(name, status);

    const url = document.createElement("code");
    url.className = "mcp-server-url";
    url.title = server.url;
    url.textContent = server.url;

    const metadata = document.createElement("div");
    metadata.className = "mcp-server-meta";
    const tools = Array.isArray(server.tools) ? server.tools : [];
    const enabledToolCount = tools.filter((tool) => tool.gemini?.enabled).length;
    const disabledToolCount = tools.filter((tool) => !tool.gemini?.enabled).length;
    const blockedToolCount = tools.filter((tool) => tool.permission === "block").length;
    metadata.append(createMcpMeta(`${Number(server.toolCount) || 0} tools`, "mcp-meta-count"));
    if (tools.length) metadata.append(createMcpMeta(`${enabledToolCount} available`, "mcp-meta-available"));
    if (blockedToolCount) metadata.append(createMcpMeta(`${blockedToolCount} blocked`, "mcp-meta-warning"));
    if (disabledToolCount) metadata.append(createMcpMeta(`${disabledToolCount} unavailable`, "mcp-meta-warning"));

    const error = document.createElement("p");
    error.className = "mcp-server-error";
    error.hidden = !server.uiError;
    error.textContent = server.uiError || "";
    const permissionHint = document.createElement("span");
    permissionHint.className = "mcp-server-permission-hint";
    permissionHint.textContent = "Tool permissions \u2192";
    main.append(title, url, metadata, error, permissionHint);

    const actions = document.createElement("div");
    actions.className = "mcp-server-actions";
    const reconnect = document.createElement("button");
    reconnect.type = "button";
    reconnect.dataset.action = "reconnect";
    reconnect.dataset.serverId = server.id;
    reconnect.textContent = "Reconnect";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.dataset.action = "remove";
    remove.dataset.serverId = server.id;
    remove.textContent = "Remove";
    actions.append(reconnect, remove);
    item.append(icon, main, actions);
    elements.mcpServerList.append(item);
  }
  updateMcpToolAlert();
  renderMcpToolsView();
}

function setMcpServerUiState(serverId, state, error = "") {
  const server = mcpServers.find((candidate) => candidate.id === serverId);
  if (!server) return;
  server.uiState = state;
  server.uiError = error;
  renderMcpServers();
  const row = elements.mcpServerList.querySelector(`[data-server-id="${CSS.escape(serverId)}"]`);
  for (const button of row?.querySelectorAll("button") || []) button.disabled = state === "connecting";
  if (state === "connecting") row.querySelector(".mcp-server-status").textContent = "Connecting";
}

async function connectMcp(event) {
  event.preventDefault();
  const url = elements.mcpUrlInput.value.trim();
  if (!url) {
    setMcpStatus("error", "Enter an MCP server URL before connecting.");
    elements.mcpUrlInput.focus();
    return;
  }

  elements.connectMcpButton.disabled = true;
  elements.connectMcpButton.dataset.busy = "true";
  elements.connectMcpButton.textContent = "Connecting...";
  setMcpStatus("", "Running the MCP handshake and loading tools...");
  try {
    const result = await sendRuntime("mcp_add_server", { url });
    const server = { ...result, uiError: "" };
    server.uiState = getMcpServerUiState(server);
    mcpServers.push(server);
    renderMcpServers();
    toggleMcpAddForm(false);
  } catch (error) {
    setMcpStatus("error", error instanceof Error ? error.message : "Could not connect to the MCP server.");
  } finally {
    elements.connectMcpButton.dataset.busy = "";
    elements.connectMcpButton.textContent = "Connect server";
    elements.connectMcpButton.disabled = !elements.mcpUrlInput.value.trim();
  }
}

async function reconnectMcp(serverId) {
  setMcpServerUiState(serverId, "connecting");
  try {
    const result = await sendRuntime("mcp_reconnect_server", { serverId });
    const index = mcpServers.findIndex((server) => server.id === serverId);
    if (index >= 0) {
      const server = { ...result, uiError: "" };
      server.uiState = getMcpServerUiState(server);
      mcpServers[index] = server;
    }
    renderMcpServers();
  } catch (error) {
    setMcpServerUiState(
      serverId,
      "error",
      error instanceof Error ? error.message : "Could not reconnect to this MCP server.",
    );
  }
}

async function removeMcp(serverId) {
  setMcpServerUiState(serverId, "connecting");
  try {
    await sendRuntime("mcp_remove_server", { serverId });
    mcpServers = mcpServers.filter((server) => server.id !== serverId);
    renderMcpServers();
  } catch (error) {
    setMcpServerUiState(
      serverId,
      "error",
      error instanceof Error ? error.message : "Could not remove this MCP server.",
    );
  }
}

async function setMcpToolPolicy(serverId, toolName, mode, control) {
  control.disabled = true;
  try {
    await sendRuntime("mcp_set_tool_policy", { serverId, tool: toolName, mode });
    const server = mcpServers.find((item) => item.id === serverId);
    const tool = server?.tools?.find((item) => item.name === toolName);
    if (tool) tool.permission = mode;
    renderMcpServers();
  } catch (error) {
    setMcpServerUiState(
      serverId,
      "error",
      error instanceof Error ? error.message : "Could not update this MCP tool permission.",
    );
  } finally {
    control.disabled = false;
  }
}

async function setAllMcpToolPolicies(serverId, mode, control) {
  const controls = [...elements.mcpToolsView.querySelectorAll("button[data-action]")];
  for (const button of controls) button.disabled = true;
  try {
    await sendRuntime("mcp_set_server_tool_policy", { serverId, mode });
    const server = mcpServers.find((item) => item.id === serverId);
    for (const tool of server?.tools || []) tool.permission = mode;
    renderMcpServers();
  } catch (error) {
    setMcpServerUiState(
      serverId,
      "error",
      error instanceof Error ? error.message : "Could not update all MCP tool permissions.",
    );
  } finally {
    for (const button of controls) button.disabled = false;
    control.disabled = false;
  }
}

async function loadMcpServers(refresh = false) {
  const result = await sendRuntime(refresh ? "mcp_get_tools" : "mcp_inspect_tools");
  mcpServers = (result.servers || []).map((server) => {
    const item = { ...server, uiError: server.error || "" };
    item.uiState = getMcpServerUiState(item);
    return item;
  });
  renderMcpServers();
}

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
  await chrome.tabs.create({ url: chrome.runtime.getURL("microphone-permission.html"), active: true });
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
    [VOICE_STORAGE_KEY]: elements.voiceInput.value || "Zephyr",
  });
  elements.saveNote.dataset.state = "saved";
  elements.saveNote.textContent = `Saved. Lumi will use ${elements.voiceInput.value} for the next voice session.`;
}

async function saveVisualPreference() {
  const showElementHighlights = elements.showElementHighlightsInput.checked;
  await chrome.storage.local.set({ [ELEMENT_HIGHLIGHTS_STORAGE_KEY]: showElementHighlights });
  await sendRuntime("set_visual_preferences", { showElementHighlights });
}

elements.toggleKeyButton.addEventListener("click", () => {
  const shouldShow = elements.apiKeyInput.type === "password";
  elements.apiKeyInput.type = shouldShow ? "text" : "password";
  elements.toggleKeyButton.textContent = shouldShow ? "Hide" : "Show";
});
elements.saveSettingsButton.addEventListener("click", () => void saveSettings());
elements.previewVoiceButton.addEventListener("click", () => void previewVoice());
elements.voiceInput.addEventListener("change", () => {
  const profile = VOICE_PROFILES.find(([name]) => name === elements.voiceInput.value) || VOICE_PROFILES[0];
  stopVoicePreview(`${profile[0]} selected · ${profile[1]} · ${profile[2]}`);
  updateVoiceProfile();
  if (!activeVoicePreview) {
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
elements.showAddMcpButton.addEventListener("click", () => {
  toggleMcpAddForm(elements.mcpAddForm.hidden);
});
elements.cancelAddMcpButton.addEventListener("click", () => toggleMcpAddForm(false));
elements.mcpUrlInput.addEventListener("input", () => {
  elements.connectMcpButton.disabled = !elements.mcpUrlInput.value.trim()
    || elements.connectMcpButton.dataset.busy === "true";
  if (elements.mcpStatus.dataset.state === "error") setMcpStatus("", "");
});
elements.mcpAddForm.addEventListener("submit", (event) => void connectMcp(event));
elements.mcpServerList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) {
    if (button.disabled) return;
    if (button.dataset.action === "reconnect") void reconnectMcp(button.dataset.serverId);
    if (button.dataset.action === "remove") void removeMcp(button.dataset.serverId);
    return;
  }
  const serverRow = event.target.closest(".mcp-server[data-server-id]");
  if (serverRow) openMcpToolsView(serverRow.dataset.serverId);
});
elements.mcpServerList.addEventListener("keydown", (event) => {
  if (event.target.closest("button")) return;
  const serverRow = event.target.closest(".mcp-server[data-server-id]");
  if (!serverRow || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  openMcpToolsView(serverRow.dataset.serverId);
});
elements.backToMcpServersButton.addEventListener("click", closeMcpToolsView);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && selectedMcpServerId) closeMcpToolsView();
});
elements.mcpToolsView.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  if (button.dataset.action === "set-tool-policy") {
    void setMcpToolPolicy(
      button.dataset.serverId,
      button.dataset.toolName,
      button.dataset.mode,
      button,
    );
  }
  if (button.dataset.action === "set-all-tool-policies") {
    void setAllMcpToolPolicies(selectedMcpServerId, button.dataset.mode, button);
  }
});
elements.dismissMcpToolAlertButton.addEventListener("click", () => {
  dismissedMcpToolAlertSignature = currentMcpToolAlertSignature;
  elements.mcpToolAlert.hidden = true;
});
window.addEventListener("focus", () => void refreshMicrophonePermission());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshMicrophonePermission();
});
window.addEventListener("unload", () => stopVoicePreview());
chrome.storage.onChanged.addListener((changes, areaName) => {
  const disabledToolsChanged = areaName === "session" && changes[MCP_DISABLED_TOOLS_STORAGE_KEY];
  const policiesChanged = areaName === "local" && changes[MCP_TOOL_POLICIES_STORAGE_KEY];
  if (!disabledToolsChanged && !policiesChanged) return;
  void loadMcpServers().catch(() => {});
});

async function initialize() {
  const manifest = chrome.runtime.getManifest();
  elements.extensionVersion.textContent = `v${manifest.version}`;
  const stored = await chrome.storage.local.get([
    API_KEY_STORAGE_KEY,
    VOICE_STORAGE_KEY,
    ELEMENT_HIGHLIGHTS_STORAGE_KEY,
  ]);
  elements.apiKeyInput.value = String(stored[API_KEY_STORAGE_KEY] || "");
  elements.voiceInput.value = String(stored[VOICE_STORAGE_KEY] || "Zephyr");
  updateVoiceProfile();
  elements.showElementHighlightsInput.checked = stored[ELEMENT_HIGHLIGHTS_STORAGE_KEY] === true;
  elements.connectMcpButton.disabled = true;
  await Promise.all([
    refreshMicrophonePermission(),
    loadMcpServers(true).catch((error) => {
      toggleMcpAddForm(true);
      setMcpStatus("error", error instanceof Error ? error.message : "Could not load MCP servers.");
    }),
  ]);
}

void initialize();
