import {
  createAvatarController,
  normalizeAvatarMode,
} from "./pixel-avatar-controller.js";
import { EXTENSION_EVENTS, STORAGE_KEYS } from "./extension-config.js";
import {
  BROWSER_TOOLS,
  BROWSER_UI_ACTION_TOOLS,
  buildSessionInstruction,
  configureMcpTools,
  findRejectedMcpDeclaration,
  MAX_MCP_TOOL_RESPONSE_CHARS,
  MIC_CAPTURE_PROCESSOR,
  MODEL,
  WS_ENDPOINT,
} from "./live-session-config.js";
import {
  base64ToInt16,
  bytesToBase64,
  floatToPcm16,
  mergeTranscriptText,
  resampleTo16k,
} from "./live-audio-utils.js";
import { createPetalEmitter } from "./petal-emitter.js";
import {
  consumeResponseAudioDirective,
  createTurnAudioGate,
} from "./response-audio-policy.js";

const MESSAGE_TYPE = EXTENSION_EVENTS.request;
const API_KEY_STORAGE_KEY = STORAGE_KEYS.apiKey;
const VOICE_STORAGE_KEY = STORAGE_KEYS.voice;
const MICROPHONE_GRANTED_STORAGE_KEY = STORAGE_KEYS.microphoneGrantedAt;
const PETALS_STORAGE_KEY = STORAGE_KEYS.fallingPetals;
const AVATAR_MODE_STORAGE_KEY = STORAGE_KEYS.avatarMode;
const MCP_TOOL_POLICIES_STORAGE_KEY = STORAGE_KEYS.mcpToolPolicies;
const PANEL_LIFECYCLE_MESSAGE = EXTENSION_EVENTS.lifecycle;
const elements = {
  liveBadge: document.querySelector("#liveBadge"),
  settingsButton: document.querySelector("#settingsButton"),
  avatarModeButton: document.querySelector("#avatarModeButton"),
  petalsButton: document.querySelector("#petalsButton"),
  petalField: document.querySelector(".petal-field"),
  targetCard: document.querySelector(".target-card"),
  targetTitle: document.querySelector("#targetTitle"),
  targetHint: document.querySelector("#targetHint"),
  connectTabButton: document.querySelector("#connectTabButton"),
  transcript: document.querySelector("#transcript"),
  mcpToolNotice: document.querySelector("#mcpToolNotice"),
  mcpToolNoticeTitle: document.querySelector("#mcpToolNoticeTitle"),
  mcpToolNoticeMessage: document.querySelector("#mcpToolNoticeMessage"),
  mcpToolNoticePrimary: document.querySelector("#mcpToolNoticePrimary"),
  mcpToolNoticeSecondary: document.querySelector("#mcpToolNoticeSecondary"),
  mcpToolNoticeTertiary: document.querySelector("#mcpToolNoticeTertiary"),
  vtuberCard: document.querySelector("#vtuberCard"),
  vtuberToggle: document.querySelector("#vtuberToggle"),
  lumiRig: document.querySelector(".lumi-rig"),
  pixelAvatar: document.querySelector("#pixelAvatar"),
  pixelAvatarSprite: document.querySelector("#pixelAvatarSprite"),
  eyesOpen: document.querySelector("#eyesOpen"),
  eyesHalf: document.querySelector("#eyesHalf"),
  eyesClosed: document.querySelector("#eyesClosed"),
  mouthNeutral: document.querySelector("#mouthNeutral"),
  mouthSmall: document.querySelector("#mouthSmall"),
  mouthWide: document.querySelector("#mouthWide"),
  vtuberMood: document.querySelector("#vtuberMood"),
  startButton: document.querySelector("#startButton"),
  muteButton: document.querySelector("#muteButton"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  messageSubmit: document.querySelector("#messageForm button[type='submit']"),
  statusLine: document.querySelector("#statusLine"),
  microphoneHelpButton: document.querySelector("#microphoneHelpButton"),
};

let sessionStatus = "idle";
let intentionalClose = false;
let isMuted = false;
let agentTurnActive = false;
let turnCancellationPending = false;
let turnExecutionSequence = 0;
let turnCancellationDrainTimeoutId = null;
let turnCancellationWatchdogTimeoutId = null;
let turnRuntimeResetPromise = Promise.resolve();
let suppressServerOutputUntilNextUserTurn = false;
let browserToolRunning = false;
let activeMcpTools = new Map();
const cancelledToolCallIds = new Set();
const pendingToolCallIds = new Set();
const pendingToolCallNames = new Map();
const mcpActivityCards = new Map();
const promptedMcpToolFailures = new Set();
const pendingMcpPermissionPrompts = new Map();
const mcpToolNoticeQueue = [];
const mcpToolNoticeKeys = new Set();
let currentMcpToolNotice = null;
let websocket = null;
let audioContext = null;
let analyser = null;
let micStream = null;
let micSource = null;
let micProcessor = null;
let petalsEnabled = true;
let nextPlaybackTime = 0;
let setupTimeoutId = null;
let mouthAnimationId = null;
let blinkTimeoutId = null;
const playbackSources = new Set();
const partialMessages = { user: null, lumi: null };
const responseAudioGate = createTurnAudioGate(() => stopPlayback());

const avatarController = createAvatarController({
  elements: {
    avatarCard: elements.vtuberCard,
    avatarMood: elements.vtuberMood,
    modeButton: elements.avatarModeButton,
    pixelAvatar: elements.pixelAvatar,
    pixelAvatarSprite: elements.pixelAvatarSprite,
    vtuber: elements.lumiRig,
  },
  getSessionState: () => ({ status: sessionStatus, isMuted }),
});
const petalEmitter = createPetalEmitter({
  field: elements.petalField,
  isEnabled: () => petalsEnabled,
});

function sendRuntime(command, payload = {}) {
  return chrome.runtime.sendMessage({
    type: MESSAGE_TYPE,
    command,
    ...payload,
  }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "The Lumi extension did not respond.");
    return response.result;
  });
}

function syncMessageComposer() {
  const ready = sessionStatus === "ready";
  const cancelMode = ready && agentTurnActive;
  elements.messageInput.disabled = !ready || cancelMode || turnCancellationPending;
  elements.messageInput.placeholder = !ready
    ? "Start voice to type a message…"
    : turnCancellationPending ? "Cancelling current action…"
      : cancelMode ? "Lumi is working…" : "Type a message to Lumi…";
  elements.messageSubmit.dataset.mode = cancelMode ? "cancel" : "send";
  elements.messageSubmit.setAttribute("aria-label", cancelMode ? "Cancel current action" : "Send message");
  elements.messageSubmit.title = cancelMode ? "Cancel current action" : "Send message";
  elements.messageSubmit.disabled = !ready
    || turnCancellationPending
    || (!cancelMode && !elements.messageInput.value.trim());
}

function setAgentTurnActive(active) {
  if (active === true && (turnCancellationPending || suppressServerOutputUntilNextUserTurn)) return;
  agentTurnActive = sessionStatus === "ready" && active === true;
  syncMessageComposer();
}

function clearTurnCancellationTimers() {
  clearTimeout(turnCancellationDrainTimeoutId);
  clearTimeout(turnCancellationWatchdogTimeoutId);
  turnCancellationDrainTimeoutId = null;
  turnCancellationWatchdogTimeoutId = null;
}

function rememberCancelledToolCall(callId) {
  if (!callId) return;
  cancelledToolCallIds.add(callId);
  setTimeout(() => cancelledToolCallIds.delete(callId), 60000);
}

function resetPendingTurnExecution(message = "Cancelled by the user.") {
  cancelPendingMcpPermissionPrompts();
  const cancelledResponses = [];
  for (const callId of pendingToolCallIds) {
    rememberCancelledToolCall(callId);
    finishMcpActivity(callId, "cancelled", message);
    const name = pendingToolCallNames.get(callId);
    if (name) {
      cancelledResponses.push({
        id: callId,
        name,
        response: { error: "Cancelled by the user before this tool could finish." },
      });
    }
  }
  pendingToolCallIds.clear();
  pendingToolCallNames.clear();
  browserToolRunning = false;
  stopPlayback();
  responseAudioGate.reset();
  finalizeTranscript("user");
  finalizeTranscript("lumi");
  return cancelledResponses;
}

async function completeTurnCancellation() {
  if (!turnCancellationPending) return;
  await Promise.race([
    turnRuntimeResetPromise,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (!turnCancellationPending) return;
  clearTurnCancellationTimers();
  resetPendingTurnExecution();
  turnCancellationPending = false;
  setAgentTurnActive(false);
  elements.statusLine.textContent = "Current action cancelled and reset. Lumi is ready for your next request.";
  avatarController.syncState();
  syncMessageComposer();
}

function scheduleTurnCancellationCompletion() {
  clearTimeout(turnCancellationDrainTimeoutId);
  turnCancellationDrainTimeoutId = setTimeout(completeTurnCancellation, 120);
}

function setSessionStatus(nextStatus, message) {
  sessionStatus = nextStatus;
  if (nextStatus !== "ready") agentTurnActive = false;
  if (nextStatus !== "ready") turnCancellationPending = false;
  if (nextStatus !== "error") elements.microphoneHelpButton.hidden = true;
  elements.liveBadge.className = `badge badge-${nextStatus === "ready" ? "live" : nextStatus === "connecting" ? "joining" : nextStatus === "error" ? "error" : "offline"}`;
  elements.liveBadge.textContent = nextStatus === "ready" ? "Live" : nextStatus === "connecting" ? "Joining" : nextStatus === "error" ? "Retry" : "Offline";
  elements.statusLine.textContent = message;
  elements.startButton.disabled = nextStatus === "connecting";
  elements.startButton.classList.toggle("live", nextStatus === "ready");
  elements.startButton.querySelector("span:last-child").textContent = nextStatus === "ready" ? "End voice" : nextStatus === "connecting" ? "Connecting…" : "Start voice";
  elements.muteButton.disabled = nextStatus !== "ready";
  syncMessageComposer();
  avatarController.syncState();
}

function clearSetupTimeout() {
  if (setupTimeoutId !== null) {
    clearTimeout(setupTimeoutId);
    setupTimeoutId = null;
  }
}

function describeStartError(error) {
  const name = error && typeof error === "object" ? error.name : "";
  const original = error instanceof Error ? error.message : String(error || "");
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      microphone: true,
      message: "Chrome has not allowed Lumi to use the microphone. Press Enable microphone and follow the permission tab.",
    };
  }
  if (name === "NotFoundError") {
    return { microphone: true, message: "No microphone was found. Connect an input device, then try again." };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return { microphone: true, message: "The microphone is busy or unavailable. Close other apps using it, then retry." };
  }
  return { microphone: false, message: original || "Could not start Gemini Live voice." };
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
  return queryMicrophonePermission();
}

async function openMicrophonePermissionPage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("microphone-permission.html"), active: true });
  elements.microphoneHelpButton.hidden = false;
  setSessionStatus("idle", "A Lumi permission tab opened. Choose Allow there, then return and press Start voice again.");
}

async function validateGeminiApiKey(apiKey) {
  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`,
      { method: "GET", cache: "no-store" },
    );
  } catch {
    throw new Error("Could not reach Google Gemini. Check the network connection and try again.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = data?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini rejected this API key: ${detail}`);
  }
}

function updateTarget(status) {
  const connected = Boolean(status?.connected);
  elements.targetCard.classList.toggle("connected", connected);
  elements.targetTitle.textContent = connected ? status.title || "Active web page" : "No controllable page";
  elements.targetHint.textContent = connected
    ? status.controllerReady === false ? "PageAgent is preparing this page..." : "Auto-following the active Chrome tab."
    : status?.reason || "Switch to a web page and Lumi will follow it.";
  elements.connectTabButton.textContent = connected ? "Auto" : "Waiting";
  elements.connectTabButton.title = connected ? status.url || "Automatically follows the active tab" : "Waiting for an http/https tab";
}

async function refreshTarget() {
  if (browserToolRunning) return;
  try {
    updateTarget(await sendRuntime("get_status"));
  } catch {
    updateTarget({ connected: false });
  }
}

function openSettings() {
  return chrome.runtime.openOptionsPage();
}

function createMessage(role, text) {
  const article = document.createElement("article");
  article.className = `message message-${role}`;
  const author = document.createElement("span");
  author.textContent = role === "lumi" ? "Lumi" : "You";
  const content = document.createElement("p");
  content.textContent = text;
  article.append(author, content);
  elements.transcript.append(article);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
  return { article, content, text };
}

function updateTranscript(role, incoming) {
  const clean = String(incoming || "").trim();
  if (!clean) return;
  if (!partialMessages[role]) partialMessages[role] = createMessage(role, clean);
  else {
    const message = partialMessages[role];
    message.text = mergeTranscriptText(message.text, clean);
    message.content.textContent = message.text;
  }
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
}

function finalizeTranscript(role) {
  partialMessages[role] = null;
}

function sendJson(payload, targetSocket = websocket) {
  if (targetSocket?.readyState !== WebSocket.OPEN) return false;
  targetSocket.send(JSON.stringify(payload));
  return true;
}

function renderCurrentMcpToolNotice() {
  const notice = currentMcpToolNotice;
  elements.mcpToolNotice.hidden = !notice;
  if (!notice) return;
  elements.mcpToolNoticeTitle.textContent = notice.title;
  elements.mcpToolNoticeMessage.textContent = notice.message;
  elements.mcpToolNoticePrimary.textContent = notice.primaryLabel || "OK";
  elements.mcpToolNoticeSecondary.textContent = notice.secondaryLabel || "";
  elements.mcpToolNoticeSecondary.hidden = !notice.secondaryLabel;
  elements.mcpToolNoticeTertiary.textContent = notice.tertiaryLabel || "";
  elements.mcpToolNoticeTertiary.hidden = !notice.tertiaryLabel;
}

function showNextMcpToolNotice() {
  if (currentMcpToolNotice || !mcpToolNoticeQueue.length) return;
  currentMcpToolNotice = mcpToolNoticeQueue.shift();
  renderCurrentMcpToolNotice();
  currentMcpToolNotice.onShow?.();
}

function queueMcpToolNotice(notice) {
  const key = notice.key || `${notice.title}:${notice.message}`;
  if (mcpToolNoticeKeys.has(key)) return;
  mcpToolNoticeKeys.add(key);
  mcpToolNoticeQueue.push({ ...notice, key });
  showNextMcpToolNotice();
}

function dismissCurrentMcpToolNotice() {
  if (currentMcpToolNotice) mcpToolNoticeKeys.delete(currentMcpToolNotice.key);
  currentMcpToolNotice = null;
  renderCurrentMcpToolNotice();
  queueMicrotask(showNextMcpToolNotice);
}

function removeMcpToolNotice(key) {
  if (currentMcpToolNotice?.key === key) {
    mcpToolNoticeKeys.delete(key);
    currentMcpToolNotice = null;
    renderCurrentMcpToolNotice();
    queueMicrotask(showNextMcpToolNotice);
    return;
  }
  const index = mcpToolNoticeQueue.findIndex((notice) => notice.key === key);
  if (index >= 0) mcpToolNoticeQueue.splice(index, 1);
  mcpToolNoticeKeys.delete(key);
}

async function handleMcpToolNoticeAction(action) {
  const notice = currentMcpToolNotice;
  if (!notice) return;
  elements.mcpToolNoticePrimary.disabled = true;
  elements.mcpToolNoticeSecondary.disabled = true;
  elements.mcpToolNoticeTertiary.disabled = true;
  try {
    const callback = action === "primary"
      ? notice.onPrimary
      : action === "secondary" ? notice.onSecondary : notice.onTertiary;
    if (callback) await callback();
    dismissCurrentMcpToolNotice();
  } catch (error) {
    notice.title = "Could not update MCP tool";
    notice.message = error instanceof Error ? error.message : "The tool state could not be changed.";
    notice.primaryLabel = "OK";
    notice.secondaryLabel = "";
    notice.tertiaryLabel = "";
    notice.onPrimary = null;
    notice.onSecondary = null;
    notice.onTertiary = null;
    renderCurrentMcpToolNotice();
  } finally {
    elements.mcpToolNoticePrimary.disabled = false;
    elements.mcpToolNoticeSecondary.disabled = false;
    elements.mcpToolNoticeTertiary.disabled = false;
  }
}

function notifyInvalidMcpSchemas(mcpInfo) {
  for (const server of mcpInfo?.servers || []) {
    if (!server.error) continue;
    queueMcpToolNotice({
      key: `server-connect:${server.id}:${server.error}`,
      title: `MCP server unavailable: ${server.serverName || "MCP server"}`,
      message: `${String(server.error).slice(0, 300)} Its tools were skipped; voice, chat, and tools from other servers will continue normally.`,
      primaryLabel: "OK",
    });
  }
  const invalidTools = (mcpInfo?.servers || []).flatMap((server) =>
    (server.tools || [])
      .filter((tool) => !tool.gemini?.enabled && tool.gemini?.disabledSource === "schema")
      .map((tool) => `${server.serverName || "MCP server"} / ${tool.name || "unnamed tool"}`));
  if (!invalidTools.length) return;
  const visibleNames = invalidTools.slice(0, 3).join(", ");
  const remaining = invalidTools.length > 3 ? ` and ${invalidTools.length - 3} more` : "";
  queueMcpToolNotice({
    key: `invalid-schemas:${invalidTools.join("|")}`,
    title: `${invalidTools.length} incompatible MCP tool${invalidTools.length === 1 ? "" : "s"} disabled`,
    message: `${visibleNames}${remaining} cannot be declared safely to Gemini. Lumi disabled only those tools; voice, chat, and other tools will continue normally.`,
    primaryLabel: "OK",
  });
}

function promptToDisableFailedMcpTool(tool, error) {
  const message = error instanceof Error ? error.message : "MCP tool call failed.";
  if (error?.name === "McpPermissionDeniedError"
    || /temporarily disabled|disabled for the rest of this session|blocked in Lumi Settings|requires user approval/i.test(message)) return;
  const key = `${tool.serverId}\u0000${tool.toolName}`;
  if (promptedMcpToolFailures.has(key)) return;
  promptedMcpToolFailures.add(key);
  queueMcpToolNotice({
    key: `runtime-failure:${key}`,
    title: `MCP tool failed: ${tool.toolName}`,
    message: `${tool.serverName} returned an error: ${message.slice(0, 260)} Block this tool persistently in Settings?`,
    primaryLabel: "Block tool",
    secondaryLabel: "Keep enabled",
    onPrimary: async () => {
      await sendRuntime("mcp_set_tool_policy", {
        serverId: tool.serverId,
        tool: tool.toolName,
        mode: "block",
      });
      tool.permission = "block";
      tool.disabled = true;
    },
  });
}

function requestMcpToolPermission(tool, args, callId) {
  const noticeKey = `tool-permission:${callId}`;
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    const finish = (allowed, fromAction = false) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      pendingMcpPermissionPrompts.delete(noticeKey);
      if (!fromAction) removeMcpToolNotice(noticeKey);
      resolve(allowed);
    };
    pendingMcpPermissionPrompts.set(noticeKey, () => finish(false));
    queueMcpToolNotice({
      key: noticeKey,
      title: `Allow MCP tool: ${tool.toolName}?`,
      message: `${tool.serverName} wants to run this tool with: ${formatMcpActivityValue(args).slice(0, 260)}`,
      primaryLabel: "Allow once",
      secondaryLabel: "Deny",
      tertiaryLabel: "Always allow",
      onShow: () => {
        const activity = mcpActivityCards.get(callId);
        if (activity) {
          activity.root.dataset.state = "waiting";
          activity.status.textContent = "Awaiting approval";
        }
        timeoutId = setTimeout(() => finish(false), 45000);
      },
      onPrimary: () => {
        const activity = mcpActivityCards.get(callId);
        if (activity) {
          activity.root.dataset.state = "running";
          activity.status.textContent = "Running";
        }
        finish(true, true);
      },
      onSecondary: () => finish(false, true),
      onTertiary: async () => {
        await sendRuntime("mcp_set_tool_policy", {
          serverId: tool.serverId,
          tool: tool.toolName,
          mode: "allow",
        });
        tool.permission = "allow";
        const activity = mcpActivityCards.get(callId);
        if (activity) {
          activity.root.dataset.state = "running";
          activity.status.textContent = "Running · Always allowed";
        }
        finish(true, true);
      },
    });
  });
}

function cancelPendingMcpPermissionPrompts() {
  for (const cancel of [...pendingMcpPermissionPrompts.values()]) cancel();
  pendingMcpPermissionPrompts.clear();
}

function applyMcpToolPolicies(records) {
  const policies = new Map((Array.isArray(records) ? records : [])
    .filter((record) => record
      && typeof record.serverId === "string"
      && typeof record.toolName === "string"
      && ["block", "allow", "ask"].includes(record.mode))
    .map((record) => [`${record.serverId}\u0000${record.toolName}`, record.mode]));
  for (const tool of activeMcpTools.values()) {
    tool.permission = policies.get(`${tool.serverId}\u0000${tool.toolName}`) || "allow";
  }
}

async function setupMicrophone(stream) {
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL("pcm-capture-worklet.js"));
  micSource = audioContext.createMediaStreamSource(stream);
  micProcessor = new AudioWorkletNode(audioContext, MIC_CAPTURE_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: "explicit",
  });
  micProcessor.port.onmessage = (event) => {
    if (sessionStatus !== "ready" || isMuted || turnCancellationPending || websocket?.readyState !== WebSocket.OPEN) return;
    const mono = event.data;
    if (suppressServerOutputUntilNextUserTurn) {
      let energy = 0;
      for (const sample of mono) energy += sample * sample;
      if (Math.sqrt(energy / mono.length) < 0.012) return;
      suppressServerOutputUntilNextUserTurn = false;
      finalizeTranscript("user");
      finalizeTranscript("lumi");
    }
    const pcm = floatToPcm16(resampleTo16k(mono, audioContext.sampleRate));
    sendJson({
      realtimeInput: {
        audio: { data: bytesToBase64(pcm), mimeType: "audio/pcm;rate=16000" },
      },
    });
  };
  micSource.connect(micProcessor);
}

function stopPlayback() {
  for (const source of playbackSources) {
    try { source.stop(); } catch { /* Already stopped. */ }
  }
  playbackSources.clear();
  nextPlaybackTime = audioContext?.currentTime || 0;
  setMouthFrame(0);
  if (avatarController.isStateActive("speaking")) avatarController.syncState();
}

function playPcmChunk(base64) {
  if (!audioContext || !analyser) return;
  avatarController.transitionState("speaking");
  const pcm = base64ToInt16(base64);
  const floats = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index] / 32768;
  const buffer = audioContext.createBuffer(1, floats.length, 24000);
  buffer.copyToChannel(floats, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(analyser);
  const startAt = Math.max(audioContext.currentTime + 0.025, nextPlaybackTime);
  nextPlaybackTime = startAt + buffer.duration;
  playbackSources.add(source);
  source.onended = () => {
    playbackSources.delete(source);
    if (!playbackSources.size) {
      setTimeout(() => {
        if (!playbackSources.size && avatarController.isStateActive("speaking")) {
          avatarController.syncState();
        }
      }, 120);
    }
  };
  source.start(startAt);
}

function setMouthFrame(frame) {
  elements.mouthNeutral.classList.toggle("is-active", frame === 0);
  elements.mouthSmall.classList.toggle("is-active", frame === 1);
  elements.mouthWide.classList.toggle("is-active", frame === 2);
}

function setEyeFrame(frame) {
  elements.eyesOpen.classList.toggle("is-active", frame === "open");
  elements.eyesHalf.classList.toggle("is-active", frame === "half");
  elements.eyesClosed.classList.toggle("is-active", frame === "closed");
}

function scheduleBlink() {
  clearTimeout(blinkTimeoutId);
  blinkTimeoutId = setTimeout(() => {
    setEyeFrame("half");
    blinkTimeoutId = setTimeout(() => {
      setEyeFrame("closed");
      blinkTimeoutId = setTimeout(() => {
        setEyeFrame("half");
        blinkTimeoutId = setTimeout(() => {
          setEyeFrame("open");
          scheduleBlink();
        }, 72);
      }, 105 + Math.random() * 55);
    }, 58);
  }, 2600 + Math.random() * 4200);
}

function animateMouth() {
  const levels = new Uint8Array(128);
  let smoothed = 0;
  const draw = () => {
    let frame = 0;
    if (analyser && audioContext && (playbackSources.size > 0 || audioContext.currentTime < nextPlaybackTime + .12)) {
      analyser.getByteTimeDomainData(levels);
      let energy = 0;
      for (const value of levels) {
        const centered = (value - 128) / 128;
        energy += centered * centered;
      }
      smoothed = smoothed * .64 + Math.sqrt(energy / levels.length) * .36;
      frame = smoothed > .09 ? 2 : smoothed > .018 ? 1 : 0;
    } else smoothed *= .7;
    setMouthFrame(frame);
    mouthAnimationId = requestAnimationFrame(draw);
  };
  mouthAnimationId = requestAnimationFrame(draw);
}

async function runBrowserTool(tool, args) {
  browserToolRunning = true;
  const isUiAction = BROWSER_UI_ACTION_TOOLS.has(tool);
  avatarController.transitionState(isUiAction ? "ui_control" : "thinking");
  try {
    const result = await sendRuntime("browser_tool", { tool, args });
    if (isUiAction) {
      avatarController.transitionState("success", { forMs: 1760, resumeState: "thinking" });
    } else {
      avatarController.transitionState("thinking");
    }
    return result;
  } catch (error) {
    avatarController.transitionState("error", { forMs: 2080 });
    throw error;
  } finally {
    browserToolRunning = false;
    void refreshTarget();
  }
}

async function runMcpTool(tool, args, callId) {
  if (tool.permission === "block") throw new Error("This MCP tool is blocked in Lumi Settings.");
  avatarController.transitionState("tool_call");
  try {
    let permissionGranted = false;
    if (tool.permission !== "allow") {
      permissionGranted = await requestMcpToolPermission(tool, args, callId);
      if (!permissionGranted) {
        const error = new Error("MCP tool permission was denied or timed out.");
        error.name = "McpPermissionDeniedError";
        throw error;
      }
    }
    const result = await sendRuntime("mcp_call_tool", {
      serverId: tool.serverId,
      tool: tool.toolName,
      args,
      permissionGranted,
    });
    avatarController.transitionState("success", { forMs: 1760, resumeState: "thinking" });
    return result;
  } catch (error) {
    avatarController.transitionState("error", { forMs: 2080 });
    throw error;
  }
}

function normalizeMcpToolResult(result) {
  let normalized;
  if (!result || typeof result !== "object") normalized = { result };
  else if (Object.hasOwn(result, "structuredContent")) {
    normalized = { isError: result.isError === true, data: result.structuredContent };
  } else {
    normalized = {
      isError: result.isError === true,
      content: Array.isArray(result.content) ? result.content : result,
    };
  }

  const serialized = JSON.stringify(normalized);
  if (serialized.length <= MAX_MCP_TOOL_RESPONSE_CHARS) return normalized;
  return {
    isError: normalized.isError === true,
    truncated: true,
    message: "The MCP result exceeded Lumi's safe Live API payload limit and was truncated.",
    content: serialized.slice(0, MAX_MCP_TOOL_RESPONSE_CHARS),
  };
}

function formatMcpActivityValue(value) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (!text) return "No data returned.";
  const limit = 24000;
  return text.length > limit ? `${text.slice(0, limit)}\n\n... UI preview truncated ...` : text;
}

function formatMcpDuration(milliseconds) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function createMcpActivityCard(callId, tool, args) {
  const root = document.createElement("details");
  root.className = "mcp-activity";
  root.dataset.state = "running";

  const summary = document.createElement("summary");
  const icon = document.createElement("span");
  icon.className = "mcp-activity-icon";
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "mcp-activity-copy";
  const label = document.createElement("small");
  label.textContent = "MCP TOOL";
  const name = document.createElement("strong");
  name.textContent = tool.toolName;
  copy.append(label, name);
  const status = document.createElement("span");
  status.className = "mcp-activity-status";
  status.setAttribute("role", "status");
  status.textContent = "Running";
  const chevron = document.createElement("span");
  chevron.className = "mcp-activity-chevron";
  chevron.setAttribute("aria-hidden", "true");
  summary.append(icon, copy, status, chevron);

  const body = document.createElement("div");
  body.className = "mcp-activity-body";
  const metadata = document.createElement("dl");
  metadata.className = "mcp-activity-meta";
  for (const [term, value] of [
    ["Server", tool.serverName],
    ["Started", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })],
    ["Duration", "Running"],
  ]) {
    const item = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    item.append(dt, dd);
    metadata.append(item);
  }

  const argsSection = document.createElement("section");
  const argsLabel = document.createElement("span");
  argsLabel.textContent = "Arguments";
  const argsPre = document.createElement("pre");
  argsPre.textContent = formatMcpActivityValue(args || {});
  argsSection.append(argsLabel, argsPre);

  const resultSection = document.createElement("section");
  resultSection.hidden = true;
  const resultLabel = document.createElement("span");
  resultLabel.textContent = "Result";
  const resultPre = document.createElement("pre");
  resultSection.append(resultLabel, resultPre);
  body.append(metadata, argsSection, resultSection);
  root.append(summary, body);
  elements.transcript.append(root);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;

  const activity = {
    root,
    status,
    duration: metadata.querySelector("div:last-child dd"),
    resultSection,
    resultLabel,
    resultPre,
    startedAt: Date.now(),
  };
  mcpActivityCards.set(callId, activity);
  return activity;
}

function finishMcpActivity(callId, state, value) {
  const activity = mcpActivityCards.get(callId);
  if (!activity) return;
  const labels = { completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
  activity.root.dataset.state = state;
  activity.status.textContent = labels[state] || state;
  activity.duration.textContent = formatMcpDuration(Date.now() - activity.startedAt);
  activity.resultLabel.textContent = state === "failed" ? "Error" : state === "cancelled" ? "Cancellation" : "Result";
  activity.resultPre.textContent = formatMcpActivityValue(value);
  activity.resultSection.hidden = false;
  mcpActivityCards.delete(callId);
}

function cancelPendingMcpActivities(message = "Gemini cancelled this tool call because the current turn was interrupted.") {
  for (const id of pendingToolCallIds) {
    rememberCancelledToolCall(id);
    finishMcpActivity(id, "cancelled", message);
  }
}

async function handleServerMessage(event, sourceSocket) {
  const raw = typeof event.data === "string" ? event.data : await event.data.text();
  const response = JSON.parse(raw);
  if (sourceSocket !== websocket) return;

  for (const id of response.toolCallCancellation?.ids || []) {
    rememberCancelledToolCall(id);
    finishMcpActivity(id, "cancelled", "Gemini cancelled this tool call because the conversation turn was interrupted.");
  }
  if (response.setupComplete) {
    clearSetupTimeout();
    clearTurnCancellationTimers();
    turnCancellationPending = false;
    suppressServerOutputUntilNextUserTurn = false;
    setSessionStatus("ready", "Lumi is listening. PageAgent automatically follows your active web tab.");
    setAgentTurnActive(true);
    sendJson({ realtimeInput: { text: "Greet the user warmly in one short sentence and say you are ready." } }, sourceSocket);
  }

  const serverContent = response.serverContent;
  const functionCalls = response.toolCall?.functionCalls || [];
  const hasTurnPayload = Boolean(
    serverContent?.modelTurn?.parts?.length
    || serverContent?.inputTranscription?.text
    || serverContent?.outputTranscription?.text
    || functionCalls.length
  );
  if (turnCancellationPending) {
    if (hasTurnPayload) clearTimeout(turnCancellationDrainTimeoutId);
    for (const functionCall of functionCalls) rememberCancelledToolCall(functionCall.id);
    const cancelledResponses = functionCalls
      .filter((functionCall) => functionCall.id && functionCall.name)
      .map((functionCall) => ({
        id: functionCall.id,
        name: functionCall.name,
        response: { error: "Cancelled by the user before this tool could run." },
      }));
    if (cancelledResponses.length && sourceSocket === websocket) {
      sendJson({ toolResponse: { functionResponses: cancelledResponses } }, sourceSocket);
    }
    if (serverContent?.interrupted) resetPendingTurnExecution();
    if (serverContent?.turnComplete) scheduleTurnCancellationCompletion();
    return;
  }
  if (suppressServerOutputUntilNextUserTurn) {
    const cancelledResponses = functionCalls
      .filter((functionCall) => functionCall.id && functionCall.name)
      .map((functionCall) => ({
        id: functionCall.id,
        name: functionCall.name,
        response: { error: "Ignored because the previous turn was cancelled." },
      }));
    for (const functionCall of functionCalls) rememberCancelledToolCall(functionCall.id);
    if (cancelledResponses.length && sourceSocket === websocket) {
      sendJson({ toolResponse: { functionResponses: cancelledResponses } }, sourceSocket);
    }
    if (serverContent?.interrupted || serverContent?.turnComplete) setAgentTurnActive(false);
    return;
  }
  if (
    serverContent?.modelTurn?.parts?.length
    || serverContent?.inputTranscription?.text
    || serverContent?.outputTranscription?.text
    || functionCalls.length
  ) setAgentTurnActive(true);
  for (const part of serverContent?.modelTurn?.parts || []) {
    if (part.inlineData?.data && responseAudioGate.shouldPlay()) {
      playPcmChunk(part.inlineData.data);
    }
  }
  if (serverContent?.inputTranscription?.text) updateTranscript("user", serverContent.inputTranscription.text);
  if (serverContent?.outputTranscription?.text) updateTranscript("lumi", serverContent.outputTranscription.text);
  if (serverContent?.interrupted) {
    const wasUserCancellation = turnCancellationPending;
    turnCancellationPending = false;
    cancelPendingMcpActivities();
    stopPlayback();
    responseAudioGate.reset();
    finalizeTranscript("lumi");
    setAgentTurnActive(false);
    if (wasUserCancellation) {
      elements.statusLine.textContent = "Current action cancelled. Lumi is ready for your next request.";
    }
  }
  if (serverContent?.turnComplete) {
    const wasUserCancellation = turnCancellationPending;
    turnCancellationPending = false;
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    setAgentTurnActive(false);
    if (wasUserCancellation) {
      elements.statusLine.textContent = "Current action cancelled. Lumi is ready for your next request.";
    }
  }

  if (functionCalls.length) {
    const executionSequence = turnExecutionSequence;
    const functionResponses = [];
    for (const functionCall of functionCalls) {
      if (executionSequence !== turnExecutionSequence || turnCancellationPending) break;
      const callId = functionCall.id;
      if (!callId || cancelledToolCallIds.has(callId)) continue;
      pendingToolCallIds.add(callId);
      pendingToolCallNames.set(callId, functionCall.name);
      let mcpTool = null;
      try {
        const isBrowserTool = BROWSER_TOOLS.some((tool) => tool.name === functionCall.name);
        mcpTool = activeMcpTools.get(functionCall.name) || null;
        if (!isBrowserTool && !mcpTool) throw new Error(`Unsupported tool: ${functionCall.name}`);
        if (mcpTool?.disabled) throw new Error("This MCP tool is disabled for the rest of this session.");
        if (mcpTool) createMcpActivityCard(callId, mcpTool, functionCall.args || {});
        let result = isBrowserTool
          ? await runBrowserTool(functionCall.name, functionCall.args || {})
          : normalizeMcpToolResult(await runMcpTool(mcpTool, functionCall.args || {}, callId));
        if (isBrowserTool) {
          const consumed = consumeResponseAudioDirective(result);
          result = consumed.result;
          if (consumed.suppressForTurn) responseAudioGate.suppress();
        }
        if (
          cancelledToolCallIds.has(callId)
          || executionSequence !== turnExecutionSequence
          || turnCancellationPending
          || sourceSocket !== websocket
        ) {
          if (mcpTool) finishMcpActivity(callId, "cancelled", "The session ended before Lumi could use this MCP result.");
          continue;
        }
        if (mcpTool) finishMcpActivity(callId, "completed", result);
        functionResponses.push({
          id: callId,
          name: functionCall.name,
          response: { result },
        });
      } catch (error) {
        if (
          cancelledToolCallIds.has(callId)
          || executionSequence !== turnExecutionSequence
          || turnCancellationPending
          || sourceSocket !== websocket
        ) {
          if (mcpTool) finishMcpActivity(callId, "cancelled", "The MCP call was cancelled before it completed.");
          continue;
        }
        if (mcpTool) {
          finishMcpActivity(callId, "failed", error instanceof Error ? error.message : "MCP tool call failed.");
          promptToDisableFailedMcpTool(mcpTool, error);
        }
        functionResponses.push({
          id: callId,
          name: functionCall.name,
          response: { error: (error instanceof Error ? error.message : "Tool call failed.").slice(0, 1200) },
        });
      } finally {
        pendingToolCallIds.delete(callId);
        pendingToolCallNames.delete(callId);
      }
    }
    if (
      functionResponses.length
      && executionSequence === turnExecutionSequence
      && !turnCancellationPending
      && sourceSocket === websocket
    ) {
      sendJson({ toolResponse: { functionResponses } }, sourceSocket);
    }
  }
  if (serverContent?.turnComplete) responseAudioGate.reset();
}

function openGeminiSocket({ apiKey, voiceName, mcpInfo, mcpFunctionDeclarations, activeTabContext }) {
  setSessionStatus("connecting", "Microphone is ready. Opening Gemini Live...");
  const functionDeclarations = [...BROWSER_TOOLS, ...mcpFunctionDeclarations];
  websocket = new WebSocket(`${WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`);
  const sessionSocket = websocket;
  setupTimeoutId = setTimeout(() => {
    if (sessionStatus !== "connecting" || websocket !== sessionSocket) return;
    intentionalClose = true;
    websocket = null;
    sessionSocket.close(4000, "Gemini setup timed out");
    cleanupMedia();
    setSessionStatus("error", "Gemini Live did not finish setup within 15 seconds. Check API access, then retry.");
  }, 15000);
  sessionSocket.onopen = () => {
    if (websocket !== sessionSocket) return;
    sendJson({
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
            prefixPaddingMs: 40,
            silenceDurationMs: 650,
          },
        },
        tools: [{ functionDeclarations }],
        systemInstruction: { parts: [{ text: buildSessionInstruction(mcpInfo, activeTabContext) }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }, sessionSocket);
  };
  sessionSocket.onmessage = (event) => {
    void handleServerMessage(event, sessionSocket).catch((error) => {
      if (websocket !== sessionSocket) return;
      intentionalClose = true;
      websocket = null;
      sessionSocket.close(4001, "Invalid Gemini response");
      cleanupMedia();
      setSessionStatus("error", `Gemini Live returned an unreadable response: ${error instanceof Error ? error.message : "Unknown response"}`);
    });
  };
  sessionSocket.onerror = () => {
    if (websocket !== sessionSocket) return;
    elements.statusLine.textContent = "Gemini Live connection failed; waiting for the server error details...";
  };
  sessionSocket.onclose = (event) => {
    if (websocket !== sessionSocket) return;
    const expected = intentionalClose;
    const reason = event.reason?.replace(/\s+/g, " ").trim() || "";
    clearSetupTimeout();

    const rejected = !expected && sessionStatus === "connecting"
      ? findRejectedMcpDeclaration(reason, functionDeclarations, activeMcpTools)
      : null;
    if (rejected) {
      websocket = null;
      activeMcpTools.delete(rejected.declaration.name);
      const declarationIndex = mcpFunctionDeclarations.findIndex(
        (declaration) => declaration.name === rejected.declaration.name,
      );
      if (declarationIndex >= 0) mcpFunctionDeclarations.splice(declarationIndex, 1);
      void sendRuntime("mcp_disable_tool", {
        serverId: rejected.tool.serverId,
        tool: rejected.tool.toolName,
        source: "gemini_setup",
        reason: reason || "Gemini Live rejected this tool declaration.",
      }).catch(() => {});
      queueMcpToolNotice({
        key: `gemini-setup:${rejected.tool.serverId}:${rejected.tool.toolName}`,
        title: `MCP tool auto-disabled: ${rejected.tool.toolName}`,
        message: `${rejected.tool.serverName} exposed a declaration Gemini rejected. Lumi disabled only this tool and is reconnecting now; voice, chat, and other tools remain available.`,
        primaryLabel: "OK",
      });
      setSessionStatus(
        "connecting",
        `Temporarily disabled incompatible MCP tool ${rejected.tool.toolName}. Retrying Gemini Live...`,
      );
      openGeminiSocket({ apiKey, voiceName, mcpInfo, mcpFunctionDeclarations, activeTabContext });
      return;
    }

    cleanupMedia();
    if (!expected) {
      setSessionStatus(
        "error",
        reason
          ? `Gemini Live closed (${event.code}): ${reason.slice(0, 140)}`
          : `Gemini Live closed with code ${event.code}. The key passed validation; reload this extension and try again.`,
      );
    }
  };
}

async function startSession() {
  if (sessionStatus === "ready") {
    stopSession();
    return;
  }
  if (sessionStatus === "connecting") return;

  const stored = await chrome.storage.local.get([API_KEY_STORAGE_KEY, VOICE_STORAGE_KEY]);
  const apiKey = String(stored[API_KEY_STORAGE_KEY] || "").trim();
  const voiceName = String(stored[VOICE_STORAGE_KEY] || "Zephyr");
  if (!apiKey) {
    await openSettings();
    setSessionStatus("error", "Save a Gemini API key before starting voice.");
    return;
  }

  const microphonePermission = await refreshMicrophonePermission();
  if (microphonePermission !== "granted") {
    await openMicrophonePermissionPage();
    return;
  }

  intentionalClose = false;
  cancelledToolCallIds.clear();
  pendingToolCallIds.clear();
  promptedMcpToolFailures.clear();
  elements.microphoneHelpButton.hidden = true;
  setSessionStatus("connecting", "Checking the Gemini key and requesting microphone access…");
  try {
    const mcpInfo = await sendRuntime("mcp_get_tools");
    notifyInvalidMcpSchemas(mcpInfo);
    const mcpFunctionDeclarations = configureMcpTools(mcpInfo, activeMcpTools);
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access is unavailable in Lumi Live. Update Chrome and reopen the extension.");
    }
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = .45;
    analyser.connect(audioContext.destination);
    nextPlaybackTime = audioContext.currentTime;
    await audioContext.resume();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    setSessionStatus("connecting", "Microphone is ready. Checking the Gemini API key…");
    await validateGeminiApiKey(apiKey);
    await setupMicrophone(micStream);

    const activeTabContext = await sendRuntime("browser_tool", {
      tool: "browser_get_active_context",
      args: {},
    });
    openGeminiSocket({ apiKey, voiceName, mcpInfo, mcpFunctionDeclarations, activeTabContext });
  } catch (error) {
    intentionalClose = true;
    const activeSocket = websocket;
    websocket = null;
    activeSocket?.close();
    cleanupMedia();
    const diagnosis = describeStartError(error);
    elements.microphoneHelpButton.hidden = !diagnosis.microphone;
    setSessionStatus("error", diagnosis.message);
  }
}

function cleanupMedia() {
  clearSetupTimeout();
  clearTurnCancellationTimers();
  turnExecutionSequence += 1;
  cancelPendingMcpPermissionPrompts();
  cancelPendingMcpActivities("The voice session ended before this MCP tool call completed.");
  pendingToolCallIds.clear();
  pendingToolCallNames.clear();
  stopPlayback();
  responseAudioGate.reset();
  websocket = null;
  if (micProcessor) micProcessor.port.onmessage = null;
  micProcessor?.disconnect();
  micSource?.disconnect();
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
  micProcessor = null;
  micSource = null;
  audioContext?.close().catch(() => {});
  audioContext = null;
  analyser = null;
  isMuted = false;
  agentTurnActive = false;
  turnCancellationPending = false;
  suppressServerOutputUntilNextUserTurn = false;
  elements.muteButton.textContent = "Mute";
  finalizeTranscript("user");
  finalizeTranscript("lumi");
}

function stopSession() {
  intentionalClose = true;
  const activeSocket = websocket;
  websocket = null;
  activeSocket?.close();
  cleanupMedia();
  setSessionStatus("idle", "Ready. PageAgent will follow whichever web tab you open.");
}

function toggleMute() {
  if (sessionStatus !== "ready") return;
  isMuted = !isMuted;
  elements.muteButton.textContent = isMuted ? "Unmute" : "Mute";
  avatarController.syncState();
  if (isMuted) sendJson({ realtimeInput: { audioStreamEnd: true } });
}

function sendText(text) {
  const clean = text.trim();
  if (!clean || sessionStatus !== "ready" || agentTurnActive || turnCancellationPending) return;
  turnExecutionSequence += 1;
  suppressServerOutputUntilNextUserTurn = false;
  responseAudioGate.reset();
  finalizeTranscript("user");
  finalizeTranscript("lumi");
  createMessage("user", clean);
  avatarController.transitionState("thinking");
  turnCancellationPending = false;
  setAgentTurnActive(true);
  sendJson({ realtimeInput: { text: clean } });
  elements.messageInput.value = "";
  syncMessageComposer();
}

function cancelCurrentTurn() {
  if (sessionStatus !== "ready" || !agentTurnActive) return;
  clearTurnCancellationTimers();
  turnCancellationPending = true;
  suppressServerOutputUntilNextUserTurn = true;
  turnExecutionSequence += 1;
  const cancelledResponses = resetPendingTurnExecution("Cancelled by the user.");
  if (cancelledResponses.length) {
    sendJson({ toolResponse: { functionResponses: cancelledResponses } });
  }
  sendJson({ realtimeInput: { audioStreamEnd: true } });
  sendJson({
    realtimeInput: {
      text: "The user pressed Cancel. Stop the previous task immediately, do not call any tools, and acknowledge cancellation briefly.",
    },
  });
  turnRuntimeResetPromise = Promise.allSettled([
    sendRuntime("cancel_active_browser_action"),
    sendRuntime("cancel_active_mcp_calls"),
  ]).then(() => undefined);
  setAgentTurnActive(false);
  elements.statusLine.textContent = "Cancelling the current action…";
  avatarController.syncState();
  turnCancellationWatchdogTimeoutId = setTimeout(completeTurnCancellation, 1200);
}

function toggleVtuberSize() {
  const expanded = elements.vtuberCard.classList.toggle("expanded");
  document.body.classList.toggle("vtuber-expanded", expanded);
  elements.transcript.setAttribute("aria-hidden", String(expanded));
  elements.vtuberToggle.setAttribute("aria-expanded", String(expanded));
  elements.vtuberToggle.setAttribute(
    "aria-label",
    expanded ? "Shrink Lumi to the conversation corner" : "Expand Lumi over the conversation",
  );
}

function applyPetals(enabled) {
  petalsEnabled = enabled;
  document.body.classList.toggle("petals-off", !enabled);
  if (enabled) petalEmitter.start();
  else petalEmitter.stop();
  elements.petalsButton.setAttribute("aria-pressed", String(enabled));
  elements.petalsButton.setAttribute(
    "aria-label",
    enabled ? "Turn off falling petals" : "Turn on falling petals",
  );
  elements.petalsButton.title = enabled ? "Turn off falling petals" : "Turn on falling petals";
}

async function togglePetals() {
  const enabled = elements.petalsButton.getAttribute("aria-pressed") !== "true";
  applyPetals(enabled);
  await chrome.storage.local.set({ [PETALS_STORAGE_KEY]: enabled });
}

async function toggleAvatarMode() {
  const nextMode = avatarController.mode === "pixel" ? "vtuber" : "pixel";
  await chrome.storage.local.set({ [AVATAR_MODE_STORAGE_KEY]: nextMode });
}

elements.settingsButton.addEventListener("click", () => void openSettings());
elements.avatarModeButton.addEventListener("click", () => void toggleAvatarMode());
elements.petalsButton.addEventListener("click", () => void togglePetals());
elements.vtuberToggle.addEventListener("click", toggleVtuberSize);
elements.startButton.addEventListener("click", () => void startSession());
elements.muteButton.addEventListener("click", toggleMute);
elements.microphoneHelpButton.addEventListener("click", () => void openMicrophonePermissionPage());
elements.mcpToolNoticePrimary.addEventListener("click", () => void handleMcpToolNoticeAction("primary"));
elements.mcpToolNoticeSecondary.addEventListener("click", () => void handleMcpToolNoticeAction("secondary"));
elements.mcpToolNoticeTertiary.addEventListener("click", () => void handleMcpToolNoticeAction("tertiary"));
elements.messageInput.addEventListener("input", () => {
  syncMessageComposer();
});
elements.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (agentTurnActive) cancelCurrentTurn();
  else sendText(elements.messageInput.value);
});
window.addEventListener("unload", () => {
  intentionalClose = true;
  petalEmitter.stop();
  websocket?.close();
  cleanupMedia();
  if (mouthAnimationId) cancelAnimationFrame(mouthAnimationId);
  clearTimeout(blinkTimeoutId);
  avatarController.dispose();
});
window.addEventListener("focus", () => void refreshMicrophonePermission());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshMicrophonePermission();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[MCP_TOOL_POLICIES_STORAGE_KEY]) {
    applyMcpToolPolicies(changes[MCP_TOOL_POLICIES_STORAGE_KEY].newValue);
  }
  if (changes[PETALS_STORAGE_KEY]) {
    applyPetals(changes[PETALS_STORAGE_KEY].newValue !== false);
  }
  if (changes[AVATAR_MODE_STORAGE_KEY]) {
    void avatarController.applyMode(normalizeAvatarMode(changes[AVATAR_MODE_STORAGE_KEY].newValue));
  }
  if (changes[API_KEY_STORAGE_KEY]?.newValue && sessionStatus !== "ready") {
    setSessionStatus("idle", "Settings saved. Lumi is ready to start with the selected voice.");
  }
  if (!changes[MICROPHONE_GRANTED_STORAGE_KEY]) return;
  void refreshMicrophonePermission();
  if (changes[MICROPHONE_GRANTED_STORAGE_KEY].newValue) {
    setSessionStatus("idle", "Microphone allowed. Return to Lumi and press Start voice.");
  }
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === PANEL_LIFECYCLE_MESSAGE) {
    if (message.state === "opened") petalEmitter.restart();
    else if (message.state === "closed") petalEmitter.stop();
    return;
  }
  if (message?.type === EXTENSION_EVENTS.targetChanged) void refreshTarget();
});

async function initialize() {
  const stored = await chrome.storage.local.get([API_KEY_STORAGE_KEY, PETALS_STORAGE_KEY, AVATAR_MODE_STORAGE_KEY]);
  const savedKey = String(stored[API_KEY_STORAGE_KEY] || "");
  applyPetals(stored[PETALS_STORAGE_KEY] !== false);
  const storedAvatarMode = normalizeAvatarMode(stored[AVATAR_MODE_STORAGE_KEY]);
  if (stored[AVATAR_MODE_STORAGE_KEY] !== storedAvatarMode) {
    await chrome.storage.local.set({ [AVATAR_MODE_STORAGE_KEY]: storedAvatarMode });
  }
  await avatarController.applyMode(storedAvatarMode);
  if (!savedKey) setSessionStatus("idle", "Open settings and save a Gemini API key before starting voice.");
  else setSessionStatus("idle", "Ready. PageAgent will follow whichever web tab you open.");
  await refreshMicrophonePermission();
  await refreshTarget();
  scheduleBlink();
  animateMouth();
  setInterval(refreshTarget, 2800);
}

void initialize();
