import { createPanelAudioController } from "./panel-audio-controller.js";
import { createMcpPanelController } from "./mcp-panel-controller.js";
import { createSharedTabAudioController } from "./shared-tab-audio-controller.js";
import {
  createAvatarController,
  normalizeAvatarMode,
} from "./pixel-avatar-controller.js";
import { EXTENSION_EVENTS, STORAGE_KEYS } from "../core/extension-config.js";
import {
  BROWSER_TOOLS,
  BUILTIN_TOOLS,
  BROWSER_UI_ACTION_TOOLS,
  buildInitialHistoryClientContent,
  buildThinkingConfig,
  buildSessionInstruction,
  configureMcpTools,
  DEFAULT_THINKING_LEVEL,
  findRejectedMcpDeclaration,
  MAX_MCP_TOOL_RESPONSE_CHARS,
  MODEL,
  normalizeThinkingLevel,
  WS_ENDPOINT,
} from "../live/session-config.js";
import {
  getLiveTranslationLanguageLabel,
  LIVE_TRANSLATE_TOOL_NAME,
  normalizeLiveTranslationLanguageCode,
} from "../live/translate.js";
import { mergeTranscriptText } from "../live/audio-utils.js";
import {
  findCommonCharacterPrefix,
  getTranscriptRevealDurationMs,
  splitTranscriptCharacters,
} from "./transcript-presentation.js";
import { isSafeMarkdownUrl, renderMarkdown } from "./markdown-renderer.js";
import { applyUiConfig } from "./apply-ui-config.js";
import {
  AVATAR_ERROR_STATE_DURATION_MS,
  AVATAR_SUCCESS_STATE_DURATION_MS,
  DEFAULT_AUTO_CONNECT_ENABLED,
  DEFAULT_FALLING_PETALS_ENABLED,
  DEFAULT_VOICE_NAME,
} from "../core/ui-config.js";
import { attachAnimatedDisclosure } from "./disclosure-controller.js";
import { createPetalEmitter } from "./petal-emitter.js";
import {
  consumeResponseAudioDirective,
  createTurnAudioGate,
  RESPONSE_AUDIO_DIRECTIVE_KEY,
} from "../core/response-audio-policy.js";
import {
  buildPendingCancellationResponses,
  registerPendingFunctionCalls,
  settlePendingFunctionCalls,
} from "../live/tool-call-ledger.js";

const MESSAGE_TYPE = EXTENSION_EVENTS.request;
const API_KEY_STORAGE_KEY = STORAGE_KEYS.apiKey;
const VOICE_STORAGE_KEY = STORAGE_KEYS.voice;
const MICROPHONE_ENABLED_STORAGE_KEY = STORAGE_KEYS.microphoneEnabled;
const MICROPHONE_GRANTED_STORAGE_KEY = STORAGE_KEYS.microphoneGrantedAt;
const PETALS_STORAGE_KEY = STORAGE_KEYS.fallingPetals;
const AVATAR_MODE_STORAGE_KEY = STORAGE_KEYS.avatarMode;
const THINKING_LEVEL_STORAGE_KEY = STORAGE_KEYS.thinkingLevel;
const MCP_TOOL_POLICIES_STORAGE_KEY = STORAGE_KEYS.mcpToolPolicies;
const PANEL_LIFECYCLE_MESSAGE = EXTENSION_EVENTS.lifecycle;
const GEMINI_SETUP_TIMEOUT_MS = 15000;
const EARLY_CONNECTION_DROP_MS = 3000;
const CANCELLED_TOOL_CALL_RETENTION_MS = 60000;
const TURN_CANCELLATION_DRAIN_MS = 120;
const TURN_CANCELLATION_WATCHDOG_MS = 80;
const TURN_CANCELLATION_BOUNDARY_MS = 1500;
const TARGET_REFRESH_INTERVAL_MS = 2800;
applyUiConfig();
const sidePanelLifecyclePort = chrome.runtime.connect({ name: "lumi_live_side_panel" });
const elements = {
  liveBadge: document.querySelector("#liveBadge"),
  translateBadge: document.querySelector("#translateBadge"),
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
  connectionNotice: document.querySelector("#connectionNotice"),
  connectionNoticeTitle: document.querySelector("#connectionNoticeTitle"),
  connectionNoticeMessage: document.querySelector("#connectionNoticeMessage"),
  connectionNoticeAction: document.querySelector("#connectionNoticeAction"),
  connectionNoticeSettings: document.querySelector("#connectionNoticeSettings"),
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
  messageQueue: document.querySelector("#messageQueue"),
  messageQueuePreview: document.querySelector("#messageQueuePreview"),
  messageQueueCount: document.querySelector("#messageQueueCount"),
  messageQueueSteer: document.querySelector("#messageQueueSteer"),
  messageQueueRemove: document.querySelector("#messageQueueRemove"),
  messageForm: document.querySelector("#messageForm"),
  messageInput: document.querySelector("#messageInput"),
  messageSubmit: document.querySelector("#messageForm button[type='submit']"),
  statusLine: document.querySelector("#statusLine"),
  microphoneHelpButton: document.querySelector("#microphoneHelpButton"),
  thinkingPicker: document.querySelector("#thinkingPicker"),
  thinkingButton: document.querySelector("#thinkingButton"),
  thinkingLevelLabel: document.querySelector("#thinkingLevelLabel"),
  thinkingMenu: document.querySelector("#thinkingMenu"),
  thinkingOptions: [...document.querySelectorAll("[data-thinking-level]")],
};

let sessionStatus = "idle";
let sessionStartPending = false;
let intentionalClose = false;
let sessionReadyAt = 0;
let microphoneEnabled = false;
let microphoneWarning = "";
let microphonePermissionHelp = false;
let isMuted = true;
let agentTurnActive = false;
let turnCancellationPending = false;
let turnExecutionSequence = 0;
let turnCancellationDrainTimeoutId = null;
let turnCancellationWatchdogTimeoutId = null;
let turnCancellationBoundaryTimeoutId = null;
let suppressServerOutputUntilNextUserTurn = false;
let cancelledTurnBoundarySeen = false;
let freshUserInputStarted = false;
let browserToolRunning = false;
let activeMcpTools = new Map();
const cancelledToolCallIds = new Set();
const pendingToolCallIds = new Set();
const pendingToolCallNames = new Map();
let websocket = null;
let activeApiKey = "";
let pendingLiveTranslationStart = false;
let liveTranslationTargetLanguageCode = "";
let cancelPendingSharedTabAudioPrompt = null;
let thinkingLevel = DEFAULT_THINKING_LEVEL;
let pendingThinkingReconnect = false;
let hasConnectedInPanelLifetime = false;
let activeTabFrameCapture = null;
let textSendPending = false;
const conversationHistory = [];
const queuedUserMessages = [];
const initialTranscriptMarkup = elements.transcript.innerHTML;
const activeTranscriptReveals = new Set();

let petalsEnabled = DEFAULT_FALLING_PETALS_ENABLED;

let setupTimeoutId = null;

const partialMessages = { user: null, lumi: null, thinking: null };

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

const panelAudio = createPanelAudioController({
  avatarController,
  elements,
  getInputState: () => ({
    canSendAudio: sessionStatus === "ready"
      && !isMuted
      && !turnCancellationPending
      && websocket?.readyState === WebSocket.OPEN,
    freshUserInputStarted,
    suppressServerOutputUntilNextUserTurn,
  }),
  onFreshUserInput: () => {
    markFreshUserInputStarted();
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    finalizeTranscript("thinking");
  },
  onUserSpeechStart: () => {
    void captureAndSendCurrentTabFrame();
  },
  sendJson,
});
const sharedTabAudio = createSharedTabAudioController({
  onEnded: () => {
    void sendRuntime("release_tab_audio").catch(() => {});
    setLiveTranslationBadge("error");
    elements.statusLine.textContent = "Tab sharing stopped. Share the tab again to continue Live Translate.";
    avatarController.transitionState("error", { forMs: AVATAR_ERROR_STATE_DURATION_MS });
  },
});
const responseAudioGate = createTurnAudioGate(() => panelAudio.stopPlayback());

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

async function captureCurrentTabFrame() {
  if (activeTabFrameCapture) return activeTabFrameCapture;
  activeTabFrameCapture = (async () => {
    try {
      const frame = await sendRuntime("capture_tab_context_frame");
      if (!frame?.captured || !frame.data || !frame.mimeType) return null;
      return {
        data: frame.data,
        mimeType: frame.mimeType,
      };
    } catch {
      return null;
    }
  })();
  try {
    return await activeTabFrameCapture;
  } finally {
    activeTabFrameCapture = null;
  }
}

async function captureAndSendCurrentTabFrame() {
  const frame = await captureCurrentTabFrame();
  if (!frame || sessionStatus !== "ready" || websocket?.readyState !== WebSocket.OPEN) {
    return false;
  }
  return sendJson({ realtimeInput: { video: frame } });
}

const {
  applyMcpToolPolicies,
  cancelPendingMcpActivities,
  cancelPendingMcpPermissionPrompts,
  createMcpActivityCard,
  finishMcpActivity,
  handleMcpToolNoticeAction,
  normalizeMcpToolResult,
  notifyInvalidMcpSchemas,
  promptToDisableFailedMcpTool,
  queueMcpToolNotice,
  removeMcpToolNotice,
  requestMcpToolPermission,
  resetSessionFailures: resetMcpSessionFailures,
} = createMcpPanelController({
  elements,
  getActiveMcpTools: () => activeMcpTools,
  getPendingToolCallIds: () => pendingToolCallIds,
  maxToolResponseChars: MAX_MCP_TOOL_RESPONSE_CHARS,
  rememberCancelledToolCall,
  sendRuntime,
});

function requestSharedTabAudio(targetLanguageCode, failureReason = "") {
  const noticeKey = "live-translate-share-tab-audio";
  if (cancelPendingSharedTabAudioPrompt) {
    cancelPendingSharedTabAudioPrompt();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value, fromAction = false) => {
      if (settled) return;
      settled = true;
      cancelPendingSharedTabAudioPrompt = null;
      if (!fromAction) removeMcpToolNotice(noticeKey);
      callback(value);
    };
    cancelPendingSharedTabAudioPrompt = () => {
      sharedTabAudio.stop();
      finish(
        reject,
        new DOMException("Tab sharing was cancelled.", "AbortError"),
      );
    };
    queueMcpToolNotice({
      key: noticeKey,
      title: "Share tab audio to continue",
      message: `${String(failureReason || "Lumi could not read this video directly.").slice(0, 220)} Choose Chrome Tab in the picker and enable Share tab audio.`,
      primaryLabel: "Share tab audio",
      secondaryLabel: "Cancel",
      errorTitle: "Could not share tab audio",
      onPrimary: async () => {
        try {
          const sharedSource = await sharedTabAudio.requestAndPrepare();
          if (!pendingLiveTranslationStart) {
            throw new DOMException("Live translation was cancelled.", "AbortError");
          }
          await sendRuntime("prepare_shared_tab_audio", sharedSource);
          const result = await sendRuntime("start_live_translation", {
            apiKey: activeApiKey,
            targetLanguageCode,
          });
          if (result?.requiresSharedTabAudio) {
            throw new Error(result.reason || "The shared tab audio could not be prepared.");
          }
          sharedTabAudio.startForwarding();
          finish(resolve, {
            ...result,
            captureMode: "sharedTab",
            sourcePlaybackVolume: sharedSource.sourcePlaybackVolume,
          }, true);
        } catch (error) {
          sharedTabAudio.stop();
          await sendRuntime("release_tab_audio").catch(() => {});
          finish(reject, error, true);
          throw error;
        }
      },
      onSecondary: () => {
        sharedTabAudio.stop();
        finish(
          reject,
          new DOMException("Tab sharing was cancelled.", "AbortError"),
          true,
        );
      },
    });
  });
}

function syncMessageComposer() {
  const ready = sessionStatus === "ready";
  const hasText = Boolean(elements.messageInput.value.trim());
  const cancelMode = ready && agentTurnActive && !turnCancellationPending && !hasText;
  const queueMode = ready && (agentTurnActive || turnCancellationPending) && hasText;
  elements.messageInput.disabled = textSendPending;
  elements.messageInput.placeholder = textSendPending
    ? "Capturing the current tab…"
    : ready
    ? turnCancellationPending
      ? "Type your next message while Lumi stops…"
      : agentTurnActive ? "Type to queue your next message…" : "Type a message to Lumi…"
    : sessionStatus === "connecting"
      ? "Type while Lumi reconnects…"
      : "Type a message; Lumi will connect when you send…";
  elements.messageSubmit.dataset.mode = cancelMode ? "cancel" : "send";
  const submitLabel = cancelMode
    ? "Cancel current action"
    : queueMode ? "Add message to queue" : "Send message";
  elements.messageSubmit.setAttribute("aria-label", submitLabel);
  elements.messageSubmit.title = submitLabel;
  elements.messageSubmit.disabled = textSendPending || (!hasText && !cancelMode);
}

function syncQueuedMessagePanel() {
  const count = queuedUserMessages.length;
  elements.messageQueue.hidden = count === 0;
  if (!count) return;
  elements.messageQueuePreview.textContent = queuedUserMessages[0];
  elements.messageQueuePreview.title = queuedUserMessages[0];
  elements.messageQueueCount.textContent = count > 1 ? `+${count - 1}` : "";
  elements.messageQueueSteer.disabled = turnCancellationPending;
  elements.messageQueueSteer.title = sessionStatus === "ready"
    ? "Interrupt the current turn and send this now"
    : "Send this as soon as Lumi reconnects";
}

function resizeMessageInput() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 132)}px`;
}

function setAgentTurnActive(active) {
  if (active === true && (
    turnCancellationPending
    || (suppressServerOutputUntilNextUserTurn && !freshUserInputStarted)
  )) return;
  agentTurnActive = sessionStatus === "ready" && active === true;
  syncMessageComposer();
}

function clearTurnCancellationTimers() {
  clearTimeout(turnCancellationDrainTimeoutId);
  clearTimeout(turnCancellationWatchdogTimeoutId);
  turnCancellationDrainTimeoutId = null;
  turnCancellationWatchdogTimeoutId = null;
}

function clearTurnCancellationBoundaryTimeout() {
  clearTimeout(turnCancellationBoundaryTimeoutId);
  turnCancellationBoundaryTimeoutId = null;
}

function markFreshUserInputStarted() {
  freshUserInputStarted = true;
  if (!cancelledTurnBoundarySeen) return;
  suppressServerOutputUntilNextUserTurn = false;
  cancelledTurnBoundarySeen = false;
  freshUserInputStarted = false;
}

function markCancelledTurnBoundarySeen() {
  clearTurnCancellationBoundaryTimeout();
  cancelledTurnBoundarySeen = true;
  if (!freshUserInputStarted) return;
  suppressServerOutputUntilNextUserTurn = false;
  cancelledTurnBoundarySeen = false;
  freshUserInputStarted = false;
  setAgentTurnActive(true);
}

function rememberCancelledToolCall(callId) {
  if (!callId) return;
  cancelledToolCallIds.add(callId);
  setTimeout(
    () => cancelledToolCallIds.delete(callId),
    CANCELLED_TOOL_CALL_RETENTION_MS,
  );
}

function resetPendingTurnExecution(message = "Cancelled by the user.") {
  cancelPendingMcpPermissionPrompts();
  if (pendingLiveTranslationStart) {
    cancelPendingSharedTabAudioPrompt?.();
    sharedTabAudio.stop();
    pendingLiveTranslationStart = false;
    void sendRuntime("stop_live_translation").catch(() => {});
  }
  const cancelledResponses = buildPendingCancellationResponses(
    pendingToolCallIds,
    pendingToolCallNames,
  );
  for (const callId of pendingToolCallIds) {
    rememberCancelledToolCall(callId);
    finishMcpActivity(callId, "cancelled", message);
  }
  pendingToolCallIds.clear();
  pendingToolCallNames.clear();
  browserToolRunning = false;
  panelAudio.stopPlayback();
  responseAudioGate.reset();
  finalizeTranscript("user");
  finalizeTranscript("lumi");
  finalizeTranscript("thinking");
  return cancelledResponses;
}

function completeTurnCancellation() {
  if (!turnCancellationPending) return;
  clearTurnCancellationTimers();
  resetPendingTurnExecution();
  turnCancellationPending = false;
  setAgentTurnActive(false);
  elements.statusLine.textContent = "Current action stopped. Waiting silently for your next instruction.";
  avatarController.syncState();
  syncMessageComposer();
  flushQueuedUserMessage();
}

function scheduleTurnCancellationCompletion() {
  clearTimeout(turnCancellationDrainTimeoutId);
  turnCancellationDrainTimeoutId = setTimeout(
    completeTurnCancellation,
    TURN_CANCELLATION_DRAIN_MS,
  );
}

function formatThinkingLevel(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function setThinkingMenuOpen(open) {
  const shouldOpen = Boolean(open) && !elements.thinkingButton.disabled;
  elements.thinkingMenu.hidden = !shouldOpen;
  elements.thinkingButton.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) {
    elements.thinkingOptions.find((option) => option.getAttribute("aria-selected") === "true")?.focus();
  }
}

function applyThinkingLevel(value) {
  thinkingLevel = normalizeThinkingLevel(value);
  elements.thinkingLevelLabel.textContent = formatThinkingLevel(thinkingLevel);
  for (const option of elements.thinkingOptions) {
    option.setAttribute("aria-selected", String(option.dataset.thinkingLevel === thinkingLevel));
  }
}

async function selectThinkingLevel(value) {
  const nextLevel = normalizeThinkingLevel(value);
  const changed = nextLevel !== thinkingLevel;
  applyThinkingLevel(nextLevel);
  setThinkingMenuOpen(false);
  await chrome.storage.local.set({ [THINKING_LEVEL_STORAGE_KEY]: nextLevel });
  if (!changed) {
    elements.statusLine.textContent = `Thinking ${formatThinkingLevel(nextLevel)} is already active.`;
    return;
  }
  if (sessionStatus === "ready") {
    pendingThinkingReconnect = true;
    await restartSessionWithContext(`Applying Thinking ${formatThinkingLevel(nextLevel)} without clearing this conversation…`);
    return;
  }
  if (sessionStatus === "connecting") {
    pendingThinkingReconnect = true;
    elements.statusLine.textContent = `Thinking ${formatThinkingLevel(nextLevel)} will apply as soon as Lumi finishes reconnecting.`;
    return;
  }
  elements.statusLine.textContent = `Thinking ${formatThinkingLevel(nextLevel)} selected for the next connection.`;
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
  elements.startButton.querySelector("span:last-child").textContent = nextStatus === "ready"
    ? "Disconnect"
    : nextStatus === "connecting" ? "Connecting…" : nextStatus === "error" ? "Retry" : "Connect";
  elements.muteButton.disabled = nextStatus !== "ready";
  elements.thinkingButton.disabled = false;
  elements.thinkingButton.title = nextStatus === "ready" || nextStatus === "connecting"
    ? "Change thinking level; Lumi will reconnect without losing this conversation"
    : "Choose how deeply Gemini reasons";
  syncMessageComposer();
  syncQueuedMessagePanel();
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
      permissionHelp: true,
      message: "Chrome has not allowed Lumi to use the microphone. Press Enable microphone and follow the permission tab.",
    };
  }
  if (name === "NotFoundError") {
    return { microphone: true, message: "No microphone was found. Connect an input device, then try again." };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return { microphone: true, message: "The microphone is busy or unavailable. Close other apps using it, then retry." };
  }
  return { microphone: false, permissionHelp: false, message: original || "Could not connect to Gemini Live." };
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
  await chrome.tabs.create({ url: chrome.runtime.getURL("settings/microphone-permission.html"), active: true });
  elements.microphoneHelpButton.hidden = false;
  if (sessionStatus === "ready") {
    elements.statusLine.textContent = "A microphone permission tab opened. Chat remains connected while you choose Allow.";
    return;
  }
  setSessionStatus("idle", "A Lumi permission tab opened. Choose Allow there, then return; Lumi will connect automatically.");
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
  const navigationReady = !connected && status?.navigationReady === true;
  elements.targetCard.classList.toggle("connected", connected);
  elements.targetTitle.textContent = connected
    ? status.title || "Active web page"
    : navigationReady ? "Navigation ready" : "No controllable page";
  elements.targetHint.textContent = connected
    ? status.controllerReady === false ? "PageAgent is preparing this page..." : "Auto-following the active Chrome tab."
    : status?.reason || "Lumi can open or switch to a website from this tab.";
  elements.connectTabButton.textContent = connected ? "Auto" : navigationReady ? "Ready" : "Waiting";
  elements.connectTabButton.title = connected
    ? status.url || "Automatically follows the active tab"
    : navigationReady ? "Website navigation is available" : "Waiting for an http/https tab";
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

function hideConnectionNotice() {
  elements.connectionNotice.hidden = true;
  elements.connectionNoticeAction.disabled = false;
  elements.connectionNoticeSettings.disabled = false;
  elements.connectionNoticeSettings.hidden = true;
}

function rememberConversationTurn(role, text) {
  const normalizedRole = role === "model" || role === "lumi" ? "model" : role === "user" ? "user" : "";
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalizedRole || !clean) return;
  const previous = conversationHistory.at(-1);
  if (previous?.role === normalizedRole && previous.text === clean) return;
  conversationHistory.push({ role: normalizedRole, text: clean });
}

function clearConversationContext() {
  for (const message of activeTranscriptReveals) {
    cancelAnimationFrame(message.revealFrameId);
  }
  activeTranscriptReveals.clear();
  conversationHistory.length = 0;
  queuedUserMessages.length = 0;
  hasConnectedInPanelLifetime = false;
  pendingThinkingReconnect = false;
  for (const role of Object.keys(partialMessages)) {
    partialMessages[role]?.disclosure?.dispose();
    partialMessages[role] = null;
  }
  elements.transcript.innerHTML = initialTranscriptMarkup;
  elements.messageInput.value = "";
  resizeMessageInput();
  syncMessageComposer();
  syncQueuedMessagePanel();
}

function showConnectionNotice({ action, title, message, actionLabel, showSettings = false, earlyDisconnect = false }) {
  elements.connectionNotice.dataset.action = action;
  elements.connectionNotice.dataset.earlyDisconnect = String(earlyDisconnect);
  elements.connectionNoticeTitle.textContent = title;
  elements.connectionNoticeMessage.textContent = message;
  elements.connectionNoticeAction.textContent = actionLabel;
  elements.connectionNoticeAction.disabled = false;
  elements.connectionNoticeSettings.disabled = false;
  elements.connectionNoticeSettings.textContent = earlyDisconnect ? "Check Settings" : "Open Settings";
  elements.connectionNoticeSettings.hidden = !showSettings;
  elements.connectionNotice.hidden = false;
  elements.connectionNoticeAction.focus();
}

function showMissingKeyNotice(message = "Add a Gemini API key in Lumi Settings, then Lumi will connect automatically.") {
  showConnectionNotice({
    action: "settings",
    title: "Gemini API key required",
    message,
    actionLabel: "Open Lumi Settings",
  });
}

function showReconnectNotice(message, { earlyDisconnect = false } = {}) {
  showConnectionNotice({
    action: "reconnect",
    title: "Gemini connection unavailable",
    message: message || "The Gemini Live connection ended unexpectedly. Reconnect to continue talking with Lumi.",
    actionLabel: "Reconnect",
    showSettings: true,
    earlyDisconnect,
  });
}

function isGeminiKeyIssue(message) {
  return /api.?key|api_key|unauthenticated|authentication|credential|permission.denied/i.test(String(message || ""));
}

async function handleConnectionNoticeAction() {
  const action = elements.connectionNotice.dataset.action;
  elements.connectionNoticeAction.disabled = true;
  try {
    if (action === "settings") {
      await openSettings();
      return;
    }
    hideConnectionNotice();
    await startSession();
  } finally {
    elements.connectionNoticeAction.disabled = false;
  }
}

async function handleConnectionNoticeSettings() {
  elements.connectionNoticeAction.disabled = true;
  elements.connectionNoticeSettings.disabled = true;
  try {
    await openSettings();
  } finally {
    elements.connectionNoticeAction.disabled = false;
    elements.connectionNoticeSettings.disabled = false;
  }
}

function scrollTranscriptToLatest({ smooth = false } = {}) {
  const top = elements.transcript.scrollHeight;
  if (smooth && typeof elements.transcript.scrollTo === "function") {
    elements.transcript.scrollTo({ top, behavior: "smooth" });
    return;
  }
  elements.transcript.scrollTop = top;
}

function setVisibleTranscriptText(message, text) {
  const visibleText = String(text || "");
  message.visibleText = visibleText;
  if (message.role === "lumi") renderMarkdown(message.content, visibleText);
  else message.content.textContent = visibleText;
}

function revealTranscriptText(message, targetText) {
  const targetCharacters = splitTranscriptCharacters(targetText);
  const visibleText = message.visibleText || "";
  const stableCharacterCount = findCommonCharacterPrefix(visibleText, targetText);
  const remainingCharacterCount = Math.max(0, targetCharacters.length - stableCharacterCount);
  cancelAnimationFrame(message.revealFrameId);
  activeTranscriptReveals.delete(message);

  if (!remainingCharacterCount
    || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) {
    setVisibleTranscriptText(message, targetText);
    scrollTranscriptToLatest();
    return;
  }

  const duration = getTranscriptRevealDurationMs(remainingCharacterCount);
  const startedAt = performance.now();
  setVisibleTranscriptText(
    message,
    targetCharacters.slice(0, stableCharacterCount).join(""),
  );
  activeTranscriptReveals.add(message);

  const revealFrame = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const visibleCharacterCount = stableCharacterCount
      + Math.ceil(remainingCharacterCount * progress);
    setVisibleTranscriptText(
      message,
      targetCharacters.slice(0, visibleCharacterCount).join(""),
    );
    scrollTranscriptToLatest();
    if (progress < 1) {
      message.revealFrameId = requestAnimationFrame(revealFrame);
      return;
    }
    message.revealFrameId = null;
    activeTranscriptReveals.delete(message);
  };
  message.revealFrameId = requestAnimationFrame(revealFrame);
}

function createMessage(role, text) {
  if (role === "thinking") {
    const details = document.createElement("details");
    details.className = "message-thinking";
    details.dataset.state = "streaming";
    const summary = document.createElement("summary");
    const mark = document.createElement("span");
    mark.className = "thinking-summary-mark";
    mark.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "thinking-summary-title";
    title.textContent = "Thinking";
    const status = document.createElement("span");
    status.className = "thinking-summary-status";
    status.textContent = "Streaming";
    const chevron = document.createElement("span");
    chevron.className = "thinking-summary-chevron";
    chevron.setAttribute("aria-hidden", "true");
    summary.append(mark, title, status, chevron);
    const body = document.createElement("div");
    body.className = "thinking-summary-body";
    const content = document.createElement("p");
    content.textContent = text;
    body.append(content);
    details.append(summary, body);
    elements.transcript.append(details);
    const message = {
      article: details,
      body,
      content,
      role,
      summary,
      status,
      text,
      visibleText: text,
    };
    message.disclosure = attachAnimatedDisclosure({
      root: details,
      summary,
      body,
      initiallyExpanded: true,
    });
    scrollTranscriptToLatest({ smooth: true });
    return message;
  }
  const article = document.createElement("article");
  article.className = `message message-${role}`;
  const author = document.createElement("span");
  author.textContent = role === "lumi" ? "Lumi" : "You";
  const content = document.createElement(role === "lumi" ? "div" : "p");
  if (role === "lumi") content.className = "message-content";
  content.textContent = text;
  article.append(author, content);
  elements.transcript.append(article);
  scrollTranscriptToLatest();
  return { article, content, role, text, visibleText: text };
}

function createCapturedTabMessage(capture) {
  if (!/^data:image\/(?:jpeg|png);base64,/i.test(capture?.previewDataUrl || "")) return;
  const article = document.createElement("article");
  article.className = "message message-lumi message-capture";
  const author = document.createElement("span");
  author.textContent = "Captured tab";
  const figure = document.createElement("figure");
  const image = document.createElement("img");
  image.src = capture.previewDataUrl;
  image.alt = `Screenshot of ${capture.source?.title || "the active tab"}`;
  const caption = document.createElement("figcaption");
  const title = document.createElement("strong");
  title.textContent = capture.source?.title || capture.filename || "Active tab";
  const download = document.createElement("a");
  download.href = capture.previewDataUrl;
  download.download = capture.filename || "lumi-tab-capture.jpg";
  download.textContent = "Save image";
  caption.append(title, download);
  figure.append(image, caption);
  article.append(author, figure);
  elements.transcript.append(article);
  scrollTranscriptToLatest({ smooth: true });
}

function updateTranscript(role, incoming) {
  const clean = String(incoming || "").trim();
  if (!clean) return;
  if (!partialMessages[role]) {
    partialMessages[role] = createMessage(role, role === "user" ? clean : "");
  }
  const message = partialMessages[role];
  const wasPlaceholder = role === "thinking" && message.placeholder;
  message.text = wasPlaceholder ? clean : mergeTranscriptText(message.text, clean);
  message.placeholder = false;
  if (wasPlaceholder) {
    message.content.textContent = "";
    message.visibleText = "";
  }
  if (role === "thinking" || role === "lumi") revealTranscriptText(message, message.text);
  else message.content.textContent = message.text;
  if (role === "thinking") {
    const message = partialMessages.thinking;
    message.article.dataset.state = "streaming";
    message.status.textContent = "Streaming";
    scrollTranscriptToLatest();
  }
  scrollTranscriptToLatest();
}

function startThinkingTranscript() {
  if (partialMessages.thinking) return;
  partialMessages.thinking = createMessage("thinking", "Thinking…");
  partialMessages.thinking.placeholder = true;
}

function collapseThinkingTranscript() {
  const message = partialMessages.thinking;
  if (!message) return;
  message.disclosure.setExpanded(false);
}

function finalizeTranscript(role) {
  const message = partialMessages[role];
  if ((role === "user" || role === "lumi") && message?.text) {
    rememberConversationTurn(role, message.text);
  }
  if (role === "lumi" && message?.text) {
    cancelAnimationFrame(message.revealFrameId);
    activeTranscriptReveals.delete(message);
    renderMarkdown(message.content, message.text);
    message.visibleText = message.text;
    scrollTranscriptToLatest();
  }
  if (role === "thinking" && partialMessages.thinking) {
    partialMessages.thinking.article.dataset.state = "complete";
    partialMessages.thinking.status.textContent = "Complete";
    partialMessages.thinking.disclosure.setExpanded(false);
  }
  partialMessages[role] = null;
}

function sendJson(payload, targetSocket = websocket) {
  if (targetSocket?.readyState !== WebSocket.OPEN) return false;
  targetSocket.send(JSON.stringify(payload));
  return true;
}

function setLiveTranslationBadge(state, detail = "") {
  const languageCode = normalizeLiveTranslationLanguageCode(detail)
    || liveTranslationTargetLanguageCode
    || "";
  if (languageCode) liveTranslationTargetLanguageCode = languageCode;
  if (state === "off") liveTranslationTargetLanguageCode = "";
  elements.translateBadge.hidden = state === "off";
  elements.translateBadge.className = `badge badge-translate translate-${state}`;
  elements.translateBadge.textContent = state === "active"
    ? `Translate · ${languageCode}`
    : state === "reconnecting"
      ? `Translate · reconnecting`
      : state === "error"
        ? "Translate · error"
        : "Translate · joining";
  if (sessionStatus === "ready") {
    elements.startButton.querySelector("span:last-child").textContent =
      state === "active" || state === "connecting" || state === "reconnecting"
        ? "Disconnect + stop translate"
        : "Disconnect";
  }
}

async function runLiveTranslationTool(args = {}) {
  const action = String(args.action || "").trim().toLowerCase();
  if (!activeApiKey) {
    throw new Error("Connect Lumi before using Live Translate.");
  }
  if (action === "status") {
    return sendRuntime("live_translation_status");
  }
  if (action === "stop") {
    let result;
    try {
      result = await sendRuntime("stop_live_translation");
    } finally {
      sharedTabAudio.stop();
    }
    setLiveTranslationBadge("off");
    elements.statusLine.textContent = result.wasActive
      ? "Live translation stopped. Lumi is still listening."
      : "Live translation was already off.";
    return { success: true, ...result };
  }
  if (action !== "start") {
    throw new Error("Live Translate action must be start, stop, or status.");
  }
  const targetLanguageCode = normalizeLiveTranslationLanguageCode(args.targetLanguageCode);
  if (!targetLanguageCode) {
    throw new Error("Choose one of the supported Live Translate target languages.");
  }
  avatarController.transitionState("tool_call");
  pendingLiveTranslationStart = true;
  let result;
  try {
    result = await sendRuntime("start_live_translation", {
      apiKey: activeApiKey,
      targetLanguageCode,
    });
    if (result?.requiresSharedTabAudio) {
      elements.statusLine.textContent = "Lumi needs you to share this tab's audio to continue.";
      result = await requestSharedTabAudio(targetLanguageCode, result.reason);
    }
    if (!pendingLiveTranslationStart) {
      await sendRuntime("stop_live_translation").catch(() => {});
      throw new DOMException("Live translation was cancelled.", "AbortError");
    }
  } catch (error) {
    avatarController.transitionState("error", { forMs: AVATAR_ERROR_STATE_DURATION_MS });
    throw error;
  } finally {
    pendingLiveTranslationStart = false;
  }
  liveTranslationTargetLanguageCode = targetLanguageCode;
  const languageLabel = result.languageLabel || getLiveTranslationLanguageLabel(targetLanguageCode);
  const captureLabel = result.captureMode === "mediaElement"
    ? "direct video audio"
    : result.captureMode === "sharedTab" ? "shared tab audio" : "prepared video audio";
  const sourcePlaybackVolume = Number.isFinite(result.sourcePlaybackVolume)
    ? result.sourcePlaybackVolume
    : 0.06;
  elements.statusLine.textContent = `Live translating ${result.source?.title || "the active video"} to ${languageLabel} · ${captureLabel} · source audio at ${Math.round(sourcePlaybackVolume * 100)}%.`;
  avatarController.transitionState("success", { forMs: AVATAR_SUCCESS_STATE_DURATION_MS });
  return {
    success: true,
    state: "active",
    targetLanguageCode,
    sourceTabId: result.source?.tabId,
    sourceTitle: result.source?.title,
    captureMode: result.captureMode || result.source?.mode || "mediaElement",
    audioOwner: "Gemini Live Translate tool",
    sourcePlaybackVolume,
    [RESPONSE_AUDIO_DIRECTIVE_KEY]: { suppressForTurn: true },
  };
}

async function runBrowserTool(tool, args) {
  browserToolRunning = true;
  const isUiAction = BROWSER_UI_ACTION_TOOLS.has(tool);
  avatarController.transitionState(isUiAction ? "ui_control" : "thinking");
  try {
    let result = await sendRuntime("browser_tool", { tool, args });
    if (tool === "browser_capture_screenshot" && result?.previewDataUrl) {
      createCapturedTabMessage(result);
      result = { ...result };
      delete result.previewDataUrl;
    }
    if (isUiAction) {
      avatarController.transitionState("success", {
        forMs: AVATAR_SUCCESS_STATE_DURATION_MS,
        resumeState: "thinking",
      });
    } else {
      avatarController.transitionState("thinking");
    }
    return result;
  } catch (error) {
    avatarController.transitionState("error", { forMs: AVATAR_ERROR_STATE_DURATION_MS });
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
    avatarController.transitionState("success", {
      forMs: AVATAR_SUCCESS_STATE_DURATION_MS,
      resumeState: "thinking",
    });
    return result;
  } catch (error) {
    avatarController.transitionState("error", { forMs: AVATAR_ERROR_STATE_DURATION_MS });
    throw error;
  }
}

async function handleServerMessage(event, sourceSocket, sessionThinkingLevel) {
  const raw = typeof event.data === "string" ? event.data : await event.data.text();
  const response = JSON.parse(raw);
  if (sourceSocket !== websocket) return;

  for (const id of response.toolCallCancellation?.ids || []) {
    if (pendingToolCallNames.get(id) === LIVE_TRANSLATE_TOOL_NAME && pendingLiveTranslationStart) {
      pendingLiveTranslationStart = false;
      void sendRuntime("stop_live_translation").catch(() => {});
    }
    rememberCancelledToolCall(id);
    pendingToolCallIds.delete(id);
    pendingToolCallNames.delete(id);
    finishMcpActivity(id, "cancelled", "Gemini cancelled this tool call because the conversation turn was interrupted.");
  }
  if (response.setupComplete) {
    sessionReadyAt = performance.now();
    hideConnectionNotice();
    clearSetupTimeout();
    clearTurnCancellationTimers();
    clearTurnCancellationBoundaryTimeout();
    turnCancellationPending = false;
    suppressServerOutputUntilNextUserTurn = false;
    cancelledTurnBoundarySeen = false;
    freshUserInputStarted = false;
    if (pendingThinkingReconnect && sessionThinkingLevel !== thinkingLevel) {
      pendingThinkingReconnect = false;
      await restartSessionWithContext(`Applying Thinking ${formatThinkingLevel(thinkingLevel)} without clearing this conversation…`);
      return;
    }
    pendingThinkingReconnect = false;
    const reconnectingExistingConversation = hasConnectedInPanelLifetime;
    sendJson(buildInitialHistoryClientContent(conversationHistory), sourceSocket);
    hasConnectedInPanelLifetime = true;
    const readyMessage = microphoneWarning
      || (isMuted
        ? "Chat is ready. Microphone is off; turn it on whenever you want to speak."
        : "Lumi is listening. PageAgent automatically follows your active web tab.");
    setSessionStatus("ready", readyMessage);
    elements.microphoneHelpButton.hidden = !microphonePermissionHelp;
    if (queuedUserMessages.length) {
      flushQueuedUserMessage();
    } else if (!reconnectingExistingConversation && !conversationHistory.length) {
      setAgentTurnActive(true);
      sendJson({ realtimeInput: { text: "Greet the user warmly in one short sentence and say you are ready." } }, sourceSocket);
    }
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
    if (serverContent?.interrupted || serverContent?.turnComplete) {
      markCancelledTurnBoundarySeen();
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
    if (
      serverContent?.interrupted
      || serverContent?.turnComplete
      || (freshUserInputStarted && serverContent?.inputTranscription?.text)
    ) {
      markCancelledTurnBoundarySeen();
      if (suppressServerOutputUntilNextUserTurn) setAgentTurnActive(false);
    }
    return;
  }
  if (
    serverContent?.modelTurn?.parts?.length
    || serverContent?.inputTranscription?.text
    || serverContent?.outputTranscription?.text
    || functionCalls.length
  ) setAgentTurnActive(true);
  if (serverContent?.inputTranscription?.text) {
    updateTranscript("user", serverContent.inputTranscription.text);
    startThinkingTranscript();
  }
  for (const part of serverContent?.modelTurn?.parts || []) {
    if (part.thought && part.text) {
      updateTranscript("thinking", part.text);
      avatarController.transitionState("thinking");
    }
    if (part.inlineData?.data && responseAudioGate.shouldPlay()) {
      collapseThinkingTranscript();
      panelAudio.playPcmChunk(part.inlineData.data);
    }
  }
  if (serverContent?.outputTranscription?.text) {
    collapseThinkingTranscript();
    updateTranscript("lumi", serverContent.outputTranscription.text);
  }
  if (serverContent?.interrupted) {
    const wasUserCancellation = turnCancellationPending;
    turnCancellationPending = false;
    cancelPendingMcpActivities();
    panelAudio.stopPlayback();
    responseAudioGate.reset();
    finalizeTranscript("lumi");
    finalizeTranscript("thinking");
    setAgentTurnActive(false);
    if (wasUserCancellation) {
      elements.statusLine.textContent = "Current action cancelled. Lumi is ready for your next request.";
    }
    flushQueuedUserMessage();
  }
  if (serverContent?.turnComplete) {
    const wasUserCancellation = turnCancellationPending;
    turnCancellationPending = false;
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    finalizeTranscript("thinking");
    setAgentTurnActive(false);
    if (wasUserCancellation) {
      elements.statusLine.textContent = "Current action cancelled. Lumi is ready for your next request.";
    }
    flushQueuedUserMessage();
  }

  if (functionCalls.length) {
    const executionSequence = turnExecutionSequence;
    const functionResponses = [];
    registerPendingFunctionCalls(
      functionCalls,
      pendingToolCallIds,
      pendingToolCallNames,
      cancelledToolCallIds,
    );
    for (const functionCall of functionCalls) {
      if (executionSequence !== turnExecutionSequence || turnCancellationPending) break;
      const callId = functionCall.id;
      if (!callId || cancelledToolCallIds.has(callId)) continue;
      let mcpTool = null;
      let activityTool = null;
      try {
        const isBrowserTool = BROWSER_TOOLS.some((tool) => tool.name === functionCall.name);
        const isLiveTranslationTool = functionCall.name === LIVE_TRANSLATE_TOOL_NAME;
        mcpTool = activeMcpTools.get(functionCall.name) || null;
        if (!isBrowserTool && !isLiveTranslationTool && !mcpTool) {
          throw new Error(`Unsupported tool: ${functionCall.name}`);
        }
        if (mcpTool?.disabled) throw new Error("This MCP tool is disabled for the rest of this session.");
        activityTool = isLiveTranslationTool
          ? {
              activityLabel: "BUILT-IN TOOL",
              toolName: LIVE_TRANSLATE_TOOL_NAME,
              serverName: "Gemini Live Translate",
            }
          : mcpTool;
        if (activityTool) createMcpActivityCard(callId, activityTool, functionCall.args || {});
        let result = isLiveTranslationTool
          ? await runLiveTranslationTool(functionCall.args || {})
          : isBrowserTool
            ? await runBrowserTool(functionCall.name, functionCall.args || {})
            : normalizeMcpToolResult(await runMcpTool(mcpTool, functionCall.args || {}, callId));
        if (isBrowserTool || isLiveTranslationTool) {
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
          if (activityTool) finishMcpActivity(callId, "cancelled", "The session ended before Lumi could use this tool result.");
          continue;
        }
        if (activityTool) finishMcpActivity(callId, "completed", result);
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
          if (activityTool) finishMcpActivity(callId, "cancelled", "The tool call was cancelled before it completed.");
          continue;
        }
        if (activityTool) {
          finishMcpActivity(callId, "failed", error instanceof Error ? error.message : "Tool call failed.");
        }
        if (mcpTool) promptToDisableFailedMcpTool(mcpTool, error);
        functionResponses.push({
          id: callId,
          name: functionCall.name,
          response: { error: (error instanceof Error ? error.message : "Tool call failed.").slice(0, 1200) },
        });
      }
    }
    if (
      functionResponses.length
      && executionSequence === turnExecutionSequence
      && !turnCancellationPending
      && sourceSocket === websocket
    ) {
      sendJson({ toolResponse: { functionResponses } }, sourceSocket);
      settlePendingFunctionCalls(
        functionResponses,
        pendingToolCallIds,
        pendingToolCallNames,
      );
    }
  }
  if (serverContent?.turnComplete && !functionCalls.length) responseAudioGate.reset();
}

function openGeminiSocket({ apiKey, voiceName, thinkingLevel: sessionThinkingLevel, mcpInfo, mcpFunctionDeclarations, activeTabContext }) {
  setSessionStatus("connecting", "Opening Gemini Live...");
  sessionReadyAt = 0;
  const functionDeclarations = [...BUILTIN_TOOLS, ...mcpFunctionDeclarations];
  websocket = new WebSocket(`${WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`);
  const sessionSocket = websocket;
  setupTimeoutId = setTimeout(() => {
    if (sessionStatus !== "connecting" || websocket !== sessionSocket) return;
    intentionalClose = true;
    websocket = null;
    sessionSocket.close(4000, "Gemini setup timed out");
    cleanupMedia();
    const seconds = GEMINI_SETUP_TIMEOUT_MS / 1000;
    const message = `Gemini Live did not finish setup within ${seconds} seconds. Check API access, then retry.`;
    setSessionStatus("error", message);
    showReconnectNotice(message);
  }, GEMINI_SETUP_TIMEOUT_MS);
  sessionSocket.onopen = () => {
    if (websocket !== sessionSocket) return;
    sendJson({
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
          thinkingConfig: buildThinkingConfig(sessionThinkingLevel),
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
        historyConfig: { initialHistoryInClientContent: true },
      },
    }, sessionSocket);
  };
  sessionSocket.onmessage = (event) => {
    void handleServerMessage(event, sessionSocket, sessionThinkingLevel).catch((error) => {
      if (websocket !== sessionSocket) return;
      intentionalClose = true;
      websocket = null;
      sessionSocket.close(4001, "Invalid Gemini response");
      cleanupMedia();
      const message = `Gemini Live returned an unreadable response: ${error instanceof Error ? error.message : "Unknown response"}`;
      setSessionStatus("error", message);
      showReconnectNotice(message);
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
    const disconnectedSoonAfterConnect = sessionReadyAt > 0
      && performance.now() - sessionReadyAt <= EARLY_CONNECTION_DROP_MS;
    sessionReadyAt = 0;
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
      openGeminiSocket({
        apiKey,
        voiceName,
        thinkingLevel: sessionThinkingLevel,
        mcpInfo,
        mcpFunctionDeclarations,
        activeTabContext,
      });
      return;
    }

    cleanupMedia();
    if (!expected) {
      const message = reason
        ? `Gemini Live closed (${event.code}): ${reason.slice(0, 140)}`
        : `Gemini Live closed with code ${event.code}. Reconnect to continue.`;
      setSessionStatus("error", message);
      if (isGeminiKeyIssue(reason)) showMissingKeyNotice(message);
      else showReconnectNotice(message, { earlyDisconnect: disconnectedSoonAfterConnect });
    }
  };
}

async function startSession() {
  if (sessionStatus === "ready") {
    stopSession();
    return;
  }
  if (sessionStatus === "connecting" || sessionStartPending) return;
  sessionStartPending = true;

  try {
    const stored = await chrome.storage.local.get([
      API_KEY_STORAGE_KEY,
      VOICE_STORAGE_KEY,
      THINKING_LEVEL_STORAGE_KEY,
      MICROPHONE_ENABLED_STORAGE_KEY,
    ]);
    const apiKey = String(stored[API_KEY_STORAGE_KEY] || "").trim();
    const voiceName = String(stored[VOICE_STORAGE_KEY] || DEFAULT_VOICE_NAME);
    const sessionThinkingLevel = normalizeThinkingLevel(stored[THINKING_LEVEL_STORAGE_KEY]);
    microphoneEnabled = stored[MICROPHONE_ENABLED_STORAGE_KEY] === true;
    isMuted = true;
    microphoneWarning = "";
    microphonePermissionHelp = false;
    syncMuteButton();
    if (!apiKey) {
      const message = "Add a Gemini API key in Lumi Settings before connecting.";
      setSessionStatus("error", message);
      showMissingKeyNotice(message);
      return;
    }

    intentionalClose = false;
    cancelledToolCallIds.clear();
    pendingToolCallIds.clear();
    resetMcpSessionFailures();
    hideConnectionNotice();
    elements.microphoneHelpButton.hidden = true;
    setSessionStatus("connecting", "Checking the Gemini key and preparing chat…");
    try {
      const mcpInfo = await sendRuntime("mcp_get_tools");
      notifyInvalidMcpSchemas(mcpInfo);
      const mcpFunctionDeclarations = configureMcpTools(mcpInfo, activeMcpTools);
      await validateGeminiApiKey(apiKey);
      await panelAudio.prepareOutput();
      if (microphoneEnabled) {
        try {
          if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("Microphone access is unavailable in this version of Chrome.");
          }
          await panelAudio.requestMicrophone();
          await panelAudio.startMicrophone();
          isMuted = false;
          syncMuteButton();
        } catch (microphoneError) {
          panelAudio.stopMicrophone();
          isMuted = true;
          const diagnosis = describeStartError(microphoneError);
          microphoneWarning = `${diagnosis.message} Chat is still connected.`;
          microphonePermissionHelp = diagnosis.permissionHelp === true;
          syncMuteButton();
        }
      }
      activeApiKey = apiKey;

      const activeTabContext = await sendRuntime("browser_tool", {
        tool: "browser_get_active_context",
        args: {},
      });
      openGeminiSocket({
        apiKey,
        voiceName,
        thinkingLevel: sessionThinkingLevel,
        mcpInfo,
        mcpFunctionDeclarations,
        activeTabContext,
      });
    } catch (error) {
      intentionalClose = true;
      const activeSocket = websocket;
      websocket = null;
      activeSocket?.close();
      cleanupMedia();
      const diagnosis = describeStartError(error);
      elements.microphoneHelpButton.hidden = !diagnosis.permissionHelp;
      setSessionStatus("error", diagnosis.message);
      if (!diagnosis.microphone) {
        if (isGeminiKeyIssue(diagnosis.message)) showMissingKeyNotice(diagnosis.message);
        else showReconnectNotice(diagnosis.message);
      }
    }
  } finally {
    sessionStartPending = false;
  }
}

async function autoStartSessionIfReady() {
  if (sessionStatus === "connecting" || sessionStatus === "ready") return false;
  const stored = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  if (!String(stored[API_KEY_STORAGE_KEY] || "").trim()) {
    const message = "Add a Gemini API key in Lumi Settings before connecting.";
    setSessionStatus("idle", message);
    showMissingKeyNotice(message);
    return false;
  }
  await startSession();
  return true;
}

function syncMuteButton() {
  const label = isMuted ? "Turn on microphone" : "Turn off microphone";
  elements.muteButton.setAttribute("aria-pressed", String(isMuted));
  elements.muteButton.setAttribute("aria-label", label);
  elements.muteButton.title = label;
}

function cleanupMedia() {
  sessionReadyAt = 0;
  clearSetupTimeout();
  clearTurnCancellationTimers();
  clearTurnCancellationBoundaryTimeout();
  turnExecutionSequence += 1;
  cancelPendingMcpPermissionPrompts();
  cancelPendingSharedTabAudioPrompt?.();
  sharedTabAudio.stop();
  cancelPendingMcpActivities("The session ended before this MCP tool call completed.");
  void sendRuntime("release_tab_audio").catch(() => {});
  pendingToolCallIds.clear();
  pendingToolCallNames.clear();
  activeApiKey = "";
  pendingLiveTranslationStart = false;
  liveTranslationTargetLanguageCode = "";
  setLiveTranslationBadge("off");
  panelAudio.closeSession();
  responseAudioGate.reset();
  websocket = null;
  isMuted = true;
  microphoneWarning = "";
  microphonePermissionHelp = false;
  elements.microphoneHelpButton.hidden = true;
  agentTurnActive = false;
  turnCancellationPending = false;
  suppressServerOutputUntilNextUserTurn = false;
  cancelledTurnBoundarySeen = false;
  freshUserInputStarted = false;
  syncMuteButton();
  finalizeTranscript("user");
  finalizeTranscript("lumi");
  finalizeTranscript("thinking");
}

function stopSession() {
  intentionalClose = true;
  const activeSocket = websocket;
  websocket = null;
  activeSocket?.close();
  cleanupMedia();
  setSessionStatus("idle", "Ready. PageAgent will follow whichever web tab you open.");
}

async function restartSessionWithContext(message) {
  intentionalClose = true;
  const activeSocket = websocket;
  websocket = null;
  activeSocket?.close(1000, "Applying updated session settings");
  cleanupMedia();
  setSessionStatus("idle", message);
  await startSession();
}

async function enableMicrophone({ persistPreference = true } = {}) {
  if (sessionStatus !== "ready" || !isMuted) return !isMuted;
  microphoneEnabled = true;
  if (persistPreference) {
    await chrome.storage.local.set({ [MICROPHONE_ENABLED_STORAGE_KEY]: true });
  }
  elements.muteButton.disabled = true;
  elements.statusLine.textContent = "Turning on microphone…";

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access is unavailable in this version of Chrome.");
    }
    await panelAudio.requestMicrophone();
    await panelAudio.startMicrophone();
    isMuted = false;
    microphoneWarning = "";
    microphonePermissionHelp = false;
    elements.microphoneHelpButton.hidden = true;
    elements.statusLine.textContent = "Microphone is on. You can speak or continue typing.";
    return true;
  } catch (error) {
    panelAudio.stopMicrophone();
    isMuted = true;
    const diagnosis = describeStartError(error);
    microphoneWarning = `${diagnosis.message} Chat is still connected.`;
    microphonePermissionHelp = diagnosis.permissionHelp === true;
    elements.microphoneHelpButton.hidden = !microphonePermissionHelp;
    elements.statusLine.textContent = microphoneWarning;
    return false;
  } finally {
    elements.muteButton.disabled = sessionStatus !== "ready";
    syncMuteButton();
    avatarController.syncState();
  }
}

async function toggleMute() {
  if (sessionStatus !== "ready") return;
  if (isMuted) {
    await enableMicrophone();
    return;
  }

  microphoneEnabled = false;
  isMuted = true;
  microphoneWarning = "";
  microphonePermissionHelp = false;
  panelAudio.stopMicrophone();
  sendJson({ realtimeInput: { audioStreamEnd: true } });
  await chrome.storage.local.set({ [MICROPHONE_ENABLED_STORAGE_KEY]: false });
  elements.microphoneHelpButton.hidden = true;
  elements.statusLine.textContent = "Microphone is off. Chat remains connected.";
  syncMuteButton();
  avatarController.syncState();
}

async function sendText(text, { clearComposer = true, render = true, remember = true } = {}) {
  const clean = text.trim();
  if (
    !clean
    || textSendPending
    || sessionStatus !== "ready"
    || agentTurnActive
    || turnCancellationPending
  ) return false;
  textSendPending = true;
  syncMessageComposer();
  const frame = await captureCurrentTabFrame();
  textSendPending = false;
  if (!frame) {
    elements.statusLine.textContent = "Message not sent: Lumi could not capture the visible active tab. Open a normal http/https tab and try again.";
    syncMessageComposer();
    return false;
  }
  if (sessionStatus !== "ready" || agentTurnActive || turnCancellationPending) {
    syncMessageComposer();
    return false;
  }
  turnExecutionSequence += 1;
  const executionSequence = turnExecutionSequence;
  if (suppressServerOutputUntilNextUserTurn) markFreshUserInputStarted();
  responseAudioGate.reset();
  finalizeTranscript("user");
  finalizeTranscript("lumi");
  finalizeTranscript("thinking");
  if (render) createMessage("user", clean);
  if (remember) rememberConversationTurn("user", clean);
  startThinkingTranscript();
  avatarController.transitionState("thinking");
  turnCancellationPending = false;
  setAgentTurnActive(true);
  if (clearComposer) {
    elements.messageInput.value = "";
    resizeMessageInput();
  }
  syncMessageComposer();
  if (
    executionSequence !== turnExecutionSequence
    || turnCancellationPending
    || sessionStatus !== "ready"
  ) return true;
  sendJson({
    realtimeInput: {
      video: frame,
      text: clean,
    },
  });
  return true;
}

async function flushQueuedUserMessage() {
  if (
    !queuedUserMessages.length
    || textSendPending
    || sessionStatus !== "ready"
    || agentTurnActive
    || turnCancellationPending
  ) {
    return false;
  }
  const nextMessage = queuedUserMessages.shift();
  syncQueuedMessagePanel();
  if (!await sendText(nextMessage, { clearComposer: false })) {
    queuedUserMessages.unshift(nextMessage);
    syncQueuedMessagePanel();
    return false;
  }
  elements.statusLine.textContent = queuedUserMessages.length
    ? `${queuedUserMessages.length} more message${queuedUserMessages.length === 1 ? "" : "s"} queued.`
    : "Message sent. Lumi is working on it now.";
  return true;
}

function queueUserMessage(text) {
  const clean = String(text || "").trim();
  if (!clean) return;
  queuedUserMessages.push(clean);
  syncQueuedMessagePanel();
  elements.messageInput.value = "";
  resizeMessageInput();
  syncMessageComposer();

  if (sessionStatus === "ready") {
    elements.statusLine.textContent = agentTurnActive || turnCancellationPending
      ? "Message queued. It will send when the current turn finishes; choose Steer to send it now."
      : "Message queued. Sending now…";
    if (!agentTurnActive && !turnCancellationPending) flushQueuedUserMessage();
    return;
  }

  elements.statusLine.textContent = sessionStatus === "connecting"
    ? "Message queued and will send as soon as Lumi reconnects."
    : "Message queued. Connecting Lumi automatically…";
  if (sessionStatus !== "connecting") void autoStartSessionIfReady();
}

function steerQueuedUserMessage() {
  if (!queuedUserMessages.length || turnCancellationPending) return;
  if (sessionStatus !== "ready") {
    elements.statusLine.textContent = "Steer is ready. Reconnecting Lumi, then this message will send first…";
    if (sessionStatus !== "connecting") void autoStartSessionIfReady();
    return;
  }
  if (!agentTurnActive) {
    flushQueuedUserMessage();
    return;
  }
  cancelCurrentTurn();
  elements.statusLine.textContent = "Steering to the queued message now…";
}

function removeQueuedUserMessage() {
  if (!queuedUserMessages.length) return;
  queuedUserMessages.shift();
  syncQueuedMessagePanel();
  elements.statusLine.textContent = queuedUserMessages.length
    ? `${queuedUserMessages.length} queued message${queuedUserMessages.length === 1 ? "" : "s"} remaining.`
    : "Queued message removed.";
}

function cancelCurrentTurn() {
  if (sessionStatus !== "ready" || !agentTurnActive) return;
  clearTurnCancellationTimers();
  clearTurnCancellationBoundaryTimeout();
  turnCancellationPending = true;
  suppressServerOutputUntilNextUserTurn = true;
  cancelledTurnBoundarySeen = false;
  freshUserInputStarted = false;
  turnExecutionSequence += 1;
  const cancelledResponses = resetPendingTurnExecution("Cancelled by the user.");
  if (cancelledResponses.length) {
    sendJson({ toolResponse: { functionResponses: cancelledResponses } });
  }
  sendJson({ realtimeInput: { audioStreamEnd: true } });
  void Promise.allSettled([
    sendRuntime("cancel_active_browser_action"),
    sendRuntime("cancel_active_mcp_calls"),
  ]);
  setAgentTurnActive(false);
  syncQueuedMessagePanel();
  elements.statusLine.textContent = "Stopping the current action…";
  avatarController.syncState();
  turnCancellationWatchdogTimeoutId = setTimeout(
    completeTurnCancellation,
    TURN_CANCELLATION_WATCHDOG_MS,
  );
  turnCancellationBoundaryTimeoutId = setTimeout(
    markCancelledTurnBoundarySeen,
    TURN_CANCELLATION_BOUNDARY_MS,
  );
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
elements.messageQueueSteer.addEventListener("click", steerQueuedUserMessage);
elements.messageQueueRemove.addEventListener("click", removeQueuedUserMessage);
elements.microphoneHelpButton.addEventListener("click", () => void openMicrophonePermissionPage());
elements.connectionNoticeAction.addEventListener("click", () => void handleConnectionNoticeAction());
elements.connectionNoticeSettings.addEventListener("click", () => void handleConnectionNoticeSettings());
elements.thinkingButton.addEventListener("click", () => {
  setThinkingMenuOpen(elements.thinkingButton.getAttribute("aria-expanded") !== "true");
});
for (const option of elements.thinkingOptions) {
  option.addEventListener("click", () => void selectThinkingLevel(option.dataset.thinkingLevel));
}
document.addEventListener("click", (event) => {
  if (!elements.thinkingPicker.contains(event.target)) setThinkingMenuOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || elements.thinkingMenu.hidden) return;
  setThinkingMenuOpen(false);
  elements.thinkingButton.focus();
});
elements.mcpToolNoticePrimary.addEventListener("click", () => void handleMcpToolNoticeAction("primary"));
elements.mcpToolNoticeSecondary.addEventListener("click", () => void handleMcpToolNoticeAction("secondary"));
elements.mcpToolNoticeTertiary.addEventListener("click", () => void handleMcpToolNoticeAction("tertiary"));
elements.transcript.addEventListener("click", (event) => {
  const link = event.target.closest?.(".markdown-body a[href]");
  if (!link) return;
  event.preventDefault();
  const url = link.getAttribute("href");
  if (!isSafeMarkdownUrl(url)) return;
  void chrome.tabs.create({ url, active: true }).catch((error) => {
    elements.statusLine.textContent = `Could not open link: ${error.message}`;
  });
});
elements.messageInput.addEventListener("input", () => {
  resizeMessageInput();
  syncMessageComposer();
});
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!elements.messageSubmit.disabled) elements.messageForm.requestSubmit();
});
elements.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = elements.messageInput.value.trim();
  if (message && (sessionStatus !== "ready" || agentTurnActive || turnCancellationPending)) {
    queueUserMessage(message);
  } else if (message) {
    void sendText(message);
  } else if (agentTurnActive) {
    cancelCurrentTurn();
  }
});
window.addEventListener("unload", () => {
  intentionalClose = true;
  clearConversationContext();
  sidePanelLifecyclePort.disconnect();
  petalEmitter.stop();
  websocket?.close();
  cleanupMedia();
  panelAudio.dispose();
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
    const nextPetals = changes[PETALS_STORAGE_KEY].newValue;
    applyPetals(typeof nextPetals === "boolean"
      ? nextPetals
      : DEFAULT_FALLING_PETALS_ENABLED);
  }
  if (changes[AVATAR_MODE_STORAGE_KEY]) {
    void avatarController.applyMode(normalizeAvatarMode(changes[AVATAR_MODE_STORAGE_KEY].newValue));
  }
  if (changes[THINKING_LEVEL_STORAGE_KEY]) {
    const nextThinkingLevel = normalizeThinkingLevel(changes[THINKING_LEVEL_STORAGE_KEY].newValue);
    const changed = nextThinkingLevel !== thinkingLevel;
    applyThinkingLevel(nextThinkingLevel);
    if (changed && sessionStatus === "ready") {
      pendingThinkingReconnect = true;
      void restartSessionWithContext(`Applying Thinking ${formatThinkingLevel(nextThinkingLevel)} without clearing this conversation…`);
    } else if (changed && sessionStatus === "connecting") {
      pendingThinkingReconnect = true;
    }
  }
  if (changes[API_KEY_STORAGE_KEY]) {
    const nextApiKey = String(changes[API_KEY_STORAGE_KEY].newValue || "").trim();
    if (!nextApiKey) {
      if (sessionStatus === "ready" || sessionStatus === "connecting") stopSession();
      const message = "Add a Gemini API key in Lumi Settings before connecting.";
      setSessionStatus("error", message);
      showMissingKeyNotice(message);
    } else if (sessionStatus !== "ready" && DEFAULT_AUTO_CONNECT_ENABLED) {
      hideConnectionNotice();
      setSessionStatus("idle", "Settings saved. Connecting Lumi automatically…");
      void autoStartSessionIfReady();
    }
  }
  if (!changes[MICROPHONE_GRANTED_STORAGE_KEY]) return;
  if (changes[MICROPHONE_GRANTED_STORAGE_KEY].newValue && DEFAULT_AUTO_CONNECT_ENABLED) {
    if (sessionStatus === "ready" && microphoneEnabled && isMuted) {
      void enableMicrophone({ persistPreference: false });
    } else if (sessionStatus !== "ready") {
      setSessionStatus("idle", "Microphone allowed. Connecting Lumi automatically…");
      void autoStartSessionIfReady();
    }
  } else {
    void refreshMicrophonePermission();
  }
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === EXTENSION_EVENTS.translationState) {
    setLiveTranslationBadge(message.state || "off", message.targetLanguageCode || message.detail || "");
    if (message.state === "error" && message.detail) {
      sharedTabAudio.stop();
      void sendRuntime("release_tab_audio").catch(() => {});
      elements.statusLine.textContent = message.detail;
      avatarController.transitionState("error", { forMs: AVATAR_ERROR_STATE_DURATION_MS });
    }
    return;
  }
  if (message?.type === PANEL_LIFECYCLE_MESSAGE) {
    if (message.state === "opened") petalEmitter.restart();
    else if (message.state === "closed") {
      petalEmitter.stop();
      clearConversationContext();
    }
    return;
  }
  if (message?.type === EXTENSION_EVENTS.targetChanged) void refreshTarget();
});

async function initialize() {
  const stored = await chrome.storage.local.get([
    API_KEY_STORAGE_KEY,
    PETALS_STORAGE_KEY,
    AVATAR_MODE_STORAGE_KEY,
    THINKING_LEVEL_STORAGE_KEY,
    MICROPHONE_ENABLED_STORAGE_KEY,
  ]);
  const savedKey = String(stored[API_KEY_STORAGE_KEY] || "").trim();
  microphoneEnabled = stored[MICROPHONE_ENABLED_STORAGE_KEY] === true;
  isMuted = true;
  syncMuteButton();
  if (typeof stored[MICROPHONE_ENABLED_STORAGE_KEY] !== "boolean") {
    await chrome.storage.local.set({ [MICROPHONE_ENABLED_STORAGE_KEY]: false });
  }
  const storedPetals = stored[PETALS_STORAGE_KEY];
  applyPetals(typeof storedPetals === "boolean"
    ? storedPetals
    : DEFAULT_FALLING_PETALS_ENABLED);
  const storedThinkingLevel = normalizeThinkingLevel(stored[THINKING_LEVEL_STORAGE_KEY]);
  applyThinkingLevel(storedThinkingLevel);
  if (stored[THINKING_LEVEL_STORAGE_KEY] !== storedThinkingLevel) {
    await chrome.storage.local.set({ [THINKING_LEVEL_STORAGE_KEY]: storedThinkingLevel });
  }
  const storedAvatarMode = normalizeAvatarMode(stored[AVATAR_MODE_STORAGE_KEY]);
  if (stored[AVATAR_MODE_STORAGE_KEY] !== storedAvatarMode) {
    await chrome.storage.local.set({ [AVATAR_MODE_STORAGE_KEY]: storedAvatarMode });
  }
  await avatarController.applyMode(storedAvatarMode);
  if (!savedKey) {
    const message = "Add a Gemini API key in Lumi Settings before connecting.";
    setSessionStatus("idle", message);
    showMissingKeyNotice(message);
  } else {
    setSessionStatus("idle", "Preparing automatic connection…");
  }
  await refreshTarget();
  const translationStatus = await sendRuntime("live_translation_status").catch(() => null);
  if (translationStatus?.prepared) {
    setLiveTranslationBadge(translationStatus.state || "off", translationStatus.targetLanguageCode || "");
    elements.statusLine.textContent = "Video audio is prepared. Connecting automatically…";
  }
  panelAudio.startAnimations();
  setInterval(refreshTarget, TARGET_REFRESH_INTERVAL_MS);
  if (savedKey && DEFAULT_AUTO_CONNECT_ENABLED) await autoStartSessionIfReady();
}

void initialize();
