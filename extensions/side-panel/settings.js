const MESSAGE_TYPE = "lumi_sidepanel_request";
const API_KEY_STORAGE_KEY = "lumiGeminiApiKey";
const VOICE_STORAGE_KEY = "lumiGeminiVoice";
const ELEMENT_HIGHLIGHTS_STORAGE_KEY = "lumiShowElementHighlights";
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
  voiceGender: document.querySelector("#voiceGender"),
  voiceStyle: document.querySelector("#voiceStyle"),
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
  mcpServerCount: document.querySelector("#mcpServerCount"),
  mcpEmptyState: document.querySelector("#mcpEmptyState"),
  mcpServerList: document.querySelector("#mcpServerList"),
  mcpNetworkPolicy: document.querySelector("#mcpNetworkPolicy"),
};

let activeVoicePreview = null;
let mcpServers = [];

function updateVoiceProfile() {
  const profile = VOICE_PROFILES.find(([name]) => name === elements.voiceInput.value) || VOICE_PROFILES[0];
  const [, gender, style] = profile;
  elements.voiceGender.className = `voice-tag voice-tag-${gender.toLowerCase()}`;
  elements.voiceGender.textContent = `${gender === "Female" ? "♀" : "♂"} ${gender}`;
  elements.voiceStyle.textContent = style;

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

function createMcpMeta(text) {
  const item = document.createElement("span");
  item.textContent = text;
  return item;
}

function renderMcpServers() {
  const count = mcpServers.length;
  elements.mcpServerCount.textContent = `${count} ${count === 1 ? "server" : "servers"}`;
  elements.mcpEmptyState.hidden = count > 0;
  elements.mcpServerList.replaceChildren();

  for (const server of mcpServers) {
    const item = document.createElement("article");
    const state = server.uiState || "saved";
    item.className = "mcp-server";
    item.dataset.serverId = server.id;
    item.dataset.state = state;
    item.setAttribute("role", "listitem");

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
    status.textContent = state === "connected" ? "Connected" : state === "error" ? "Error" : "Saved";
    title.append(name, status);

    const url = document.createElement("code");
    url.className = "mcp-server-url";
    url.title = server.url;
    url.textContent = server.url;

    const metadata = document.createElement("div");
    metadata.className = "mcp-server-meta";
    metadata.append(createMcpMeta(`${Number(server.toolCount) || 0} tools`));
    if (server.serverVersion) metadata.append(createMcpMeta(`Server v${server.serverVersion}`));
    if (server.protocolVersion) metadata.append(createMcpMeta(`MCP ${server.protocolVersion}`));

    const error = document.createElement("p");
    error.className = "mcp-server-error";
    error.hidden = !server.uiError;
    error.textContent = server.uiError || "";
    main.append(title, url, metadata, error);

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
    mcpServers.push({ ...result, uiState: "connected", uiError: "" });
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
    if (index >= 0) mcpServers[index] = { ...result, uiState: "connected", uiError: "" };
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

async function loadMcpServers() {
  const result = await sendRuntime("mcp_list_servers");
  mcpServers = (result.servers || []).map((server) => ({ ...server, uiState: "saved", uiError: "" }));
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
  if (!button || button.disabled) return;
  if (button.dataset.action === "reconnect") void reconnectMcp(button.dataset.serverId);
  if (button.dataset.action === "remove") void removeMcp(button.dataset.serverId);
});
window.addEventListener("focus", () => void refreshMicrophonePermission());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshMicrophonePermission();
});
window.addEventListener("unload", () => stopVoicePreview());

async function initialize() {
  const manifest = chrome.runtime.getManifest();
  const extensionCsp = manifest.content_security_policy?.extension_pages || "Chrome default";
  elements.extensionVersion.textContent = `v${manifest.version}`;
  elements.mcpNetworkPolicy.textContent = extensionCsp;
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
    loadMcpServers().catch((error) => {
      toggleMcpAddForm(true);
      setMcpStatus("error", error instanceof Error ? error.message : "Could not load MCP servers.");
    }),
  ]);
}

void initialize();
