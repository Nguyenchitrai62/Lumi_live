import { createPanelAudioController } from "./panel-audio-controller.js";
import { createMcpPanelController } from "./mcp-panel-controller.js";
import { createSharedTabAudioController } from "./shared-tab-audio-controller.js";
import { createBrowserToolRunner } from "./browser-tool-runner.js";
import { createFastModeController } from "./fast-mode-controller.js";
import { createResilientRuntimePort } from "./lifecycle-port.js";
import {
  createAvatarController,
  normalizeAvatarMode,
} from "./pixel-avatar-controller.js";
import { EXTENSION_EVENTS, STORAGE_KEYS } from "../core/extension-config.js";
import {
  BROWSER_TOOLS,
  BUILTIN_TOOLS,
  BROWSER_UI_ACTION_TOOLS,
  automaticSessionReconnectDelayMs,
  buildInitialHistoryClientContent,
  buildSessionHandshakeConfig,
  buildThinkingConfig,
  buildSessionInstruction,
  configureMcpTools,
  DEFAULT_THINKING_LEVEL,
  findRejectedMcpDeclaration,
  MAX_MCP_TOOL_RESPONSE_CHARS,
  MODEL,
  NEW_CHAT_CONTEXT_BOUNDARY,
  normalizeThinkingLevel,
  trimConversationHistory,
  WS_ENDPOINT,
} from "../live/session-config.js";
import {
  getLiveTranslationLanguageLabel,
  LIVE_TRANSLATE_TOOL_NAME,
  normalizeLiveTranslationLanguageCode,
} from "../live/translate.js";
import {
  prepareVideoAnalysisAgentResult,
  VIDEO_ANALYSIS_MODEL,
  VIDEO_ANALYZE_TOOL_NAME,
} from "../live/video-analysis.js";
import { mergeTranscriptText } from "../live/audio-utils.js";
import {
  findCommonCharacterPrefix,
  formatMessageTimestamp,
  formatTurnDuration,
  getLiveModelPartTranscriptRole,
  getTranscriptRevealDurationMs,
  isScrollAtBottom,
  splitTranscriptCharacters,
} from "./transcript-presentation.js";
import { isSafeMarkdownUrl, renderMarkdown } from "./markdown-renderer.js";
import { applyUiConfig } from "./apply-ui-config.js";
import {
  AVATAR_ERROR_STATE_DURATION_MS,
  AVATAR_SUCCESS_STATE_DURATION_MS,
  DEFAULT_AUTO_CONNECT_ENABLED,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_FAST_MODE_ENABLED,
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
import {
  imageFilesFromClipboard,
  imageFilesFromDrop,
  prepareImageAttachment,
  queuedImageMessagePreview,
} from "./image-attachments.js";
import { buildBrowserToolFailureResponse } from "./browser-tool-recovery.js";
import { addBrowserWorkflowContext } from "./browser-workflow-context.js";
import {
  AGENT_DONE_ACTION_NAME,
  AGENT_STEP_TOOL_NAME,
  buildAgentStepDeclaration,
  parseAgentStepCall,
} from "../live/agent-protocol.js";
import { createTaskOrchestrator } from "../live/task-orchestrator.js";
import { createTaskStepView } from "./task-step-view.js";
import { createRecordedFlowPanel } from "./recorded-flow-panel.js";
import { collectAutomaticBrowserVerification } from "./browser-action-verification.js";
import {
  shouldRenderStandaloneToolActivity,
  taskOwnsTurn,
} from "./task-transcript-policy.js";
import {
  createLocalChatSession,
  createLocalChatHistoryStore,
  deriveLocalChatSessionTitle,
  findReusableBlankChatSession,
  normalizeLocalChatHistory,
  normalizeLocalChatHistoryState,
} from "./local-chat-history.js";
import { createLocalChatSnapshotStore } from "./local-chat-snapshots.js";

const MESSAGE_TYPE = EXTENSION_EVENTS.request;
const API_KEY_STORAGE_KEY = STORAGE_KEYS.apiKey;
const VOICE_STORAGE_KEY = STORAGE_KEYS.voice;
const MICROPHONE_ENABLED_STORAGE_KEY = STORAGE_KEYS.microphoneEnabled;
const MICROPHONE_GRANTED_STORAGE_KEY = STORAGE_KEYS.microphoneGrantedAt;
const PETALS_STORAGE_KEY = STORAGE_KEYS.fallingPetals;
const AVATAR_MODE_STORAGE_KEY = STORAGE_KEYS.avatarMode;
const CHAT_HISTORY_STORAGE_KEY = STORAGE_KEYS.chatHistory;
const FAST_MODE_STORAGE_KEY = STORAGE_KEYS.fastMode;
const THINKING_LEVEL_STORAGE_KEY = STORAGE_KEYS.thinkingLevel;
const MCP_TOOL_POLICIES_STORAGE_KEY = STORAGE_KEYS.mcpToolPolicies;
const VIDEO_ANALYSES_STORAGE_KEY = STORAGE_KEYS.videoAnalyses;
const PANEL_LIFECYCLE_MESSAGE = EXTENSION_EVENTS.lifecycle;
const GEMINI_SETUP_TIMEOUT_MS = 15000;
const EARLY_CONNECTION_DROP_MS = 3000;
const CANCELLED_TOOL_CALL_RETENTION_MS = 60000;
const TURN_CANCELLATION_DRAIN_MS = 120;
const TURN_CANCELLATION_WATCHDOG_MS = 80;
const TURN_CANCELLATION_BOUNDARY_MS = 1500;
const VISUAL_CONTEXT_SETTLE_MS = 650;
const LIVE_TRANSLATION_CHAT_LOCK_STATES = new Set([
  "connecting",
  "active",
  "reconnecting",
  "stopping",
]);
applyUiConfig();
const sidePanelLifecyclePort = createResilientRuntimePort({
  connect: (connectInfo) => chrome.runtime.connect(connectInfo),
  name: "lumi_live_side_panel",
});
const chatHistoryStore = createLocalChatHistoryStore({
  storageArea: chrome.storage.local,
  storageKey: CHAT_HISTORY_STORAGE_KEY,
});
const chatSnapshotStore = createLocalChatSnapshotStore();
const elements = {
  extensionVersion: document.querySelector("#extensionVersion"),
  translateBadge: document.querySelector("#translateBadge"),
  activeChatTitle: document.querySelector("#activeChatTitle"),
  chatHistoryButton: document.querySelector("#chatHistoryButton"),
  chatHistoryCloseButton: document.querySelector("#chatHistoryCloseButton"),
  chatHistoryDialog: document.querySelector("#chatHistoryDialog"),
  chatConfirmationDialog: document.querySelector("#chatConfirmationDialog"),
  chatConfirmationTitle: document.querySelector("#chatConfirmationTitle"),
  chatConfirmationMessage: document.querySelector("#chatConfirmationMessage"),
  chatConfirmationCancel: document.querySelector("#chatConfirmationCancel"),
  chatConfirmationConfirm: document.querySelector("#chatConfirmationConfirm"),
  chatSessionEmpty: document.querySelector("#chatSessionEmpty"),
  chatSessionList: document.querySelector("#chatSessionList"),
  clearHistoryButton: document.querySelector("#clearHistoryButton"),
  historyNewChatButton: document.querySelector("#historyNewChatButton"),
  newChatButton: document.querySelector("#newChatButton"),
  settingsButton: document.querySelector("#settingsButton"),
  fastModeButton: document.querySelector("#fastModeButton"),
  avatarModeButton: document.querySelector("#avatarModeButton"),
  petalsButton: document.querySelector("#petalsButton"),
  petalField: document.querySelector(".petal-field"),
  transcript: document.querySelector("#transcript"),
  taskFailureNotice: document.querySelector("#taskFailureNotice"),
  taskFailureNoticeTitle: document.querySelector("#taskFailureNoticeTitle"),
  taskFailureNoticeMessage: document.querySelector("#taskFailureNoticeMessage"),
  dismissTaskFailureNoticeButton: document.querySelector("#dismissTaskFailureNoticeButton"),
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
  muteButton: document.querySelector("#muteButton"),
  messageQueue: document.querySelector("#messageQueue"),
  messageQueuePreview: document.querySelector("#messageQueuePreview"),
  messageQueueCount: document.querySelector("#messageQueueCount"),
  messageQueueSteer: document.querySelector("#messageQueueSteer"),
  messageQueueRemove: document.querySelector("#messageQueueRemove"),
  liveTranslationPanel: document.querySelector("#liveTranslationPanel"),
  liveTranslationPanelTitle: document.querySelector("#liveTranslationPanelTitle"),
  liveTranslationPanelDetail: document.querySelector("#liveTranslationPanelDetail"),
  stopLiveTranslationButton: document.querySelector("#stopLiveTranslationButton"),
  messageForm: document.querySelector("#messageForm"),
  imageAttachmentButton: document.querySelector("#imageAttachmentButton"),
  imageAttachmentInput: document.querySelector("#imageAttachmentInput"),
  imageAttachmentTray: document.querySelector("#imageAttachmentTray"),
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
let userTurnAuthorized = false;
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
const pendingToolActionNames = new Map();
let websocket = null;
let activeApiKey = "";
let pendingLiveTranslationStart = false;
let liveTranslationTargetLanguageCode = "";
let liveTranslationState = "off";
let liveTranslationStopPending = false;
let liveTranslationChatLocked = false;
let resumeMicrophoneAfterTranslation = false;
let liveTranslationStopError = "";
let cancelPendingSharedTabAudioPrompt = null;
let thinkingLevel = DEFAULT_THINKING_LEVEL;
let activeTabFrameCapture = null;
let textSendPending = false;
let imageAttachmentPending = false;
let pendingImageAttachment = null;
let imageDragDepth = 0;
let shouldMaintainGeminiSession = false;
let sessionConnectionOptions = null;
let sessionResumptionHandle = "";
let automaticSessionReconnectAttempt = 0;
let automaticSessionReconnectTimerId = null;
let serverRotationPending = false;
let backgroundSessionReconnectPending = false;
let pendingSessionHandoffSocket = null;
let activeTurnUserRequest = "";
let taskFailureNoticeSignature = "";
let pendingConversationBoundary = false;
let conversationContextEpoch = 0;
const conversationHistory = [];
const localChatHistory = [];
let chatHistoryState = normalizeLocalChatHistoryState(null);
let chatSessionMutationPending = false;
let pendingChatConfirmationResolve = null;
let chatSnapshotPersistTimerId = null;
let chatSnapshotPersistenceSuspended = false;
const queuedUserMessages = [];
const initialTranscriptMarkup = elements.transcript.innerHTML;
const activeTranscriptReveals = new Set();
const completedThinkingMessagesAwaitingContent = new Set();
const restoredTranscriptDisclosures = new Set();
let lumiContentSequence = 0;
let thinkingCollapseFrameId = null;
let transcriptAutoFollow = true;
let transcriptProgrammaticScroll = false;
let transcriptProgrammaticScrollTimerId = null;
let activeTurnWork = null;
let directVideoPresentationTurnSequence = null;

let petalsEnabled = DEFAULT_FALLING_PETALS_ENABLED;
let fastModeController = null;

const setupTimeoutIds = new Set();

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
  isEnabled: () => petalsEnabled && !fastModeController?.enabled,
});

const panelAudio = createPanelAudioController({
  avatarController,
  elements,
  getInputState: () => ({
    canSendAudio: isGeminiTransportReady()
      && !isMuted
      && !turnCancellationPending
      && !pendingSessionHandoffSocket,
    freshUserInputStarted,
    suppressServerOutputUntilNextUserTurn,
  }),
  onFreshUserInput: () => {
    markFreshUserInputStarted();
  },
  onInputLevel: (level) => {
    syncMicrophoneLevel(level);
  },
  onUserSpeechStart: () => {
    userTurnAuthorized = true;
    sendPendingConversationBoundary();
    turnExecutionSequence += 1;
    directVideoPresentationTurnSequence = null;
    beginTurnWork(turnExecutionSequence);
    taskOrchestrator.cancelTask("The task was interrupted by a new voice request.");
    activeTurnUserRequest = "";
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    finalizeTranscript("thinking");
    void sendRuntime("prepare_browser_prompt").catch((error) => {
      elements.statusLine.textContent = error instanceof Error
        ? error.message
        : "Lumi could not prepare the browser target for this voice request.";
    });
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
const taskStepView = createTaskStepView({
  container: elements.transcript,
  scrollToLatest: () => scrollTranscriptToLatest(),
});

function hideTaskFailureNotice() {
  taskFailureNoticeSignature = "";
  elements.taskFailureNotice.hidden = true;
}

function showTaskFailureNotice(title, message, signature) {
  if (!signature || signature === taskFailureNoticeSignature) return;
  taskFailureNoticeSignature = signature;
  elements.taskFailureNoticeTitle.textContent = title;
  elements.taskFailureNoticeMessage.textContent = message;
  elements.taskFailureNotice.hidden = false;
}

function syncTaskFailureNotice(event, change) {
  if (change === "clear" || change === "restore" || event?.type === "task_started") {
    hideTaskFailureNotice();
    return;
  }
  if (event?.type === "task_done") {
    if (event.success || ["cancelled", "superseded"].includes(event.reason)) {
      hideTaskFailureNotice();
      return;
    }
    showTaskFailureNotice(
      "Task stopped before completion",
      event.result || "Lumi could not finish the requested action chain.",
      `${event.taskId}:done:${event.reason || "failed"}`,
    );
    return;
  }
  if (
    change !== "replace"
    || event?.type !== "step"
    || event.action?.status !== "failed"
    || event.action?.name === AGENT_DONE_ACTION_NAME
  ) return;
  const detail = String(event.action.error || "The action failed unexpectedly.");
  if (/cancelled|interrupted|session ended/i.test(detail)) return;
  const actionLabel = String(event.action.name || "action")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  showTaskFailureNotice(
    `Action failed at step ${event.stepNumber || "?"}`,
    `${actionLabel}: ${detail}`,
    `${event.taskId}:${event.id}:${detail}`,
  );
}

const taskOrchestrator = createTaskOrchestrator({
  maxSteps: DEFAULT_AGENT_MAX_STEPS,
  onHistoryChange: (history, event, change) => {
    if (change === "restore") taskStepView.hydrate(history);
    else taskStepView.render(history);
    syncTaskFailureNotice(event, change);
    scheduleActiveChatSnapshotPersist();
  },
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

async function captureCurrentTabFrame() {
  if (activeTabFrameCapture) return activeTabFrameCapture;
  activeTabFrameCapture = (async () => {
    try {
      const currentWindow = await chrome.windows.getCurrent();
      const frame = await sendRuntime("capture_tab_context_frame", {
        windowId: currentWindow?.id,
      });
      if (!frame?.captured || !frame.data || !frame.mimeType) {
        return {
          frame: null,
          reason: frame?.reason || "Chrome returned no screenshot data.",
        };
      }
      return {
        frame: {
          data: frame.data,
          mimeType: frame.mimeType,
        },
        source: frame.source || null,
        reason: "",
      };
    } catch (error) {
      return {
        frame: null,
        reason: error instanceof Error ? error.message : "Chrome could not capture the active tab.",
      };
    }
  })();
  try {
    return await activeTabFrameCapture;
  } finally {
    activeTabFrameCapture = null;
  }
}

async function captureAndSendVisualInspectionFrame() {
  const { frame, source, reason } = await captureCurrentTabFrame();
  if (!frame || sessionStatus !== "ready" || websocket?.readyState !== WebSocket.OPEN) {
    throw new Error(reason || "Lumi could not capture the visible active tab for visual inspection.");
  }
  if (!sendJson({ realtimeInput: { video: frame } })) {
    throw new Error("Lumi captured the active tab but could not deliver the visual context to the model.");
  }
  await new Promise((resolve) => setTimeout(resolve, VISUAL_CONTEXT_SETTLE_MS));
  return {
    success: true,
    inspected: true,
    source,
    delivery: "best_effort_realtime_visual_context",
    guidance: "A fresh screenshot was sent as supplemental private visual context, but realtime media ordering is not proof that it was inspected before this response. Immediately obtain fresh semantic page state and base every indexed action on that state; use the screenshot only to resolve visual ambiguity.",
  };
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

function formatImageAttachmentSize(byteSize) {
  const size = Math.max(0, Number(byteSize) || 0);
  return size >= 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
}

function renderPendingImageAttachment() {
  elements.imageAttachmentTray.replaceChildren();
  elements.imageAttachmentTray.hidden = !pendingImageAttachment;
  if (!pendingImageAttachment) return;

  const card = document.createElement("div");
  card.className = "image-attachment-card";
  const preview = document.createElement("img");
  preview.src = pendingImageAttachment.previewDataUrl;
  preview.alt = `Attached image ${pendingImageAttachment.name}`;
  const copy = document.createElement("div");
  copy.className = "image-attachment-copy";
  const name = document.createElement("strong");
  name.textContent = pendingImageAttachment.name;
  const details = document.createElement("span");
  details.textContent = `${pendingImageAttachment.width} × ${pendingImageAttachment.height} · ${formatImageAttachmentSize(pendingImageAttachment.byteSize)}`;
  copy.append(name, details);
  const remove = document.createElement("button");
  remove.className = "image-attachment-remove";
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove attached image");
  remove.title = "Remove attached image";
  remove.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18"></path>
    </svg>
  `;
  remove.addEventListener("click", () => {
    pendingImageAttachment = null;
    renderPendingImageAttachment();
    syncMessageComposer();
    elements.messageInput.focus();
  });
  card.append(preview, copy, remove);
  elements.imageAttachmentTray.append(card);
}

function clearPendingImageAttachment() {
  pendingImageAttachment = null;
  elements.imageAttachmentInput.value = "";
  renderPendingImageAttachment();
}

async function attachImageFiles(files) {
  const selectedFiles = Array.from(files || []);
  const file = selectedFiles[0];
  if (isLiveTranslationChatLocked()) {
    elements.statusLine.textContent = "Stop Live Translate before attaching or sending a message.";
    return false;
  }
  if (!file || imageAttachmentPending) {
    if (!file) elements.statusLine.textContent = "Drop or paste a JPEG, PNG, WebP, or GIF image.";
    return false;
  }

  imageAttachmentPending = true;
  syncMessageComposer();
  elements.statusLine.textContent = "Preparing image attachment…";
  try {
    const attachment = await prepareImageAttachment(file);
    pendingImageAttachment = attachment;
    renderPendingImageAttachment();
    elements.statusLine.textContent = selectedFiles.length > 1
      ? `Attached ${attachment.name}. Lumi sends one image per message, so the remaining images were skipped.`
      : `Attached ${attachment.name}. Add a message or send the image now.`;
    return true;
  } catch (error) {
    elements.statusLine.textContent = error instanceof Error
      ? `Could not attach image: ${error.message}`
      : "Could not attach this image.";
    return false;
  } finally {
    imageAttachmentPending = false;
    elements.imageAttachmentInput.value = "";
    syncMessageComposer();
  }
}

function syncMessageComposer() {
  const ready = sessionStatus === "ready";
  const transportReady = isGeminiTransportReady();
  const translationLocked = isLiveTranslationChatLocked();
  const hasText = Boolean(elements.messageInput.value.trim());
  const hasContent = hasText || Boolean(pendingImageAttachment);
  const cancelMode = !translationLocked
    && ready
    && agentTurnActive
    && !turnCancellationPending
    && !hasContent;
  const queueMode = ready
    && !translationLocked
    && (agentTurnActive || turnCancellationPending || !transportReady)
    && hasContent;
  elements.messageForm.classList.toggle("is-translation-locked", translationLocked);
  elements.messageForm.setAttribute("aria-busy", String(translationLocked));
  elements.messageInput.disabled = textSendPending || translationLocked;
  elements.messageInput.placeholder = translationLocked
    ? "Stop translation to chat"
    : textSendPending
    ? "Sending…"
    : ready
    ? turnCancellationPending
      ? "Next message…"
      : agentTurnActive ? "Queue a message…" : "Message Lumi…"
    : sessionStatus === "connecting"
      ? "Connecting…"
      : "Message Lumi…";
  elements.messageSubmit.dataset.mode = cancelMode ? "cancel" : "send";
  const submitLabel = cancelMode
    ? "Cancel current action"
    : queueMode ? "Add message to queue" : "Send message";
  elements.messageSubmit.setAttribute("aria-label", submitLabel);
  elements.messageSubmit.title = submitLabel;
  elements.imageAttachmentButton.disabled =
    translationLocked
    || textSendPending
    || imageAttachmentPending;
  elements.messageSubmit.disabled =
    translationLocked
    || textSendPending
    || imageAttachmentPending
    || (!hasContent && !cancelMode);
  elements.muteButton.disabled = !canUseMicrophoneControl();
}

function syncQueuedMessagePanel() {
  const count = queuedUserMessages.length;
  elements.messageQueue.hidden = count === 0;
  if (!count) return;
  const preview = queuedImageMessagePreview(queuedUserMessages[0]);
  elements.messageQueuePreview.textContent = preview;
  elements.messageQueuePreview.title = preview;
  elements.messageQueueCount.textContent = count > 1 ? `+${count - 1}` : "";
  const translationLocked = isLiveTranslationChatLocked();
  elements.messageQueueSteer.disabled =
    translationLocked
    || turnCancellationPending
    || !isGeminiTransportReady();
  elements.messageQueueSteer.title = translationLocked
    ? "Stop Live Translate before sending a queued message"
    : isGeminiTransportReady()
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
  pendingToolActionNames.clear();
  taskOrchestrator.cancelTask(message);
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
  finishTurnWork({ cancelled: true });
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
  if (sessionConnectionOptions) {
    sessionConnectionOptions = {
      ...sessionConnectionOptions,
      thinkingLevel: nextLevel,
    };
  }
  elements.statusLine.textContent =
    `Thinking ${formatThinkingLevel(nextLevel)} saved. The current connection stays active; it applies after the next server rotation.`;
}

function setSessionStatus(nextStatus, message) {
  sessionStatus = nextStatus;
  if (nextStatus !== "ready") agentTurnActive = false;
  if (nextStatus !== "ready") turnCancellationPending = false;
  if (nextStatus !== "error") elements.microphoneHelpButton.hidden = true;
  elements.statusLine.textContent = message;
  elements.muteButton.disabled = !canUseMicrophoneControl();
  elements.thinkingButton.disabled = isLiveTranslationChatLocked();
  elements.thinkingButton.title = "Choose how deeply Gemini reasons without closing the current connection";
  syncMessageComposer();
  syncQueuedMessagePanel();
  syncTranslationSensitiveControls();
  avatarController.syncState();
}

function clearSetupTimeout(socket = null) {
  if (socket) {
    const timeoutId = socket.lumiSetupTimeoutId;
    if (timeoutId !== null && timeoutId !== undefined) {
      clearTimeout(timeoutId);
      setupTimeoutIds.delete(timeoutId);
      socket.lumiSetupTimeoutId = null;
    }
    return;
  }
  for (const timeoutId of setupTimeoutIds) clearTimeout(timeoutId);
  setupTimeoutIds.clear();
  if (websocket) websocket.lumiSetupTimeoutId = null;
  if (pendingSessionHandoffSocket) pendingSessionHandoffSocket.lumiSetupTimeoutId = null;
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

function openSettings() {
  return chrome.runtime.openOptionsPage();
}

function hideConnectionNotice() {
  elements.connectionNotice.hidden = true;
  elements.connectionNoticeAction.disabled = false;
  elements.connectionNoticeSettings.disabled = false;
  elements.connectionNoticeSettings.hidden = true;
}

function disposeRestoredTranscriptDisclosures() {
  for (const disclosure of restoredTranscriptDisclosures) disclosure.dispose();
  restoredTranscriptDisclosures.clear();
}

function createTranscriptSnapshotHtml() {
  const clone = elements.transcript.cloneNode(true);
  for (const node of clone.querySelectorAll("[style]")) {
    node.removeAttribute("style");
  }
  for (const disclosure of clone.querySelectorAll(
    ".message-thinking, .mcp-activity, .agent-step-card",
  )) {
    disclosure.dataset.expanded = String(disclosure.open === true);
    const summary = disclosure.querySelector(":scope > summary");
    summary?.setAttribute("aria-expanded", String(disclosure.open === true));
  }
  return clone.innerHTML;
}

function sanitizeStoredTranscriptHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  for (const blocked of template.content.querySelectorAll(
    "script, style, iframe, object, embed, form, input, textarea, select, meta, link",
  )) {
    blocked.remove();
  }
  for (const node of template.content.querySelectorAll("*")) {
    node.removeAttribute("style");
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const content = attribute.value.trim();
      const isUrlAttribute = name === "href" || name === "src";
      const safeDataImage = /^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(
        content,
      );
      if (
        name.startsWith("on")
        || name === "srcdoc"
        || (isUrlAttribute && !safeDataImage && !isSafeMarkdownUrl(content))
      ) {
        node.removeAttribute(attribute.name);
      }
    }
  }
  return template.innerHTML;
}

function attachRestoredTranscriptDisclosures({ includeTaskSteps = false } = {}) {
  disposeRestoredTranscriptDisclosures();
  const selector = includeTaskSteps
    ? ".message-thinking, .mcp-activity, .agent-step-card"
    : ".message-thinking, .mcp-activity";
  for (const root of elements.transcript.querySelectorAll(selector)) {
    const summary = root.querySelector(":scope > summary");
    const body = root.querySelector(
      ":scope > .thinking-summary-body, :scope > .mcp-activity-body, :scope > .agent-step-body",
    );
    if (!summary || !body) continue;
    restoredTranscriptDisclosures.add(attachAnimatedDisclosure({
      root,
      summary,
      body,
      initiallyExpanded: root.open || root.dataset.expanded === "true",
    }));
  }
}

async function persistActiveChatSessionSnapshot() {
  if (chatSnapshotPersistenceSuspended) return null;
  const activeSession = getActiveChatSession();
  if (!activeSession?.id) return null;
  return chatSnapshotStore.save({
    sessionId: activeSession.id,
    transcriptHtml: createTranscriptSnapshotHtml(),
    transcriptScrollTop: elements.transcript.scrollTop,
    taskHistory: taskOrchestrator.history,
  });
}

function scheduleActiveChatSnapshotPersist() {
  if (chatSnapshotPersistenceSuspended) return;
  clearTimeout(chatSnapshotPersistTimerId);
  chatSnapshotPersistTimerId = setTimeout(() => {
    chatSnapshotPersistTimerId = null;
    void persistActiveChatSessionSnapshot().catch(() => {});
  }, 80);
}

async function flushActiveChatSnapshotPersist() {
  clearTimeout(chatSnapshotPersistTimerId);
  chatSnapshotPersistTimerId = null;
  return persistActiveChatSessionSnapshot().catch(() => null);
}

async function restoreActiveChatSessionSnapshot(session) {
  const snapshot = await chatSnapshotStore.load(session?.id).catch(() => null);
  taskOrchestrator.restore([]);
  if (!snapshot?.transcriptHtml) return false;
  elements.transcript.innerHTML = sanitizeStoredTranscriptHtml(
    snapshot.transcriptHtml,
  );
  for (const row of elements.transcript.querySelectorAll('.turn-work-status[data-state="working"]')) {
    row.dataset.state = "cancelled";
    const label = row.querySelector(".turn-work-label");
    if (label) label.textContent = "Phiên xử lý đã kết thúc sau";
  }
  if (snapshot.taskHistory.length) {
    taskOrchestrator.restore(snapshot.taskHistory);
  }
  attachRestoredTranscriptDisclosures({
    includeTaskSteps: snapshot.taskHistory.length === 0,
  });
  requestAnimationFrame(() => {
    elements.transcript.scrollTop = Math.min(
      snapshot.transcriptScrollTop,
      Math.max(0, elements.transcript.scrollHeight - elements.transcript.clientHeight),
    );
    transcriptAutoFollow = isScrollAtBottom(elements.transcript);
  });
  return true;
}

function createChatSessionId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createBlankChatSession() {
  const timestamp = Date.now();
  return createLocalChatSession({
    id: createChatSessionId(),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function getActiveChatSession() {
  return chatHistoryState.sessions.find(
    (session) => session.id === chatHistoryState.activeSessionId,
  ) || null;
}

function ensureActiveChatSession() {
  const existing = getActiveChatSession();
  if (existing) return existing;
  const session = createBlankChatSession();
  chatHistoryState = normalizeLocalChatHistoryState({
    ...chatHistoryState,
    activeSessionId: session.id,
    sessions: [session, ...chatHistoryState.sessions],
  });
  return getActiveChatSession();
}

function formatChatSessionTime(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const startOfDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const dayDifference = Math.round(
    (startOfToday.getTime() - startOfDate.getTime()) / 86400000,
  );
  if (dayDifference === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (dayDifference === 1) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderChatSessionList() {
  const activeSession = ensureActiveChatSession();
  elements.activeChatTitle.textContent = activeSession.title;
  elements.chatSessionList.innerHTML = "";
  elements.chatSessionEmpty.hidden = chatHistoryState.sessions.length > 0;
  for (const session of chatHistoryState.sessions) {
    const row = document.createElement("article");
    row.className = "chat-session-row";
    row.classList.toggle("is-active", session.id === activeSession.id);
    row.setAttribute("role", "listitem");

    const openButton = document.createElement("button");
    openButton.className = "chat-session-open";
    openButton.type = "button";
    openButton.dataset.chatSessionId = session.id;
    openButton.disabled = chatSessionMutationPending || isLiveTranslationChatLocked();
    openButton.setAttribute(
      "aria-current",
      session.id === activeSession.id ? "true" : "false",
    );

    const title = document.createElement("span");
    title.className = "chat-session-title";
    title.textContent = session.title;
    const time = document.createElement("time");
    time.className = "chat-session-time";
    time.dateTime = new Date(session.updatedAt).toISOString();
    time.textContent = formatChatSessionTime(session.updatedAt);
    const preview = document.createElement("span");
    preview.className = "chat-session-preview";
    preview.textContent = session.turns.at(-1)?.text || "Empty conversation";
    openButton.append(title, time, preview);

    const deleteButton = document.createElement("button");
    deleteButton.className = "chat-session-delete";
    deleteButton.type = "button";
    deleteButton.dataset.deleteChatSessionId = session.id;
    deleteButton.disabled = chatSessionMutationPending || isLiveTranslationChatLocked();
    deleteButton.setAttribute("aria-label", `Delete ${session.title}`);
    deleteButton.title = "Delete chat";
    deleteButton.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path>
      </svg>
    `;

    row.append(openButton, deleteButton);
    elements.chatSessionList.append(row);
  }
}

function setChatSessionMutationPending(pending) {
  chatSessionMutationPending = pending === true;
  syncTranslationSensitiveControls();
  syncMessageComposer();
  elements.clearHistoryButton.disabled = chatSessionMutationPending;
  renderChatSessionList();
}

function removeSnapshotsForDroppedSessions(previousSessions, nextSessions) {
  const retainedIds = new Set(nextSessions.map((session) => session.id));
  for (const session of previousSessions) {
    if (retainedIds.has(session.id)) continue;
    void chatSnapshotStore.delete(session.id).catch(() => {});
  }
}

function syncActiveChatSessionFromMemory({ touch = true } = {}) {
  const activeSession = ensureActiveChatSession();
  const turns = normalizeLocalChatHistory(localChatHistory);
  const updatedSession = createLocalChatSession({
    ...activeSession,
    title: deriveLocalChatSessionTitle(turns, activeSession.title),
    updatedAt: touch && turns.length ? Date.now() : activeSession.updatedAt,
    turns,
  });
  const previousSessions = chatHistoryState.sessions;
  chatHistoryState = normalizeLocalChatHistoryState({
    ...chatHistoryState,
    activeSessionId: updatedSession.id,
    sessions: chatHistoryState.sessions.map((session) => (
      session.id === updatedSession.id ? updatedSession : session
    )),
  });
  removeSnapshotsForDroppedSessions(previousSessions, chatHistoryState.sessions);
  renderChatSessionList();
  return getActiveChatSession();
}

async function renderActiveChatSession() {
  const activeSession = ensureActiveChatSession();
  const restored = normalizeLocalChatHistory(activeSession.turns);
  localChatHistory.splice(0, localChatHistory.length, ...restored);
  const recentConversation = trimConversationHistory(restored);
  conversationHistory.splice(
    0,
    conversationHistory.length,
    ...recentConversation,
  );
  const previousSnapshotSuspension = chatSnapshotPersistenceSuspended;
  chatSnapshotPersistenceSuspended = true;
  try {
    disposeRestoredTranscriptDisclosures();
    const snapshotRestored = await restoreActiveChatSessionSnapshot(activeSession);
    if (!snapshotRestored) {
      elements.transcript.innerHTML = restored.length ? "" : initialTranscriptMarkup;
      for (const turn of restored) {
        const role = turn.role === "model" ? "lumi" : "user";
        const message = createMessage(role, turn.text);
        if (role === "lumi") {
          renderMarkdown(message.content, turn.text);
          message.visibleText = turn.text;
        }
      }
      transcriptAutoFollow = true;
      scrollTranscriptToLatest({ force: true });
    }
  } finally {
    chatSnapshotPersistenceSuspended = previousSnapshotSuspension;
  }
  renderChatSessionList();
  return restored.length;
}

function rememberConversationTurn(role, text) {
  const normalizedRole = role === "model" || role === "lumi" ? "model" : role === "user" ? "user" : "";
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalizedRole || !clean) return;
  const previous = localChatHistory.at(-1);
  if (previous?.role === normalizedRole && previous.text === clean) return;
  const turn = { role: normalizedRole, text: clean };
  localChatHistory.push(turn);
  const retainedLocalHistory = normalizeLocalChatHistory(localChatHistory);
  localChatHistory.splice(
    0,
    localChatHistory.length,
    ...retainedLocalHistory,
  );
  const recentHistory = trimConversationHistory(localChatHistory);
  conversationHistory.splice(0, conversationHistory.length, ...recentHistory);
  syncActiveChatSessionFromMemory();
  void chatHistoryStore.save(chatHistoryState).catch(() => {});
  scheduleActiveChatSnapshotPersist();
}

async function restoreLocalChatHistory() {
  chatHistoryState = await chatHistoryStore.load().catch(
    () => normalizeLocalChatHistoryState(null),
  );
  ensureActiveChatSession();
  const restoredCount = await renderActiveChatSession();
  await chatHistoryStore.save(chatHistoryState).catch(() => {});
  return restoredCount;
}

function openChatHistory() {
  renderChatSessionList();
  if (!elements.chatHistoryDialog.open) elements.chatHistoryDialog.showModal();
  elements.chatHistoryButton.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => elements.chatHistoryCloseButton.focus());
}

function closeChatHistory() {
  if (elements.chatHistoryDialog.open) elements.chatHistoryDialog.close();
  elements.chatHistoryButton.setAttribute("aria-expanded", "false");
}

function resolveChatConfirmation(confirmed) {
  const resolve = pendingChatConfirmationResolve;
  pendingChatConfirmationResolve = null;
  if (elements.chatConfirmationDialog.open) {
    elements.chatConfirmationDialog.close();
  }
  resolve?.(confirmed === true);
}

function requestChatConfirmation({
  title,
  message,
  confirmLabel = "Delete",
} = {}) {
  if (pendingChatConfirmationResolve) return Promise.resolve(false);
  elements.chatConfirmationTitle.textContent = String(title || "Confirm deletion");
  elements.chatConfirmationMessage.textContent = String(
    message || "This action cannot be undone.",
  );
  elements.chatConfirmationConfirm.textContent = String(confirmLabel || "Delete");
  elements.chatConfirmationDialog.showModal();
  requestAnimationFrame(() => elements.chatConfirmationCancel.focus());
  return new Promise((resolve) => {
    pendingChatConfirmationResolve = resolve;
  });
}

async function runChatSessionMutation(operation) {
  if (chatSessionMutationPending) return false;
  setChatSessionMutationPending(true);
  try {
    return await operation();
  } finally {
    setChatSessionMutationPending(false);
  }
}

async function startNewChatSession() {
  if (isLiveTranslationChatLocked()) {
    elements.statusLine.textContent = "Stop Live Translate before starting another chat.";
    return false;
  }
  return runChatSessionMutation(async () => {
    let currentSession = getActiveChatSession();
    const currentSessionIsReusable = currentSession?.turns.length === 0
      && !sessionHasInFlightWork()
      && !partialMessages.user
      && !partialMessages.lumi
      && !partialMessages.thinking
      && queuedUserMessages.length === 0;
    if (currentSessionIsReusable) {
      const previousSessions = chatHistoryState.sessions;
      chatHistoryState = normalizeLocalChatHistoryState({
        ...chatHistoryState,
        sessions: previousSessions.filter(
          (session) => session.id === currentSession.id || session.turns.length,
        ),
      });
      removeSnapshotsForDroppedSessions(previousSessions, chatHistoryState.sessions);
      await chatHistoryStore.save(chatHistoryState);
      closeChatHistory();
      elements.statusLine.textContent = "This New chat is already empty.";
      elements.messageInput.focus();
      return true;
    }
    cancelConversationWorkForChatChange();
    await flushActiveChatSnapshotPersist();
    currentSession = getActiveChatSession();
    const reusableBlank = findReusableBlankChatSession(
      chatHistoryState.sessions,
      currentSession?.turns.length ? "" : currentSession?.id,
    );
    const nextSession = reusableBlank
      ? { ...reusableBlank, updatedAt: Date.now() }
      : createBlankChatSession();
    await chatSnapshotStore.delete(nextSession.id);
    clearConversationContext();
    const previousSessions = chatHistoryState.sessions;
    chatHistoryState = normalizeLocalChatHistoryState({
      ...chatHistoryState,
      activeSessionId: nextSession.id,
      sessions: [
        nextSession,
        ...chatHistoryState.sessions.filter(
          (session) => session.id !== nextSession.id && session.turns.length,
        ),
      ],
    });
    removeSnapshotsForDroppedSessions(previousSessions, chatHistoryState.sessions);
    await renderActiveChatSession();
    await chatHistoryStore.save(chatHistoryState);
    closeChatHistory();
    elements.messageInput.focus();
    elements.statusLine.textContent = "New chat is ready. Connection stays active.";
    return true;
  });
}

async function activateChatSession(sessionId) {
  if (isLiveTranslationChatLocked()) {
    elements.statusLine.textContent = "Stop Live Translate before switching chats.";
    return false;
  }
  const requestedSessionId = String(sessionId || "");
  if (!requestedSessionId || requestedSessionId === chatHistoryState.activeSessionId) {
    closeChatHistory();
    return false;
  }
  return runChatSessionMutation(async () => {
    const selectedSession = chatHistoryState.sessions.find(
      (session) => session.id === requestedSessionId,
    );
    if (!selectedSession) return false;
    cancelConversationWorkForChatChange();
    await flushActiveChatSnapshotPersist();
    clearConversationContext();
    chatHistoryState = normalizeLocalChatHistoryState({
      ...chatHistoryState,
      activeSessionId: selectedSession.id,
    });
    await renderActiveChatSession();
    await chatHistoryStore.save(chatHistoryState);
    closeChatHistory();
    elements.statusLine.textContent =
      `Opened “${selectedSession.title}”. Connection stays active.`;
    return true;
  });
}

async function deleteChatSession(sessionId) {
  const selectedSession = chatHistoryState.sessions.find(
    (session) => session.id === sessionId,
  );
  if (!selectedSession) return false;
  const confirmed = await requestChatConfirmation({
    title: "Delete chat?",
    message: `Delete “${selectedSession.title}” from this device?`,
    confirmLabel: "Delete chat",
  });
  if (!confirmed) return false;
  return runChatSessionMutation(async () => {
    const deletingActiveSession = selectedSession.id === chatHistoryState.activeSessionId;
    if (deletingActiveSession) cancelConversationWorkForChatChange();
    if (deletingActiveSession) await flushActiveChatSnapshotPersist();
    const remainingSessions = chatHistoryState.sessions.filter(
      (session) => session.id !== selectedSession.id,
    );
    const fallbackSession = remainingSessions[0] || createBlankChatSession();
    chatHistoryState = normalizeLocalChatHistoryState({
      ...chatHistoryState,
      activeSessionId: deletingActiveSession
        ? fallbackSession.id
        : chatHistoryState.activeSessionId,
      sessions: remainingSessions.length ? remainingSessions : [fallbackSession],
    });
    if (deletingActiveSession) {
      clearConversationContext();
      await renderActiveChatSession();
    } else {
      renderChatSessionList();
    }
    await chatSnapshotStore.delete(selectedSession.id);
    await chatHistoryStore.save(chatHistoryState);
    elements.statusLine.textContent = deletingActiveSession
      ? "Chat deleted. Connection stays active."
      : "Chat deleted from this device.";
    return true;
  });
}

async function clearLocalChatHistory() {
  const confirmed = await requestChatConfirmation({
    title: "Clear all chats?",
    message: "Clear every saved Lumi chat on this device and start a new conversation?",
    confirmLabel: "Clear all",
  });
  if (!confirmed) return false;
  return runChatSessionMutation(async () => {
    cancelConversationWorkForChatChange();
    clearConversationContext();
    const session = createBlankChatSession();
    chatHistoryState = normalizeLocalChatHistoryState({
      activeSessionId: session.id,
      sessions: [session],
    });
    await chatSnapshotStore.clear();
    await renderActiveChatSession();
    await chatHistoryStore.clear();
    await chrome.storage.local.remove(VIDEO_ANALYSES_STORAGE_KEY);
    await chatHistoryStore.save(chatHistoryState);
    closeChatHistory();
    elements.statusLine.textContent =
      "All chats and saved video transcripts cleared. Connection stays active.";
    return true;
  });
}

function buildPendingConversationBoundaryPrompt() {
  if (!pendingConversationBoundary) return "";
  const selectedHistory = conversationHistory
    .slice(-8)
    .map((turn) => `${turn.role === "model" ? "Lumi" : "User"}: ${String(turn.text || "").trim()}`)
    .filter((line) => !/:\s*$/.test(line))
    .join("\n")
    .slice(-6000);
  return [
    NEW_CHAT_CONTEXT_BOUNDARY,
    "Start an independent chat now. Ignore every request, task, tool result, and conversation turn before this boundary.",
    "This boundary is controller metadata, not a user request. Do not answer or call tools for it; wait for the user's spoken request that follows.",
    selectedHistory
      ? `[Selected chat history]\n${selectedHistory}`
      : "This new chat has no earlier messages.",
  ].join("\n\n");
}

function sendPendingConversationBoundary() {
  const boundaryPrompt = buildPendingConversationBoundaryPrompt();
  if (!boundaryPrompt) return true;
  const sent = sendJson({ realtimeInput: { text: boundaryPrompt } });
  if (sent) pendingConversationBoundary = false;
  return sent;
}

function cancelConversationWorkForChatChange() {
  if (!sessionHasInFlightWork() && !agentTurnActive && !pendingToolCallIds.size) return;
  clearTurnCancellationTimers();
  clearTurnCancellationBoundaryTimeout();
  turnExecutionSequence += 1;
  userTurnAuthorized = false;
  activeTurnUserRequest = "";
  turnCancellationPending = false;
  suppressServerOutputUntilNextUserTurn = true;
  cancelledTurnBoundarySeen = true;
  freshUserInputStarted = false;
  const cancelledResponses = resetPendingTurnExecution("Cancelled because the user changed chats.");
  if (cancelledResponses.length) {
    sendJson({ toolResponse: { functionResponses: cancelledResponses } });
  }
  sendJson({ realtimeInput: { audioStreamEnd: true } });
  void Promise.allSettled([
    sendRuntime("cancel_active_browser_action"),
    sendRuntime("cancel_active_mcp_calls"),
    sendRuntime("cancel_video_analysis"),
  ]);
  setAgentTurnActive(false);
}

function clearConversationContext() {
  conversationContextEpoch += 1;
  pendingConversationBoundary = true;
  const previousSnapshotSuspension = chatSnapshotPersistenceSuspended;
  chatSnapshotPersistenceSuspended = true;
  clearTimeout(chatSnapshotPersistTimerId);
  chatSnapshotPersistTimerId = null;
  try {
    for (const message of activeTranscriptReveals) {
      cancelAnimationFrame(message.revealFrameId);
    }
    activeTranscriptReveals.clear();
    disposeRestoredTranscriptDisclosures();
    if (thinkingCollapseFrameId !== null) cancelAnimationFrame(thinkingCollapseFrameId);
    thinkingCollapseFrameId = null;
    completedThinkingMessagesAwaitingContent.clear();
    lumiContentSequence = 0;
    conversationHistory.length = 0;
    localChatHistory.length = 0;
    queuedUserMessages.length = 0;
    userTurnAuthorized = false;
    activeTurnUserRequest = "";
    taskOrchestrator.clear();
    taskStepView.clear();
    clearTimeout(transcriptProgrammaticScrollTimerId);
    transcriptProgrammaticScrollTimerId = null;
    transcriptProgrammaticScroll = false;
    transcriptAutoFollow = true;
    for (const role of Object.keys(partialMessages)) {
      partialMessages[role]?.disclosure?.dispose();
      partialMessages[role] = null;
    }
    elements.transcript.innerHTML = initialTranscriptMarkup;
    elements.messageInput.value = "";
    textSendPending = false;
    imageAttachmentPending = false;
    imageDragDepth = 0;
    elements.messageForm.classList.remove("is-image-dragging");
    clearPendingImageAttachment();
    resizeMessageInput();
    syncMessageComposer();
    syncQueuedMessagePanel();
  } finally {
    chatSnapshotPersistenceSuspended = previousSnapshotSuspension;
  }
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

function scrollTranscriptToLatest({ smooth = false, force = false } = {}) {
  if (!force && (!transcriptAutoFollow || taskStepView.isReviewing)) return false;
  const top = elements.transcript.scrollHeight;
  if (smooth && !fastModeController?.enabled && typeof elements.transcript.scrollTo === "function") {
    transcriptProgrammaticScroll = true;
    clearTimeout(transcriptProgrammaticScrollTimerId);
    elements.transcript.scrollTo({ top, behavior: "smooth" });
    transcriptProgrammaticScrollTimerId = setTimeout(() => {
      transcriptProgrammaticScrollTimerId = null;
      transcriptProgrammaticScroll = false;
      transcriptAutoFollow = isScrollAtBottom(elements.transcript);
    }, 600);
    transcriptAutoFollow = true;
    return true;
  }
  elements.transcript.scrollTop = top;
  transcriptAutoFollow = true;
  return true;
}

function scheduleCompletedThinkingCollapse() {
  if (thinkingCollapseFrameId !== null) return;
  thinkingCollapseFrameId = requestAnimationFrame(() => {
    thinkingCollapseFrameId = null;
    for (const message of completedThinkingMessagesAwaitingContent) {
      message.disclosure?.setExpanded(false);
    }
    completedThinkingMessagesAwaitingContent.clear();
  });
}

function currentTurnHasTaskStepView() {
  return taskOwnsTurn(taskOrchestrator.history, turnExecutionSequence);
}

function removeStandaloneThinkingForTurn(turnSequence) {
  const sequence = Number(turnSequence);
  const current = partialMessages.thinking;
  if (current && current.turnSequence === sequence) {
    cancelAnimationFrame(current.revealFrameId);
    activeTranscriptReveals.delete(current);
    completedThinkingMessagesAwaitingContent.delete(current);
    current.disclosure?.dispose();
    current.article.remove();
    partialMessages.thinking = null;
  }
  for (const message of [...completedThinkingMessagesAwaitingContent]) {
    if (message.turnSequence !== sequence) continue;
    cancelAnimationFrame(message.revealFrameId);
    activeTranscriptReveals.delete(message);
    completedThinkingMessagesAwaitingContent.delete(message);
    message.disclosure?.dispose();
    message.article.remove();
  }
  for (const article of elements.transcript.querySelectorAll(".message-thinking")) {
    if (Number(article.dataset.turnSequence) === sequence) article.remove();
  }
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
    || fastModeController?.enabled
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

function appendMessageTimestamp(article, timestamp = Date.now()) {
  const footer = document.createElement("footer");
  footer.className = "message-meta";
  const time = document.createElement("time");
  const date = new Date(Number(timestamp) || Date.now());
  time.dateTime = date.toISOString();
  time.textContent = formatMessageTimestamp(date.getTime());
  footer.append(time);
  article.append(footer);
  return footer;
}

function ensureTurnWorkIndicator(work = activeTurnWork) {
  if (!work) return null;
  const userMessage = elements.transcript.querySelector(
    `.message-user[data-turn-sequence="${work.turnSequence}"]`,
  );
  if (work.row?.isConnected) {
    // Voice turns can begin before the final user transcript bubble exists.
    // Move the live status beneath that bubble as soon as it is rendered.
    if (userMessage && work.row.previousElementSibling !== userMessage) userMessage.after(work.row);
    return work.row;
  }
  const row = document.createElement("section");
  row.className = "turn-work-status";
  row.dataset.state = "working";
  row.dataset.turnSequence = String(work.turnSequence);
  row.setAttribute("role", "status");
  row.setAttribute("aria-live", "polite");
  const animation = document.createElement("span");
  animation.className = "turn-work-animation";
  animation.setAttribute("aria-hidden", "true");
  animation.append(
    document.createElement("i"),
    document.createElement("i"),
    document.createElement("i"),
  );
  const label = document.createElement("strong");
  label.className = "turn-work-label";
  label.textContent = "Lumi đang xử lý";
  const duration = document.createElement("span");
  duration.className = "turn-work-duration";
  duration.textContent = formatTurnDuration(performance.now() - work.startedAt);
  const chevron = document.createElement("span");
  chevron.className = "turn-work-chevron";
  chevron.setAttribute("aria-hidden", "true");
  row.append(animation, label, duration, chevron);
  if (userMessage) userMessage.after(row);
  else elements.transcript.append(row);
  work.row = row;
  work.label = label;
  work.duration = duration;
  scrollTranscriptToLatest({ smooth: true });
  scheduleActiveChatSnapshotPersist();
  return row;
}

function beginTurnWork(turnSequence) {
  if (activeTurnWork) finishTurnWork({ cancelled: true });
  const work = {
    turnSequence: Number(turnSequence),
    startedAt: performance.now(),
    startedWallTime: Date.now(),
    timerId: null,
    row: null,
    label: null,
    duration: null,
  };
  activeTurnWork = work;
  ensureTurnWorkIndicator(work);
  work.timerId = setInterval(() => {
    if (activeTurnWork !== work) return;
    ensureTurnWorkIndicator(work);
    if (work.duration) {
      work.duration.textContent = formatTurnDuration(performance.now() - work.startedAt);
    }
  }, 1000);
  return work;
}

function finishTurnWork({ cancelled = false } = {}) {
  const work = activeTurnWork;
  if (!work) return null;
  activeTurnWork = null;
  clearInterval(work.timerId);
  ensureTurnWorkIndicator(work);
  const durationMs = Math.max(0, performance.now() - work.startedAt);
  if (work.row) work.row.dataset.state = cancelled ? "cancelled" : "complete";
  if (work.label) work.label.textContent = cancelled ? "Đã dừng sau" : "Xử lý trong";
  if (work.duration) work.duration.textContent = formatTurnDuration(durationMs);
  scheduleActiveChatSnapshotPersist();
  return { durationMs, turnSequence: work.turnSequence };
}

function createMessage(role, text, { attachment = null, createdAt = Date.now() } = {}) {
  if (role === "thinking") {
    const details = document.createElement("details");
    details.className = "message-thinking";
    details.dataset.state = "streaming";
    details.dataset.turnSequence = String(turnExecutionSequence);
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
      turnSequence: turnExecutionSequence,
      visibleText: text,
      lumiContentSequenceAtCreation: lumiContentSequence,
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
  article.dataset.turnSequence = String(turnExecutionSequence);
  if (role === "user" && attachment) article.classList.add("message-attachment");
  const author = document.createElement("span");
  author.textContent = role === "lumi" ? "Lumi" : "You";
  const content = document.createElement(role === "lumi" ? "div" : "p");
  if (role === "lumi") content.className = "message-content";
  content.textContent = text;
  article.append(author);
  if (role === "user" && attachment) {
    const image = document.createElement("img");
    image.className = "message-attachment-preview";
    image.src = attachment.previewDataUrl;
    image.alt = attachment.name || "Attached image";
    article.append(image);
  }
  article.append(content);
  appendMessageTimestamp(article, createdAt);
  elements.transcript.append(article);
  if (role === "user") ensureTurnWorkIndicator();
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
  scheduleActiveChatSnapshotPersist();
}

function createTranscriptDownloadMessage(downloadInfo, analysis) {
  const text = String(downloadInfo?.text || "");
  if (!text) return;
  const article = document.createElement("article");
  article.className = "message message-lumi message-transcript-download";
  const author = document.createElement("span");
  author.textContent = "Video transcript";
  const body = document.createElement("div");
  body.className = "transcript-download-body";
  const mark = document.createElement("span");
  mark.className = "transcript-download-mark";
  mark.textContent = "TXT";
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = downloadInfo.filename || "video-transcript.txt";
  const meta = document.createElement("small");
  const characterCount = Number(analysis?.transcriptCharacterCount) || text.length;
  meta.textContent = `${characterCount.toLocaleString()} characters · ${analysis?.sourceMethod || "video analysis"}`;
  copy.append(title, meta);
  const download = document.createElement("a");
  download.href = `data:${downloadInfo.mimeType || "text/plain;charset=utf-8"},${encodeURIComponent(text)}`;
  download.download = downloadInfo.filename || "video-transcript.txt";
  download.textContent = "Download transcript";
  body.append(mark, copy, download);
  article.append(author, body);
  elements.transcript.append(article);
  scrollTranscriptToLatest({ smooth: true });
  scheduleActiveChatSnapshotPersist();
}

function createVideoSummaryPresentationMessage(markdown) {
  const presentation = String(markdown || "").trim();
  if (!presentation) return false;
  finalizeTranscript("lumi");
  directVideoPresentationTurnSequence = turnExecutionSequence;
  const message = createMessage("lumi", presentation);
  renderMarkdown(message.content, presentation);
  message.visibleText = presentation;
  rememberConversationTurn("lumi", presentation);
  scheduleCompletedThinkingCollapse();
  scheduleActiveChatSnapshotPersist();
  scrollTranscriptToLatest({ smooth: true });
  return true;
}

function updateTranscript(role, incoming) {
  const clean = String(incoming || "").trim();
  if (!clean) return;
  if (role === "lumi" && directVideoPresentationTurnSequence === turnExecutionSequence) return;
  if (role === "thinking" && currentTurnHasTaskStepView()) return;
  if (role === "lumi") lumiContentSequence += 1;
  if (!partialMessages[role]) {
    partialMessages[role] = createMessage(role, role === "user" ? clean : "");
  }
  const message = partialMessages[role];
  const wasPlaceholder = role === "thinking" && message.placeholder;
  message.text = wasPlaceholder ? clean : mergeTranscriptText(message.text, clean);
  if (role === "user") activeTurnUserRequest = message.text;
  message.placeholder = false;
  if (wasPlaceholder) {
    message.content.textContent = "";
    message.visibleText = "";
  }
  if (role === "thinking" || role === "lumi") revealTranscriptText(message, message.text);
  else message.content.textContent = message.text;
  if (role === "lumi") scheduleCompletedThinkingCollapse();
  if (role === "thinking") {
    const message = partialMessages.thinking;
    message.article.dataset.state = "streaming";
    message.status.textContent = "Streaming";
    scrollTranscriptToLatest();
  }
  scrollTranscriptToLatest();
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
  if (role === "thinking" && message) {
    cancelAnimationFrame(message.revealFrameId);
    activeTranscriptReveals.delete(message);
    setVisibleTranscriptText(message, message.text);
    message.article.dataset.state = "complete";
    message.status.textContent = "Complete";
    completedThinkingMessagesAwaitingContent.add(message);
    if (lumiContentSequence > message.lumiContentSequenceAtCreation) {
      scheduleCompletedThinkingCollapse();
    }
    scrollTranscriptToLatest();
  }
  partialMessages[role] = null;
  scheduleActiveChatSnapshotPersist();
}

function sendJson(payload, targetSocket = websocket) {
  if (targetSocket?.readyState !== WebSocket.OPEN) return false;
  try {
    targetSocket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function isTrackedGeminiSocket(socket) {
  return socket === websocket || socket === pendingSessionHandoffSocket;
}

function isGeminiTransportReady() {
  return Boolean(
    sessionStatus === "ready"
    && !backgroundSessionReconnectPending
    && websocket?.readyState === WebSocket.OPEN
    && websocket.lumiSetupComplete,
  );
}

function clearAutomaticSessionReconnectTimer() {
  if (automaticSessionReconnectTimerId === null) return;
  clearTimeout(automaticSessionReconnectTimerId);
  automaticSessionReconnectTimerId = null;
}

function sessionHasInFlightWork() {
  return Boolean(
    agentTurnActive
    || turnCancellationPending
    || panelAudio.isUserSpeechActive()
    || browserToolRunning
    || pendingToolCallIds.size
    || pendingLiveTranslationStart
    || liveTranslationStopPending
    || textSendPending
  );
}

function scheduleAutomaticSessionReconnect(
  reason,
  {
    delayMs = null,
    allowInFlight = false,
    discardOldContext = false,
  } = {},
) {
  if (
    !shouldMaintainGeminiSession
    || !sessionConnectionOptions
    || automaticSessionReconnectTimerId !== null
    || pendingSessionHandoffSocket
    || (!allowInFlight && sessionHasInFlightWork())
  ) return false;

  const previousSocket = websocket;
  const canHandoffBeforeClosing = Boolean(
    !allowInFlight
    && sessionStatus === "ready"
    && previousSocket?.readyState === WebSocket.OPEN
    && previousSocket.lumiSetupComplete
    && (discardOldContext || sessionResumptionHandle),
  );
  if (
    !allowInFlight
    && previousSocket?.readyState === WebSocket.OPEN
    && !canHandoffBeforeClosing
  ) {
    return false;
  }

  const reconnectInBackground = sessionStatus === "ready"
    || backgroundSessionReconnectPending;
  automaticSessionReconnectAttempt += 1;
  const reconnectDelayMs = delayMs ?? automaticSessionReconnectDelayMs(
    automaticSessionReconnectAttempt,
  );
  serverRotationPending = false;

  if (canHandoffBeforeClosing) {
    backgroundSessionReconnectPending = true;
    openGeminiSocket(sessionConnectionOptions, {
      background: true,
      discardOldContext,
      predecessorSocket: previousSocket,
    });
    return true;
  }

  websocket = null;
  if (previousSocket && previousSocket.readyState < WebSocket.CLOSING) {
    const closeReason = String(reason || "Refreshing Gemini Live session")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    previousSocket.close(1000, closeReason);
  }

  backgroundSessionReconnectPending = reconnectInBackground;
  if (!reconnectInBackground) {
    setSessionStatus("connecting", "Opening Gemini Live...");
  }
  automaticSessionReconnectTimerId = setTimeout(() => {
    automaticSessionReconnectTimerId = null;
    if (!shouldMaintainGeminiSession || !sessionConnectionOptions) return;
    openGeminiSocket(sessionConnectionOptions, {
      background: reconnectInBackground,
      discardOldContext,
    });
  }, reconnectDelayMs);
  return true;
}

function closePendingSessionHandoff(reason = "Ending Gemini Live handoff") {
  const pendingSocket = pendingSessionHandoffSocket;
  pendingSessionHandoffSocket = null;
  if (!pendingSocket) return;
  clearSetupTimeout(pendingSocket);
  if (pendingSocket.readyState < WebSocket.CLOSING) {
    try {
      pendingSocket.close(1000, reason.slice(0, 80));
    } catch {
      // The socket may still be transitioning from CONNECTING to CLOSED.
    }
  }
}

function resetSessionRecoveryState() {
  clearAutomaticSessionReconnectTimer();
  closePendingSessionHandoff();
  shouldMaintainGeminiSession = false;
  sessionConnectionOptions = null;
  sessionResumptionHandle = "";
  automaticSessionReconnectAttempt = 0;
  serverRotationPending = false;
  backgroundSessionReconnectPending = false;
}

function normalizeLiveTranslationUiState(state) {
  const normalized = String(state || "").trim().toLowerCase();
  return [
    "off",
    "connecting",
    "active",
    "reconnecting",
    "stopping",
    "error",
  ].includes(normalized)
    ? normalized
    : "off";
}

function isLiveTranslationChatLocked() {
  return Boolean(
    pendingLiveTranslationStart
    || liveTranslationStopPending
    || LIVE_TRANSLATION_CHAT_LOCK_STATES.has(liveTranslationState),
  );
}

function canUseMicrophoneControl() {
  return !chatSessionMutationPending
    && !isLiveTranslationChatLocked()
    && (sessionStatus === "ready" || sessionStatus === "idle");
}

function syncTranslationSensitiveControls() {
  const translationLocked = isLiveTranslationChatLocked();
  const chatNavigationLocked = chatSessionMutationPending || translationLocked;
  elements.chatHistoryButton.disabled = chatNavigationLocked;
  elements.newChatButton.disabled = chatNavigationLocked;
  elements.historyNewChatButton.disabled = chatNavigationLocked;
  elements.fastModeButton.disabled = translationLocked;
  elements.thinkingButton.disabled = translationLocked;
  if (translationLocked) setThinkingMenuOpen(false);
}

function syncLiveTranslationUi() {
  const wasLocked = liveTranslationChatLocked;
  const translationLocked = isLiveTranslationChatLocked();
  const visibleState = liveTranslationStopPending
    ? "stopping"
    : pendingLiveTranslationStart && liveTranslationState === "off"
      ? "connecting"
      : liveTranslationState;
  liveTranslationChatLocked = translationLocked;
  document.body.classList.toggle("translation-locked", translationLocked);

  if (translationLocked && !wasLocked) {
    resumeMicrophoneAfterTranslation = Boolean(
      sessionStatus === "ready"
      && microphoneEnabled
      && !isMuted,
    );
    if (!isMuted) {
      isMuted = true;
      panelAudio.stopMicrophone();
      sendJson({ realtimeInput: { audioStreamEnd: true } });
      syncMuteButton();
    }
    if (elements.chatHistoryDialog.open) closeChatHistory();
  } else if (!translationLocked && wasLocked) {
    const shouldResumeMicrophone = resumeMicrophoneAfterTranslation;
    resumeMicrophoneAfterTranslation = false;
    if (shouldResumeMicrophone) {
      queueMicrotask(() => {
        if (
          !isLiveTranslationChatLocked()
          && sessionStatus === "ready"
          && microphoneEnabled
          && isMuted
        ) {
          void enableMicrophone({ persistPreference: false, announce: false });
        }
      });
    }
  }

  const languageLabel = liveTranslationTargetLanguageCode
    ? getLiveTranslationLanguageLabel(liveTranslationTargetLanguageCode)
    : "the requested language";
  elements.liveTranslationPanel.hidden = !translationLocked;
  elements.liveTranslationPanel.dataset.state = visibleState;
  elements.liveTranslationPanel.dataset.stopError = String(Boolean(liveTranslationStopError));
  elements.liveTranslationPanelTitle.textContent = visibleState === "active"
    ? `Translating video audio to ${languageLabel}`
    : visibleState === "reconnecting"
      ? "Reconnecting Live Translate"
      : visibleState === "stopping"
        ? "Stopping Live Translate"
        : "Starting Live Translate";
  elements.liveTranslationPanelDetail.textContent = liveTranslationStopError
    ? `${liveTranslationStopError} Translation may still be active; retry Stop translation.`
    : visibleState === "stopping"
      ? "Please wait. Chat will unlock only after translation has fully stopped."
      : "Chat and voice input are paused. Stop translation when you want to talk to Lumi again.";
  elements.stopLiveTranslationButton.disabled = liveTranslationStopPending;
  elements.stopLiveTranslationButton.textContent = liveTranslationStopPending
    ? "Stopping…"
    : "Stop translation";

  syncTranslationSensitiveControls();
  syncMessageComposer();
  syncQueuedMessagePanel();
}

function setLiveTranslationBadge(state, detail = "") {
  liveTranslationState = normalizeLiveTranslationUiState(state);
  if (liveTranslationState === "off" || liveTranslationState === "error") {
    liveTranslationStopError = "";
  }
  const languageCode = normalizeLiveTranslationLanguageCode(detail)
    || liveTranslationTargetLanguageCode
    || "";
  if (languageCode) liveTranslationTargetLanguageCode = languageCode;
  if (liveTranslationState === "off") liveTranslationTargetLanguageCode = "";
  elements.translateBadge.hidden = liveTranslationState === "off";
  elements.translateBadge.className = `badge badge-translate translate-${liveTranslationState}`;
  elements.translateBadge.textContent = liveTranslationState === "active"
    ? `Translate · ${languageCode}`
    : liveTranslationState === "reconnecting"
      ? "Translate · reconnecting"
      : liveTranslationState === "stopping"
        ? "Translate · stopping"
        : liveTranslationState === "error"
          ? "Translate · error"
          : "Translate · joining";
  syncLiveTranslationUi();
}

async function stopLiveTranslationSession({ announce = true } = {}) {
  if (liveTranslationStopPending) {
    return { success: true, state: "stopping", alreadyStopping: true };
  }

  const stateBeforeStop = LIVE_TRANSLATION_CHAT_LOCK_STATES.has(liveTranslationState)
    ? liveTranslationState
    : "active";
  liveTranslationStopError = "";
  liveTranslationStopPending = true;
  pendingLiveTranslationStart = false;
  cancelPendingSharedTabAudioPrompt?.();
  setLiveTranslationBadge("stopping");
  let result;
  try {
    result = await sendRuntime("stop_live_translation");
    setLiveTranslationBadge("off");
    if (announce) {
      elements.statusLine.textContent = result.wasActive
        ? "Live translation stopped. You can chat with Lumi again."
        : "Live translation was already off. Chat is ready.";
    }
    return { success: true, ...result };
  } catch (error) {
    const detail = error instanceof Error
      ? `Could not stop Live Translate: ${error.message}`
      : "Could not stop Live Translate.";
    liveTranslationStopError = detail;
    setLiveTranslationBadge(stateBeforeStop);
    elements.statusLine.textContent = detail;
    throw error;
  } finally {
    sharedTabAudio.stop();
    liveTranslationStopPending = false;
    syncLiveTranslationUi();
  }
}

async function stopLiveTranslationFromUi() {
  try {
    if (sessionStatus === "ready" && agentTurnActive) {
      cancelCurrentTurn();
    }
    await stopLiveTranslationSession();
  } catch {
    avatarController.transitionState("error", { forMs: AVATAR_ERROR_STATE_DURATION_MS });
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
    return stopLiveTranslationSession();
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
  setLiveTranslationBadge("connecting", targetLanguageCode);
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
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    setLiveTranslationBadge(cancelled ? "off" : "error");
    if (!cancelled) {
      avatarController.transitionState("error", { forMs: AVATAR_ERROR_STATE_DURATION_MS });
    }
    throw error;
  } finally {
    pendingLiveTranslationStart = false;
    syncLiveTranslationUi();
  }
  liveTranslationTargetLanguageCode = targetLanguageCode;
  setLiveTranslationBadge("active", targetLanguageCode);
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

async function runVideoAnalysisTool(args = {}) {
  if (!activeApiKey) {
    throw new Error("Connect Lumi before analyzing the current video.");
  }
  avatarController.transitionState("tool_call");
  elements.statusLine.textContent = "Finding captions or preparing the current video for Gemini Flash-Lite…";
  try {
    const result = await sendRuntime("analyze_current_video", {
      apiKey: activeApiKey,
      args,
    });
    if (result?.transcriptDownload?.text) {
      createTranscriptDownloadMessage(result.transcriptDownload, result);
    }
    if (["summary", "both"].includes(String(args.action || "summary"))) {
      createVideoSummaryPresentationMessage(result?.summaryMarkdown);
    }
    const sanitized = prepareVideoAnalysisAgentResult(result, args);
    elements.statusLine.textContent = result?.sourceMethod?.includes("caption")
      ? `Used the video's existing captions · ${result.sourceTitle || "current video"}.`
      : `Analyzed ${result.sourceTitle || "the current video"} with ${result.model || VIDEO_ANALYSIS_MODEL}.`;
    avatarController.transitionState("success", {
      forMs: AVATAR_SUCCESS_STATE_DURATION_MS,
      resumeState: "thinking",
    });
    return sanitized;
  } catch (error) {
    avatarController.transitionState("error", { forMs: AVATAR_ERROR_STATE_DURATION_MS });
    throw error;
  }
}

const runBrowserTool = createBrowserToolRunner({
  isUiAction: (tool) => BROWSER_UI_ACTION_TOOLS.has(tool),
  avatarController,
  successStateDurationMs: AVATAR_SUCCESS_STATE_DURATION_MS,
  errorStateDurationMs: AVATAR_ERROR_STATE_DURATION_MS,
  inspectScreenshot: captureAndSendVisualInspectionFrame,
  sendBrowserTool: (tool, args) => sendRuntime("browser_tool", { tool, args }),
  showCapturedScreenshot: createCapturedTabMessage,
  collectVerification: ({ tool, args, result }) => collectAutomaticBrowserVerification({
    tool,
    args,
    result,
    readPageState: (query) => sendRuntime("browser_tool", {
      tool: "browser_get_page_state",
      args: query ? { query } : {},
    }),
  }),
  setRunning: (running) => {
    browserToolRunning = running;
  },
  setStatus: (message) => {
    elements.statusLine.textContent = message;
  },
});

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

function availableAgentActions(sourceSocket = websocket) {
  const declared = Array.isArray(sourceSocket?.lumiActionDeclarations)
    ? sourceSocket.lumiActionDeclarations
    : [];
  if (declared.length) return declared;
  const activeMcpNames = new Set(activeMcpTools.keys());
  return [
    ...BUILTIN_TOOLS,
    ...(sessionConnectionOptions?.mcpFunctionDeclarations || [])
      .filter((declaration) => activeMcpNames.has(declaration.name)),
  ];
}

function ensureActiveAgentTask() {
  const taskId = taskOrchestrator.ensureTask(
    activeTurnUserRequest || "Voice browser task",
    {
      turnSequence: turnExecutionSequence,
      maxSteps: DEFAULT_AGENT_MAX_STEPS,
    },
  );
  removeStandaloneThinkingForTurn(turnExecutionSequence);
  return taskId;
}

function agentStepEnvelope(actionName, actionResult, orchestrationResult) {
  const checkpoint = orchestrationResult?.checkpoint || null;
  const reasonGuidance = {
    loop_detected: "The repeated action was not executed. Use a distinct safe tactic or call done with a concrete blocker.",
    max_steps: "The controller exhausted the step budget and recorded a failed completion.",
    observation_required: "Observe current browser state first, then retry the action using only fresh indices or tab data.",
    verification_required: "Run one browser observation or targeted wait now. Do not repeat the action or call done until fresh evidence is available.",
    premature_done: "Complete at least one concrete task step and collect evidence before reporting success.",
  };
  return {
    task: checkpoint,
    action: {
      name: actionName,
      status: orchestrationResult?.step?.action?.status
        || (orchestrationResult?.accepted === false ? "blocked" : "completed"),
      retryAttempt: orchestrationResult?.step?.retryAttempt
        ?? orchestrationResult?.retryAttempt
        ?? 0,
    },
    observation: actionResult,
    controllerGuidance: checkpoint?.warning
      || reasonGuidance[orchestrationResult?.reason]
      || "Evaluate this observation, update durable memory, and continue with exactly one next action or done.",
  };
}

function requestStructuredTaskCompletion(sourceSocket) {
  const running = taskOrchestrator.activeTask;
  if (
    !userTurnAuthorized
    || !running
    || running.turnSequence !== turnExecutionSequence
    || sourceSocket !== websocket
  ) return false;
  const recovery = taskOrchestrator.handleIncompleteTurn(running.taskId);
  if (!recovery.recover) return false;
  const checkpoint = recovery.checkpoint;
  setAgentTurnActive(true);
  return sendJson({
    clientContent: {
      turns: [{
        role: "user",
        parts: [{
          text: `[Lumi controller checkpoint — not a user request] The tool task is still active because no structured done event was emitted. Re-evaluate the complete original request now. Call ${AGENT_STEP_TOOL_NAME} exactly once. If all requested work is verified, use actionName="done" with success, result, and evidence. Otherwise choose one distinct unfinished action. Remaining action steps: ${checkpoint?.remainingSteps ?? 0}. Do not answer in plain text before done.`,
        }],
      }],
      turnComplete: true,
    },
  }, sourceSocket);
}

async function handleServerMessage(event, sourceSocket) {
  const raw = typeof event.data === "string" ? event.data : await event.data.text();
  const response = JSON.parse(raw);
  const completingHandoff = sourceSocket === pendingSessionHandoffSocket;
  if (sourceSocket !== websocket && !completingHandoff) return;
  const resumptionUpdate = response.sessionResumptionUpdate;
  if (resumptionUpdate?.resumable && resumptionUpdate.newHandle) {
    sourceSocket.lumiLatestResumptionHandle = resumptionUpdate.newHandle;
    if (!completingHandoff) sessionResumptionHandle = resumptionUpdate.newHandle;
  }
  if (response.goAway) serverRotationPending = true;
  if (completingHandoff && !response.setupComplete) return;

  for (const id of response.toolCallCancellation?.ids || []) {
    if (pendingToolActionNames.get(id) === LIVE_TRANSLATE_TOOL_NAME && pendingLiveTranslationStart) {
      pendingLiveTranslationStart = false;
      void sendRuntime("stop_live_translation").catch(() => {});
    }
    rememberCancelledToolCall(id);
    pendingToolCallIds.delete(id);
    pendingToolCallNames.delete(id);
    pendingToolActionNames.delete(id);
    finishMcpActivity(id, "cancelled", "Gemini cancelled this tool call because the conversation turn was interrupted.");
  }
  if (response.setupComplete) {
    const predecessorSocket = completingHandoff
      ? sourceSocket.lumiPredecessorSocket
      : null;
    if (completingHandoff) {
      pendingSessionHandoffSocket = null;
      websocket = sourceSocket;
      sourceSocket.lumiPredecessorSocket = null;
      sessionResumptionHandle = sourceSocket.lumiLatestResumptionHandle || "";
    }
    if (sourceSocket.lumiDiscardOldContext) {
      sessionResumptionHandle = sourceSocket.lumiLatestResumptionHandle || "";
    }
    sourceSocket.lumiSetupComplete = true;
    activeApiKey = sourceSocket.lumiApiKey || activeApiKey;
    const completedInBackground = sourceSocket.lumiBackgroundReconnect === true;
    automaticSessionReconnectAttempt = 0;
    clearAutomaticSessionReconnectTimer();
    sessionReadyAt = performance.now();
    hideConnectionNotice();
    clearSetupTimeout(sourceSocket);
    clearTurnCancellationTimers();
    clearTurnCancellationBoundaryTimeout();
    turnCancellationPending = false;
    suppressServerOutputUntilNextUserTurn = false;
    cancelledTurnBoundarySeen = false;
    freshUserInputStarted = false;
    const resumedExistingSession = Boolean(sourceSocket.lumiResumptionHandle);
    if (!resumedExistingSession && conversationHistory.length) {
      sendJson(buildInitialHistoryClientContent(conversationHistory), sourceSocket);
    }
    const readyMessage = microphoneWarning
      || (isMuted
        ? "Chat is ready. Microphone is off; turn it on whenever you want to speak."
        : "Lumi is listening. PageAgent automatically follows your active web tab.");
    backgroundSessionReconnectPending = false;
    if (predecessorSocket?.readyState < WebSocket.CLOSING) {
      try {
        predecessorSocket.close(1000, "Gemini Live handoff complete");
      } catch {
        // The predecessor may have closed while the successor was finishing setup.
      }
    }
    if (completedInBackground) {
      elements.muteButton.disabled = isLiveTranslationChatLocked();
      syncMessageComposer();
      syncQueuedMessagePanel();
    } else {
      setSessionStatus("ready", readyMessage);
    }
    elements.microphoneHelpButton.hidden = !microphonePermissionHelp;
    if (queuedUserMessages.length) {
      flushQueuedUserMessage();
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
  const hasActionableTurnPayload = Boolean(
    serverContent?.modelTurn?.parts?.length
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
  if (!userTurnAuthorized && hasTurnPayload) {
    for (const functionCall of functionCalls) {
      rememberCancelledToolCall(functionCall.id);
    }
    if (hasActionableTurnPayload) panelAudio.stopPlayback();
    if (serverContent?.turnComplete) setAgentTurnActive(false);
    // Gemini sends input/output transcriptions independently and does not
    // guarantee that they arrive before turnComplete. They are benign late
    // metadata here; spontaneous model content and tool calls remain blocked.
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
  }
  for (const part of serverContent?.modelTurn?.parts || []) {
    const transcriptRole = getLiveModelPartTranscriptRole(part);
    if (transcriptRole) {
      updateTranscript(transcriptRole, part.text);
    }
    if (transcriptRole === "thinking") {
      avatarController.transitionState("thinking");
    }
    if (part.inlineData?.data && responseAudioGate.shouldPlay()) {
      panelAudio.playPcmChunk(part.inlineData.data);
    }
  }
  if (serverContent?.outputTranscription?.text) {
    updateTranscript("lumi", serverContent.outputTranscription.text);
  }
  if (serverContent?.generationComplete || functionCalls.length) {
    finalizeTranscript("thinking");
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
    finishTurnWork({ cancelled: true });
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
    for (const [functionCallIndex, functionCall] of functionCalls.entries()) {
      if (executionSequence !== turnExecutionSequence || turnCancellationPending) break;
      const callId = functionCall.id;
      if (!callId || cancelledToolCallIds.has(callId)) continue;
      let mcpTool = null;
      let activityTool = null;
      let renderStandaloneActivity = false;
      let isBrowserTool = false;
      let protocolStep = null;
      let orchestration = null;
      const stepStartedAt = performance.now();
      const taskId = ensureActiveAgentTask();
      try {
        if (functionCallIndex > 0) {
          throw new Error("Parallel agent actions are not allowed. Send exactly one Lumi step at a time.");
        }
        protocolStep = parseAgentStepCall(
          functionCall,
          availableAgentActions(sourceSocket),
        );
        const actionName = protocolStep.action.name;
        const actionArgs = protocolStep.action.input;
        if (
          isLiveTranslationChatLocked()
          && actionName !== LIVE_TRANSLATE_TOOL_NAME
          && actionName !== AGENT_DONE_ACTION_NAME
        ) {
          throw new Error(
            "Live Translate is active. Stop translation before running another browser or MCP action.",
          );
        }
        pendingToolActionNames.set(callId, actionName);
        orchestration = taskOrchestrator.beginStep({
          taskId,
          reflection: protocolStep.reflection,
          action: protocolStep.action,
        });
        if (!orchestration.accepted) {
          const constraintMessages = {
            loop_detected: "Repeated action blocked against an unchanged observation fingerprint.",
            max_steps: "The task step budget is exhausted.",
            observation_required: "A fresh browser observation is required before this action.",
            verification_required: "The previous browser action needs a fresh verification observation.",
            premature_done: "Structured completion was requested before any task step completed.",
          };
          const blockedResult = {
            error: constraintMessages[orchestration.reason]
              || "The controller blocked this action.",
            recoverable: orchestration.reason !== "max_steps",
          };
          functionResponses.push({
            id: callId,
            name: AGENT_STEP_TOOL_NAME,
            response: {
              result: agentStepEnvelope(
                actionName,
                blockedResult,
                orchestration,
              ),
            },
          });
          continue;
        }
        if (actionName === AGENT_DONE_ACTION_NAME) {
          const finished = taskOrchestrator.finishDoneStep(
            orchestration.stepId,
            actionArgs,
          );
          functionResponses.push({
            id: callId,
            name: AGENT_STEP_TOOL_NAME,
            response: {
              result: agentStepEnvelope(
                actionName,
                {
                  success: actionArgs.success,
                  result: actionArgs.result,
                  evidence: actionArgs.evidence || "",
                  completedGoals: actionArgs.completedGoals || [],
                  completionRecorded: true,
                },
                finished,
              ),
            },
          });
          continue;
        }

        isBrowserTool = BROWSER_TOOLS.some((tool) => tool.name === actionName);
        const isLiveTranslationTool = actionName === LIVE_TRANSLATE_TOOL_NAME;
        const isVideoAnalysisTool = actionName === VIDEO_ANALYZE_TOOL_NAME;
        mcpTool = activeMcpTools.get(actionName) || null;
        if (!isBrowserTool && !isLiveTranslationTool && !isVideoAnalysisTool && !mcpTool) {
          throw new Error(`Unsupported tool: ${actionName}`);
        }
        if (mcpTool?.disabled) throw new Error("This MCP tool is disabled for the rest of this session.");
        activityTool = isLiveTranslationTool
          ? {
              activityLabel: "BUILT-IN TOOL",
              toolName: LIVE_TRANSLATE_TOOL_NAME,
              serverName: "Gemini Live Translate",
            }
          : isVideoAnalysisTool
            ? {
                activityLabel: "BUILT-IN TOOL",
                toolName: VIDEO_ANALYZE_TOOL_NAME,
                serverName: "Gemini 3.5 Flash-Lite",
              }
          : mcpTool;
        renderStandaloneActivity = Boolean(activityTool)
          && shouldRenderStandaloneToolActivity(orchestration);
        if (renderStandaloneActivity) {
          createMcpActivityCard(callId, activityTool, actionArgs);
        }
        let result = isLiveTranslationTool
          ? await runLiveTranslationTool(actionArgs)
          : isVideoAnalysisTool
            ? await runVideoAnalysisTool(actionArgs)
          : isBrowserTool
            ? await runBrowserTool(actionName, actionArgs)
            : normalizeMcpToolResult(await runMcpTool(mcpTool, actionArgs, callId));
        if (isBrowserTool) {
          result = addBrowserWorkflowContext(result, {
            toolName: actionName,
          });
        }
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
          if (orchestration?.accepted) {
            taskOrchestrator.finishStep(orchestration.stepId, {
              result: { error: "The action completed after its turn was cancelled." },
              error: "The action completed after its turn was cancelled.",
              durationMs: performance.now() - stepStartedAt,
            });
          }
          if (renderStandaloneActivity) {
            finishMcpActivity(callId, "cancelled", "The session ended before Lumi could use this tool result.");
          }
          continue;
        }
        if (renderStandaloneActivity) finishMcpActivity(callId, "completed", result);
        const finished = taskOrchestrator.finishStep(orchestration.stepId, {
          result,
          durationMs: performance.now() - stepStartedAt,
        });
        functionResponses.push({
          id: callId,
          name: AGENT_STEP_TOOL_NAME,
          response: {
            result: agentStepEnvelope(actionName, result, finished),
          },
        });
      } catch (error) {
        if (
          cancelledToolCallIds.has(callId)
          || executionSequence !== turnExecutionSequence
          || turnCancellationPending
          || sourceSocket !== websocket
        ) {
          if (orchestration?.accepted) {
            taskOrchestrator.finishStep(orchestration.stepId, {
              result: { error: "The tool call was cancelled before it completed." },
              error: "The tool call was cancelled before it completed.",
              durationMs: performance.now() - stepStartedAt,
            });
          }
          if (renderStandaloneActivity) {
            finishMcpActivity(callId, "cancelled", "The tool call was cancelled before it completed.");
          }
          continue;
        }
        if (renderStandaloneActivity) {
          finishMcpActivity(callId, "failed", error instanceof Error ? error.message : "Tool call failed.");
        }
        if (mcpTool) promptToDisableFailedMcpTool(mcpTool, error);
        const detail = (error instanceof Error ? error.message : "Tool call failed.").slice(0, 1200);
        const actionName = protocolStep?.action?.name || AGENT_STEP_TOOL_NAME;
        const failure = isBrowserTool
          ? addBrowserWorkflowContext(buildBrowserToolFailureResponse(error), {
              toolName: actionName,
            })
          : { error: detail };
        const failed = orchestration?.accepted
          ? taskOrchestrator.finishStep(orchestration.stepId, {
              result: failure,
              error: detail,
              durationMs: performance.now() - stepStartedAt,
            })
          : {
              checkpoint: taskOrchestrator.checkpoint(taskId),
            };
        if (!protocolStep) {
          taskOrchestrator.recordProtocolError(detail, { taskId });
        }
        functionResponses.push({
          id: callId,
          name: functionCall.name || AGENT_STEP_TOOL_NAME,
          response: {
            result: agentStepEnvelope(actionName, failure, failed),
          },
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
      for (const response of functionResponses) {
        pendingToolActionNames.delete(response.id);
      }
    }
  }
  if (serverContent?.turnComplete && !functionCalls.length) {
    const completionRecoveryStarted = requestStructuredTaskCompletion(sourceSocket);
    if (!completionRecoveryStarted) {
      const wasUserCancellation = turnCancellationPending;
      turnCancellationPending = false;
      finalizeTranscript("user");
      finalizeTranscript("lumi");
      finalizeTranscript("thinking");
      setAgentTurnActive(false);
      finishTurnWork({ cancelled: wasUserCancellation });
      userTurnAuthorized = false;
      activeTurnUserRequest = "";
      if (wasUserCancellation) {
        elements.statusLine.textContent = "Current action cancelled. Lumi is ready for your next request.";
      }
      flushQueuedUserMessage();
      responseAudioGate.reset();
    }
  }
  if (serverRotationPending && !sessionHasInFlightWork()) {
    const scheduled = scheduleAutomaticSessionReconnect(
      "Gemini requested a seamless connection rotation.",
      { delayMs: 0 },
    );
    if (scheduled) {
      elements.statusLine.textContent = "Keeping Lumi connected while Gemini rotates the transport…";
    }
    return;
  }
}

function openGeminiSocket(
  options,
  {
    background = false,
    discardOldContext = false,
    predecessorSocket = null,
  } = {},
) {
  const {
    apiKey,
    voiceName,
    thinkingLevel: sessionThinkingLevel,
    mcpInfo,
    mcpFunctionDeclarations,
    activeTabContext,
    fastMode: sessionFastMode,
  } = options;
  sessionConnectionOptions = options;
  const handoffPredecessor = predecessorSocket?.readyState === WebSocket.OPEN
    && predecessorSocket.lumiSetupComplete
    ? predecessorSocket
    : null;
  const reconnectInBackground = background === true && sessionStatus === "ready";
  backgroundSessionReconnectPending = reconnectInBackground;
  if (!reconnectInBackground) {
    setSessionStatus("connecting", "Opening Gemini Live...");
  }
  if (!handoffPredecessor) sessionReadyAt = 0;
  const actionDeclarations = [...BUILTIN_TOOLS, ...mcpFunctionDeclarations];
  const functionDeclarations = [buildAgentStepDeclaration(actionDeclarations)];
  const sessionSocket = new WebSocket(`${WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`);
  sessionSocket.lumiApiKey = apiKey;
  if (handoffPredecessor) pendingSessionHandoffSocket = sessionSocket;
  else websocket = sessionSocket;
  const resumptionHandle = discardOldContext ? "" : sessionResumptionHandle;
  sessionSocket.lumiResumptionHandle = resumptionHandle;
  sessionSocket.lumiLatestResumptionHandle = resumptionHandle;
  sessionSocket.lumiDiscardOldContext = discardOldContext;
  sessionSocket.lumiBackgroundReconnect = reconnectInBackground;
  sessionSocket.lumiPredecessorSocket = handoffPredecessor;
  sessionSocket.lumiSetupComplete = false;
  sessionSocket.lumiActionDeclarations = actionDeclarations;
  const setupTimeoutId = setTimeout(() => {
    setupTimeoutIds.delete(setupTimeoutId);
    sessionSocket.lumiSetupTimeoutId = null;
    if (!isTrackedGeminiSocket(sessionSocket) || sessionSocket.lumiSetupComplete) return;
    sessionSocket.close(4000, "Gemini setup timed out");
  }, GEMINI_SETUP_TIMEOUT_MS);
  sessionSocket.lumiSetupTimeoutId = setupTimeoutId;
  setupTimeoutIds.add(setupTimeoutId);
  sessionSocket.onopen = () => {
    if (!isTrackedGeminiSocket(sessionSocket)) return;
    sendJson({
      setup: {
        model: `models/${MODEL}`,
        ...buildSessionHandshakeConfig(resumptionHandle),
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
        systemInstruction: {
          parts: [{
            text: buildSessionInstruction(
              mcpInfo,
              activeTabContext,
              actionDeclarations,
              { fastMode: sessionFastMode },
            ),
          }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }, sessionSocket);
  };
  sessionSocket.onmessage = (event) => {
    void handleServerMessage(event, sessionSocket).catch((error) => {
      if (!isTrackedGeminiSocket(sessionSocket)) return;
      console.warn("Gemini Live returned an unreadable response.", error);
      sessionSocket.close(4001, "Invalid Gemini response");
    });
  };
  sessionSocket.onerror = () => {
    if (!isTrackedGeminiSocket(sessionSocket)) return;
    if (sessionSocket.lumiBackgroundReconnect || sessionStatus === "ready") return;
    elements.statusLine.textContent = "Gemini Live connection failed; waiting for the server error details...";
  };
  sessionSocket.onclose = (event) => {
    if (!isTrackedGeminiSocket(sessionSocket)) return;
    const closingActiveSocket = websocket === sessionSocket;
    const closingHandoffSocket = pendingSessionHandoffSocket === sessionSocket;
    const handoffPredecessorSocket = sessionSocket.lumiPredecessorSocket;
    const expected = intentionalClose;
    const reason = event.reason?.replace(/\s+/g, " ").trim() || "";
    const disconnectedSoonAfterConnect = closingActiveSocket
      && sessionReadyAt > 0
      && performance.now() - sessionReadyAt <= EARLY_CONNECTION_DROP_MS;
    if (closingActiveSocket) sessionReadyAt = 0;
    clearSetupTimeout(sessionSocket);

    const rejected = !expected && !sessionSocket.lumiSetupComplete
      ? findRejectedMcpDeclaration(reason, functionDeclarations, activeMcpTools)
      : null;
    if (rejected) {
      if (closingActiveSocket) websocket = null;
      if (closingHandoffSocket) pendingSessionHandoffSocket = null;
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
      if (!sessionSocket.lumiBackgroundReconnect) {
        setSessionStatus(
          "connecting",
          `Temporarily disabled incompatible MCP tool ${rejected.tool.toolName}. Retrying Gemini Live...`,
        );
      }
      openGeminiSocket({
        apiKey,
        voiceName,
        thinkingLevel: sessionThinkingLevel,
        mcpInfo,
        mcpFunctionDeclarations,
        activeTabContext,
      }, {
        background: sessionSocket.lumiBackgroundReconnect,
        discardOldContext: sessionSocket.lumiDiscardOldContext,
        predecessorSocket: handoffPredecessorSocket,
      });
      return;
    }

    if (closingActiveSocket) websocket = null;
    if (closingHandoffSocket) pendingSessionHandoffSocket = null;
    const invalidResumptionRequest = Boolean(
      resumptionHandle
      && event.code === 1007
      && /invalid argument/i.test(reason)
      && (!sessionSocket.lumiSetupComplete || disconnectedSoonAfterConnect),
    );
    if (
      (!closingHandoffSocket && !sessionSocket.lumiSetupComplete && resumptionHandle)
      || invalidResumptionRequest
    ) {
      if (sessionResumptionHandle === resumptionHandle) {
        sessionResumptionHandle = "";
      }
    }

    if (
      closingHandoffSocket
      && handoffPredecessorSocket?.readyState === WebSocket.OPEN
      && shouldMaintainGeminiSession
    ) {
      websocket = handoffPredecessorSocket;
      backgroundSessionReconnectPending = false;
      syncMessageComposer();
      syncQueuedMessagePanel();
      if (queuedUserMessages.length && !sessionHasInFlightWork()) {
        flushQueuedUserMessage();
      }
      return;
    }

    if (
      closingActiveSocket
      && pendingSessionHandoffSocket
      && shouldMaintainGeminiSession
    ) {
      backgroundSessionReconnectPending = true;
      return;
    }

    if (
      websocket === handoffPredecessorSocket
      && handoffPredecessorSocket?.readyState >= WebSocket.CLOSING
    ) {
      websocket = null;
    }
    if (!expected && !isGeminiKeyIssue(reason) && shouldMaintainGeminiSession) {
      const reconnecting = scheduleAutomaticSessionReconnect(
        reason || "Gemini Live transport closed.",
        { allowInFlight: true },
      ) || automaticSessionReconnectTimerId !== null;
      if (reconnecting) {
        elements.statusLine.textContent = "Gemini transport changed. Reconnecting automatically…";
        return;
      }
    }

    cleanupMedia({ cancelActiveTask: sessionHasInFlightWork() });
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
  if (sessionStatus === "ready") return;
  if (sessionStatus === "connecting" || sessionStartPending) return;
  sessionStartPending = true;

  try {
    const stored = await chrome.storage.local.get([
      API_KEY_STORAGE_KEY,
      VOICE_STORAGE_KEY,
      THINKING_LEVEL_STORAGE_KEY,
      MICROPHONE_ENABLED_STORAGE_KEY,
      FAST_MODE_STORAGE_KEY,
    ]);
    const apiKey = String(stored[API_KEY_STORAGE_KEY] || "").trim();
    const voiceName = String(stored[VOICE_STORAGE_KEY] || DEFAULT_VOICE_NAME);
    const sessionThinkingLevel = normalizeThinkingLevel(stored[THINKING_LEVEL_STORAGE_KEY]);
    const sessionFastMode = typeof stored[FAST_MODE_STORAGE_KEY] === "boolean"
      ? stored[FAST_MODE_STORAGE_KEY]
      : DEFAULT_FAST_MODE_ENABLED;
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

    resetSessionRecoveryState();
    shouldMaintainGeminiSession = true;
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
        fastMode: sessionFastMode,
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
  if (isMuted) syncMicrophoneLevel(0);
}

function syncMicrophoneLevel(level) {
  const visibleLevel = isMuted ? 0 : Math.min(1, Math.max(0, Number(level) || 0));
  elements.muteButton.style.setProperty("--mic-level", visibleLevel.toFixed(3));
  elements.muteButton.style.setProperty(
    "--mic-glow-opacity",
    Math.min(.72, visibleLevel * .9).toFixed(3),
  );
  elements.muteButton.style.setProperty(
    "--mic-glow-scale",
    (.82 + visibleLevel * .42).toFixed(3),
  );
  elements.muteButton.style.setProperty(
    "--mic-wave-opacity",
    Math.min(.96, .28 + visibleLevel * .68).toFixed(3),
  );
  elements.muteButton.style.setProperty(
    "--mic-wave-left-offset",
    `${-(1 + visibleLevel * 2).toFixed(2)}px`,
  );
  elements.muteButton.style.setProperty(
    "--mic-wave-right-offset",
    `${(1 + visibleLevel * 2).toFixed(2)}px`,
  );
  elements.muteButton.classList.toggle("is-hearing", visibleLevel >= .06);
}

function cleanupMedia({ cancelActiveTask = true } = {}) {
  resetSessionRecoveryState();
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
  pendingToolActionNames.clear();
  if (cancelActiveTask) {
    taskOrchestrator.cancelTask(
      "The Gemini Live session ended before the task completed.",
    );
  }
  activeApiKey = "";
  pendingLiveTranslationStart = false;
  liveTranslationStopPending = false;
  resumeMicrophoneAfterTranslation = false;
  liveTranslationStopError = "";
  liveTranslationTargetLanguageCode = "";
  setLiveTranslationBadge("off");
  panelAudio.closeSession();
  responseAudioGate.reset();
  finishTurnWork({ cancelled: true });
  websocket = null;
  isMuted = true;
  microphoneWarning = "";
  microphonePermissionHelp = false;
  elements.microphoneHelpButton.hidden = true;
  agentTurnActive = false;
  userTurnAuthorized = false;
  activeTurnUserRequest = "";
  turnCancellationPending = false;
  suppressServerOutputUntilNextUserTurn = false;
  cancelledTurnBoundarySeen = false;
  freshUserInputStarted = false;
  syncMuteButton();
  finalizeTranscript("user");
  finalizeTranscript("lumi");
  finalizeTranscript("thinking");
}

async function enableMicrophone({ persistPreference = true, announce = true } = {}) {
  if (sessionStatus !== "ready" || !isMuted || isLiveTranslationChatLocked()) return !isMuted;
  microphoneEnabled = true;
  if (persistPreference) {
    await chrome.storage.local.set({ [MICROPHONE_ENABLED_STORAGE_KEY]: true });
  }
  elements.muteButton.disabled = true;
  if (announce) elements.statusLine.textContent = "Turning on microphone…";

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
    if (announce) {
      elements.statusLine.textContent = "Microphone is on. You can speak or continue typing.";
    }
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
    elements.muteButton.disabled = !canUseMicrophoneControl();
    syncMuteButton();
    avatarController.syncState();
  }
}

async function toggleMute() {
  if (isLiveTranslationChatLocked()) return;
  if (sessionStatus === "idle") {
    if (!isMuted) return;
    microphoneEnabled = true;
    await chrome.storage.local.set({ [MICROPHONE_ENABLED_STORAGE_KEY]: true });
    elements.muteButton.disabled = true;
    elements.statusLine.textContent = "Connecting chat and turning on microphone…";
    await autoStartSessionIfReady();
    return;
  }
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

async function sendText(
  text,
  {
    attachment = null,
    clearComposer = true,
    displayTextOverride = "",
    render = true,
    remember = true,
  } = {},
) {
  const clean = String(text || "").trim();
  const selectedAttachment = attachment?.frame?.data ? attachment : null;
  const contextEpoch = conversationContextEpoch;
  if (
    (!clean && !selectedAttachment)
    || textSendPending
    || !isGeminiTransportReady()
    || agentTurnActive
    || turnCancellationPending
    || isLiveTranslationChatLocked()
  ) return false;
  textSendPending = true;
  syncMessageComposer();
  let promptContext;
  try {
    promptContext = await sendRuntime("prepare_browser_prompt");
  } catch (error) {
    textSendPending = false;
    elements.statusLine.textContent = error instanceof Error
      ? error.message
      : "Lumi could not prepare the browser target for this prompt.";
    syncMessageComposer();
    return false;
  }
  const frame = selectedAttachment?.frame || null;
  textSendPending = false;
  if (
    contextEpoch !== conversationContextEpoch
    || !isGeminiTransportReady()
    || agentTurnActive
    || turnCancellationPending
    || isLiveTranslationChatLocked()
  ) {
    syncMessageComposer();
    return false;
  }
  const displayText = String(displayTextOverride || "").trim()
    || clean
    || `Image · ${selectedAttachment.name}`;
  const userRequestText = clean || "Please inspect the attached image and respond with the most helpful relevant analysis.";
  const targetTabId = Number(promptContext?.target?.tabId);
  const boundaryPrompt = buildPendingConversationBoundaryPrompt();
  const scopedUserRequestText = boundaryPrompt
    ? `${boundaryPrompt}\n\n[New user request]\n${userRequestText}`
    : userRequestText;
  const modelText = promptContext?.mode === "fast"
    ? `[Lumi runtime context — not part of the user's request] Fast mode is active. This turn is locked to workspace tabId ${Number.isInteger(targetTabId) ? targetTabId : "unknown"} inside Agent Space and must never read or operate on tabs outside that group. You may switch only among tabs returned from the workspace-only browser_list_tabs result, or open a necessary new tab with browser_open_tab so it joins the workspace. Use browser_set_selection or browser_batch_actions for large independent form edits.\n\n[User request]\n${scopedUserRequestText}`
    : scopedUserRequestText;
  userTurnAuthorized = true;
  const videoSent = frame ? sendJson({ realtimeInput: { video: frame } }) : true;
  const textSent = videoSent && sendJson({ realtimeInput: { text: modelText } });
  if (!videoSent || !textSent) {
    userTurnAuthorized = false;
    elements.statusLine.textContent = clearComposer
      ? "Message was not sent and remains in the composer. The connection stays open for retry."
      : "Queued message was not sent; Lumi will retry it on the current connection.";
    syncMessageComposer();
    return false;
  }
  if (boundaryPrompt) pendingConversationBoundary = false;

  activeTurnUserRequest = userRequestText;
  turnExecutionSequence += 1;
  directVideoPresentationTurnSequence = null;
  beginTurnWork(turnExecutionSequence);
  if (suppressServerOutputUntilNextUserTurn) markFreshUserInputStarted();
  responseAudioGate.reset();
  finalizeTranscript("user");
  finalizeTranscript("lumi");
  finalizeTranscript("thinking");
  if (render) createMessage("user", displayText, { attachment: selectedAttachment });
  if (remember) {
    rememberConversationTurn(
      "user",
      selectedAttachment ? `${userRequestText} [Attached image: ${selectedAttachment.name}]` : userRequestText,
    );
  }
  avatarController.transitionState("thinking");
  turnCancellationPending = false;
  setAgentTurnActive(true);
  if (clearComposer) {
    elements.messageInput.value = "";
    clearPendingImageAttachment();
    resizeMessageInput();
  }
  syncMessageComposer();
  return true;
}

async function flushQueuedUserMessage() {
  if (
    !queuedUserMessages.length
    || textSendPending
    || !isGeminiTransportReady()
    || agentTurnActive
    || turnCancellationPending
    || isLiveTranslationChatLocked()
  ) {
    return false;
  }
  const nextMessage = queuedUserMessages.shift();
  syncQueuedMessagePanel();
  if (!await sendText(nextMessage.text, {
    attachment: nextMessage.attachment,
    clearComposer: false,
  })) {
    queuedUserMessages.unshift(nextMessage);
    syncQueuedMessagePanel();
    return false;
  }
  elements.statusLine.textContent = queuedUserMessages.length
    ? `${queuedUserMessages.length} more message${queuedUserMessages.length === 1 ? "" : "s"} queued.`
    : "Message sent. Lumi is working on it now.";
  return true;
}

function queueUserMessage(text, attachment = null) {
  const clean = String(text || "").trim();
  const selectedAttachment = attachment?.frame?.data ? attachment : null;
  if (isLiveTranslationChatLocked()) {
    elements.statusLine.textContent = "Stop Live Translate before sending another message.";
    return;
  }
  if (!clean && !selectedAttachment) return;
  queuedUserMessages.push({ text: clean, attachment: selectedAttachment });
  syncQueuedMessagePanel();
  elements.messageInput.value = "";
  clearPendingImageAttachment();
  resizeMessageInput();
  syncMessageComposer();

  if (sessionStatus === "ready") {
    if (!isGeminiTransportReady()) {
      elements.statusLine.textContent = "Message queued and will send as soon as Lumi reconnects.";
      return;
    }
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
  if (!isGeminiTransportReady()) {
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
  userTurnAuthorized = false;
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
    sendRuntime("cancel_video_analysis"),
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
  document.body.classList.toggle("petals-off", !enabled || fastModeController?.enabled);
  if (enabled && !fastModeController?.enabled) petalEmitter.start();
  else petalEmitter.stop();
  elements.petalsButton.setAttribute("aria-pressed", String(enabled));
  elements.petalsButton.setAttribute(
    "aria-label",
    enabled ? "Turn off falling petals" : "Turn on falling petals",
  );
  elements.petalsButton.title = enabled ? "Turn off falling petals" : "Turn on falling petals";
}

fastModeController = createFastModeController({
  button: elements.fastModeButton,
  documentElement: document.documentElement,
  body: document.body,
  vtuberCard: elements.vtuberCard,
  vtuberToggle: elements.vtuberToggle,
  transcript: elements.transcript,
  panelAudio,
  avatarController,
  petalEmitter,
  getPetalsEnabled: () => petalsEnabled,
  flushTranscriptReveals: () => {
    for (const message of [...activeTranscriptReveals]) {
      cancelAnimationFrame(message.revealFrameId);
      message.revealFrameId = null;
      setVisibleTranscriptText(message, message.text);
      activeTranscriptReveals.delete(message);
    }
  },
  getSessionOptions: () => sessionConnectionOptions,
  setSessionOptions: (options) => {
    sessionConnectionOptions = options;
  },
  sendRuntime,
  setStatus: (message) => {
    elements.statusLine.textContent = message;
  },
});

const recordedFlowPanel = createRecordedFlowPanel({
  confirmAction: requestChatConfirmation,
  sendRuntime,
  runAgentFlow: (flow, prompt) => sendText(prompt, {
    displayTextOverride: `Run saved flow “${flow.name}”`,
  }),
  setStatus: (message) => {
    elements.statusLine.textContent = message;
  },
});

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
elements.chatHistoryButton.addEventListener("click", openChatHistory);
elements.chatHistoryCloseButton.addEventListener("click", closeChatHistory);
elements.chatHistoryDialog.addEventListener("close", () => {
  elements.chatHistoryButton.setAttribute("aria-expanded", "false");
});
elements.chatHistoryDialog.addEventListener("click", (event) => {
  if (event.target === elements.chatHistoryDialog) closeChatHistory();
});
elements.chatConfirmationCancel.addEventListener("click", () => {
  resolveChatConfirmation(false);
});
elements.chatConfirmationConfirm.addEventListener("click", () => {
  resolveChatConfirmation(true);
});
elements.chatConfirmationDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  resolveChatConfirmation(false);
});
elements.chatSessionList.addEventListener("click", (event) => {
  const deleteButton = event.target.closest?.("[data-delete-chat-session-id]");
  if (deleteButton) {
    void deleteChatSession(deleteButton.dataset.deleteChatSessionId).catch((error) => {
      elements.statusLine.textContent = error instanceof Error
        ? error.message
        : "Could not delete this chat.";
    });
    return;
  }
  const sessionButton = event.target.closest?.("[data-chat-session-id]");
  if (!sessionButton) return;
  void activateChatSession(sessionButton.dataset.chatSessionId).catch((error) => {
    elements.statusLine.textContent = error instanceof Error
      ? error.message
      : "Could not open this chat.";
  });
});
for (const button of [elements.newChatButton, elements.historyNewChatButton]) {
  button.addEventListener("click", () => {
    void startNewChatSession().catch((error) => {
      elements.statusLine.textContent = error instanceof Error
        ? error.message
        : "Could not start a new chat.";
    });
  });
}
elements.clearHistoryButton.addEventListener("click", () => {
  void clearLocalChatHistory().catch((error) => {
    elements.statusLine.textContent = error instanceof Error
      ? error.message
      : "Could not clear the saved chats.";
  });
});
elements.fastModeButton.addEventListener("click", () => void fastModeController.toggle());
elements.avatarModeButton.addEventListener("click", () => void toggleAvatarMode());
elements.petalsButton.addEventListener("click", () => void togglePetals());
elements.vtuberToggle.addEventListener("click", toggleVtuberSize);
elements.muteButton.addEventListener("click", toggleMute);
elements.stopLiveTranslationButton.addEventListener("click", () => {
  void stopLiveTranslationFromUi();
});
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
elements.dismissTaskFailureNoticeButton.addEventListener("click", hideTaskFailureNotice);
elements.transcript.addEventListener("scroll", () => {
  if (!transcriptProgrammaticScroll) {
    transcriptAutoFollow = isScrollAtBottom(elements.transcript);
  }
  scheduleActiveChatSnapshotPersist();
}, { passive: true });
elements.transcript.addEventListener(
  "toggle",
  scheduleActiveChatSnapshotPersist,
  true,
);
elements.transcript.addEventListener("scrollend", () => {
  clearTimeout(transcriptProgrammaticScrollTimerId);
  transcriptProgrammaticScrollTimerId = null;
  transcriptProgrammaticScroll = false;
  transcriptAutoFollow = isScrollAtBottom(elements.transcript);
}, { passive: true });
for (const eventName of ["wheel", "touchstart", "pointerdown"]) {
  elements.transcript.addEventListener(eventName, () => {
    clearTimeout(transcriptProgrammaticScrollTimerId);
    transcriptProgrammaticScrollTimerId = null;
    transcriptProgrammaticScroll = false;
  }, { passive: true });
}
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
elements.imageAttachmentButton.addEventListener("click", () => {
  if (!imageAttachmentPending && !textSendPending) elements.imageAttachmentInput.click();
});
elements.imageAttachmentInput.addEventListener("change", () => {
  void attachImageFiles(elements.imageAttachmentInput.files);
});
elements.messageInput.addEventListener("paste", (event) => {
  const files = imageFilesFromClipboard(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  void attachImageFiles(files);
});
elements.messageForm.addEventListener("dragenter", (event) => {
  if (isLiveTranslationChatLocked()) return;
  if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  event.preventDefault();
  imageDragDepth += 1;
  elements.messageForm.classList.add("is-image-dragging");
});
elements.messageForm.addEventListener("dragover", (event) => {
  if (isLiveTranslationChatLocked()) return;
  if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  elements.messageForm.classList.add("is-image-dragging");
});
elements.messageForm.addEventListener("dragleave", (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  imageDragDepth = Math.max(0, imageDragDepth - 1);
  if (!imageDragDepth) elements.messageForm.classList.remove("is-image-dragging");
});
elements.messageForm.addEventListener("drop", (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  event.preventDefault();
  if (isLiveTranslationChatLocked()) {
    elements.statusLine.textContent = "Stop Live Translate before attaching an image.";
    return;
  }
  imageDragDepth = 0;
  elements.messageForm.classList.remove("is-image-dragging");
  void attachImageFiles(imageFilesFromDrop(event.dataTransfer));
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
  if (isLiveTranslationChatLocked()) {
    elements.statusLine.textContent = "Stop Live Translate before continuing the chat.";
    return;
  }
  const message = elements.messageInput.value.trim();
  const attachment = pendingImageAttachment;
  const hasContent = Boolean(message || attachment);
  if (hasContent && (!isGeminiTransportReady() || agentTurnActive || turnCancellationPending)) {
    queueUserMessage(message, attachment);
  } else if (hasContent) {
    void sendText(message, { attachment });
  } else if (agentTurnActive) {
    cancelCurrentTurn();
  }
});
window.addEventListener("unload", () => {
  intentionalClose = true;
  sidePanelLifecyclePort.dispose();
  petalEmitter.stop();
  websocket?.close();
  cleanupMedia();
  void flushActiveChatSnapshotPersist();
  fastModeController.dispose();
  recordedFlowPanel.dispose();
  panelAudio.dispose();
  avatarController.dispose();
});
window.addEventListener("focus", () => void refreshMicrophonePermission());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshMicrophonePermission();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[FAST_MODE_STORAGE_KEY]) {
    const storedFastMode = changes[FAST_MODE_STORAGE_KEY].newValue;
    fastModeController.apply(
      typeof storedFastMode === "boolean"
        ? storedFastMode
        : DEFAULT_FAST_MODE_ENABLED,
    );
  }
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
    if (sessionConnectionOptions) {
      sessionConnectionOptions = {
        ...sessionConnectionOptions,
        thinkingLevel: nextThinkingLevel,
      };
    }
    if (changed) {
      elements.statusLine.textContent =
        `Thinking ${formatThinkingLevel(nextThinkingLevel)} saved without closing the current connection.`;
    }
  }
  if (changes[API_KEY_STORAGE_KEY]) {
    const nextApiKey = String(changes[API_KEY_STORAGE_KEY].newValue || "").trim();
    if (!nextApiKey) {
      if (sessionStatus === "ready" || sessionStatus === "connecting") {
        elements.statusLine.textContent =
          "API key removed from Settings. The current connection remains active until the side panel closes.";
      } else {
        const message = "Add a Gemini API key in Lumi Settings before connecting.";
        setSessionStatus("error", message);
        showMissingKeyNotice(message);
      }
    } else if (sessionStatus === "ready" || sessionStatus === "connecting") {
      if (sessionConnectionOptions) {
        sessionConnectionOptions = {
          ...sessionConnectionOptions,
          apiKey: nextApiKey,
        };
      }
      elements.statusLine.textContent =
        "API key saved for the next server rotation. The current connection stays active.";
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
    else if (message.state === "closed") petalEmitter.stop();
    return;
  }
});

async function initialize() {
  elements.extensionVersion.textContent = `v${chrome.runtime.getManifest().version}`;
  const [stored] = await Promise.all([
    chrome.storage.local.get([
      API_KEY_STORAGE_KEY,
      PETALS_STORAGE_KEY,
      AVATAR_MODE_STORAGE_KEY,
      THINKING_LEVEL_STORAGE_KEY,
      MICROPHONE_ENABLED_STORAGE_KEY,
      FAST_MODE_STORAGE_KEY,
    ]),
    restoreLocalChatHistory(),
    recordedFlowPanel.initialize(),
  ]);
  const savedKey = String(stored[API_KEY_STORAGE_KEY] || "").trim();
  microphoneEnabled = stored[MICROPHONE_ENABLED_STORAGE_KEY] === true;
  isMuted = true;
  syncMuteButton();
  if (typeof stored[MICROPHONE_ENABLED_STORAGE_KEY] !== "boolean") {
    await chrome.storage.local.set({ [MICROPHONE_ENABLED_STORAGE_KEY]: false });
  }
  fastModeController.apply(
    typeof stored[FAST_MODE_STORAGE_KEY] === "boolean"
      ? stored[FAST_MODE_STORAGE_KEY]
      : DEFAULT_FAST_MODE_ENABLED,
  );
  const workspaceInitializationPromise = sendRuntime("initialize_side_panel").catch(() => null);
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
  panelAudio.startAnimations();
  await workspaceInitializationPromise;
  let initialConnectionPromise = Promise.resolve(false);
  if (!savedKey) {
    const message = "Add a Gemini API key in Lumi Settings before connecting.";
    setSessionStatus("idle", message);
    showMissingKeyNotice(message);
  } else {
    setSessionStatus("idle", "Opening Gemini Live immediately…");
    if (DEFAULT_AUTO_CONNECT_ENABLED) {
      initialConnectionPromise = autoStartSessionIfReady();
    }
  }
  await avatarController.applyMode(storedAvatarMode);
  const translationStatus = await sendRuntime("live_translation_status").catch(() => null);
  if (translationStatus?.prepared) {
    setLiveTranslationBadge(translationStatus.state || "off", translationStatus.targetLanguageCode || "");
    elements.statusLine.textContent = "Video audio is prepared. Gemini Live remains connected.";
  }
  await initialConnectionPromise;
}

void initialize();
