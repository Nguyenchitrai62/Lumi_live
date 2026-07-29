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
  automaticSessionReconnectDelayMs,
  buildInitialHistoryClientContent,
  buildSessionHandshakeConfig,
  buildThinkingConfig,
  buildSessionInstruction,
  configureMcpTools,
  DEFAULT_THINKING_LEVEL,
  FALLBACK_MODEL,
  findRejectedMcpDeclaration,
  MAX_AUTOMATIC_SESSION_RECONNECT_ATTEMPTS,
  MAX_MCP_TOOL_RESPONSE_CHARS,
  MODEL,
  normalizeThinkingLevel,
  SESSION_CONNECTION_ROTATION_MS,
  SESSION_ROTATION_RETRY_MS,
  shouldRefreshLiveContext,
  trimConversationHistory,
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
import { collectAutomaticBrowserVerification } from "./browser-action-verification.js";
import {
  shouldRenderStandaloneToolActivity,
  taskOwnsTurn,
} from "./task-transcript-policy.js";
import { isQcTool } from "../live/qc-tools.js";
import { isHicasSkillTool } from "../live/hicas-tools.js";
import { createQcWorkspaceController } from "./qc-workspace-controller.js";
import { createHicasSkillRuntime } from "./hicas-skill-runtime.js";
import { createConversationHistoryStore } from "./conversation-history.js";
import {
  authorizeWorkModeAction,
  createWorkModeTurn,
  recordCreatedProjectFromResult,
} from "./work-mode-context.js";

const MESSAGE_TYPE = EXTENSION_EVENTS.request;
const API_KEY_STORAGE_KEY = STORAGE_KEYS.apiKey;
const VOICE_STORAGE_KEY = STORAGE_KEYS.voice;
const MICROPHONE_ENABLED_STORAGE_KEY = STORAGE_KEYS.microphoneEnabled;
const MICROPHONE_GRANTED_STORAGE_KEY = STORAGE_KEYS.microphoneGrantedAt;
const PETALS_STORAGE_KEY = STORAGE_KEYS.fallingPetals;
const AVATAR_MODE_STORAGE_KEY = STORAGE_KEYS.avatarMode;
const THINKING_LEVEL_STORAGE_KEY = STORAGE_KEYS.thinkingLevel;
const MCP_TOOL_POLICIES_STORAGE_KEY = STORAGE_KEYS.mcpToolPolicies;
const HISTORY_ACTIVE_CONVERSATION_STORAGE_KEY = STORAGE_KEYS.historyActiveConversation;
const PANEL_LIFECYCLE_MESSAGE = EXTENSION_EVENTS.lifecycle;
const GEMINI_SETUP_TIMEOUT_MS = 15000;
const EARLY_CONNECTION_DROP_MS = 3000;
const CANCELLED_TOOL_CALL_RETENTION_MS = 60000;
const TURN_CANCELLATION_DRAIN_MS = 120;
const TURN_CANCELLATION_WATCHDOG_MS = 80;
const TURN_CANCELLATION_BOUNDARY_MS = 1500;
const TARGET_REFRESH_INTERVAL_MS = 2800;
const VISUAL_CONTEXT_SETTLE_MS = 650;
applyUiConfig();
const sidePanelLifecyclePort = chrome.runtime.connect({ name: "lumi_live_side_panel" });
const elements = {
  extensionVersion: document.querySelector("#extensionVersion"),
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
  historyButton: document.querySelector("#historyButton"),
  historyDrawer: document.querySelector("#historyDrawer"),
  historyCloseButton: document.querySelector("#historyCloseButton"),
  historyNewButton: document.querySelector("#historyNewButton"),
  historyClearButton: document.querySelector("#historyClearButton"),
  historyStatus: document.querySelector("#historyStatus"),
  historyList: document.querySelector("#historyList"),
  runAttention: document.querySelector("#runAttention"),
  runAttentionTitle: document.querySelector("#runAttentionTitle"),
  runAttentionMessage: document.querySelector("#runAttentionMessage"),
  runAttentionReturn: document.querySelector("#runAttentionReturn"),
  runAttentionAcknowledge: document.querySelector("#runAttentionAcknowledge"),
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
  qcWorkspace: document.querySelector("#qcWorkspace"),
  qcRunSummary: document.querySelector("#qcRunSummary"),
  qcServiceUrl: document.querySelector("#qcServiceUrl"),
  qcServiceToken: document.querySelector("#qcServiceToken"),
  qcAllowedDomains: document.querySelector("#qcAllowedDomains"),
  qcDiscoveryMode: document.querySelector("#qcDiscoveryMode"),
  qcWorkbookInput: document.querySelector("#qcWorkbookInput"),
  qcReferenceWorkbookInput: document.querySelector("#qcReferenceWorkbookInput"),
  qcConnectButton: document.querySelector("#qcConnectButton"),
  qcCompileButton: document.querySelector("#qcCompileButton"),
  qcStatus: document.querySelector("#qcStatus"),
  qcRunPlan: document.querySelector("#qcRunPlan"),
  qcComparisonSheet: document.querySelector("#qcComparisonSheet"),
  qcComparisonHeaderRow: document.querySelector("#qcComparisonHeaderRow"),
  qcComparisonKeys: document.querySelector("#qcComparisonKeys"),
  qcComparisonMappings: document.querySelector("#qcComparisonMappings"),
  qcCompileComparisonButton: document.querySelector("#qcCompileComparisonButton"),
  qcCollectComparisonButton: document.querySelector("#qcCollectComparisonButton"),
  qcComparisonStatus: document.querySelector("#qcComparisonStatus"),
  qcScheduleName: document.querySelector("#qcScheduleName"),
  qcScheduleTime: document.querySelector("#qcScheduleTime"),
  qcScheduleWeekdays: [...document.querySelectorAll("[data-qc-weekday]")],
  qcCreateScheduleButton: document.querySelector("#qcCreateScheduleButton"),
  qcRefreshSchedulesButton: document.querySelector("#qcRefreshSchedulesButton"),
  qcScheduleList: document.querySelector("#qcScheduleList"),
  qcRefreshBugDraftsButton: document.querySelector("#qcRefreshBugDraftsButton"),
  qcBugDraftList: document.querySelector("#qcBugDraftList"),
  qcRefineButton: document.querySelector("#qcRefineButton"),
  qcApproveButton: document.querySelector("#qcApproveButton"),
  qcStartRunButton: document.querySelector("#qcStartRunButton"),
  qcPauseRunButton: document.querySelector("#qcPauseRunButton"),
  qcResumeRunButton: document.querySelector("#qcResumeRunButton"),
  qcCancelRunButton: document.querySelector("#qcCancelRunButton"),
  qcApproveStepButton: document.querySelector("#qcApproveStepButton"),
  qcDownloads: document.querySelector("#qcDownloads"),
  qcDownloadExcel: document.querySelector("#qcDownloadExcel"),
  qcDownloadHtml: document.querySelector("#qcDownloadHtml"),
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
const pendingToolActionNames = new Map();
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
let imageAttachmentPending = false;
let pendingImageAttachment = null;
let pendingWorkbookAttachment = null;
let imageDragDepth = 0;
let qcRunCardElement = null;
let qcRunCardId = "";
let qcRunCardNotice = { message: "", tone: "" };
let shouldMaintainGeminiSession = false;
let sessionConnectionOptions = null;
let sessionResumptionHandle = "";
let automaticSessionReconnectAttempt = 0;
let automaticSessionReconnectTimerId = null;
let sessionRotationTimerId = null;
let serverRotationPending = false;
let contextRefreshPending = false;
let backgroundSessionReconnectPending = false;
let pendingSessionHandoffSocket = null;
let activeTurnUserRequest = "";
let activeWorkModeTurn = null;
const ownedWorkModeProjectUrls = new Set();
const conversationHistory = [];
const queuedUserMessages = [];
const initialTranscriptMarkup = elements.transcript.innerHTML;
const activeTranscriptReveals = new Set();
const completedThinkingMessagesAwaitingContent = new Set();
let lumiContentSequence = 0;
let thinkingCollapseFrameId = null;
let transcriptAutoFollow = true;
let transcriptProgrammaticScroll = false;
let transcriptProgrammaticScrollTimerId = null;
const conversationHistoryStore = createConversationHistoryStore();
let activeConversationId = "";
let historyReady = false;
let historyLimitWarning = "";

let petalsEnabled = DEFAULT_FALLING_PETALS_ENABLED;

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
  isEnabled: () => petalsEnabled,
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
    turnExecutionSequence += 1;
    taskOrchestrator.cancelTask("The task was interrupted by a new voice request.");
    activeTurnUserRequest = "";
    markFreshUserInputStarted();
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    finalizeTranscript("thinking");
  },
  onInputLevel: (level) => {
    syncMicrophoneLevel(level);
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
const taskOrchestrator = createTaskOrchestrator({
  maxSteps: DEFAULT_AGENT_MAX_STEPS,
  onHistoryChange: (history, event) => {
    taskStepView.render(history);
    void recordTaskHistoryEvent(event);
  },
});
const hicasSkill = createHicasSkillRuntime();
const qcWorkspace = createQcWorkspaceController({
  elements: {
    workspace: elements.qcWorkspace,
    summary: elements.qcRunSummary,
    serviceUrl: elements.qcServiceUrl,
    serviceToken: elements.qcServiceToken,
    domains: elements.qcAllowedDomains,
    discovery: elements.qcDiscoveryMode,
    workbook: elements.qcWorkbookInput,
    referenceWorkbook: elements.qcReferenceWorkbookInput,
    connectButton: elements.qcConnectButton,
    compileButton: elements.qcCompileButton,
    status: elements.qcStatus,
    plan: elements.qcRunPlan,
    comparisonSheet: elements.qcComparisonSheet,
    comparisonHeaderRow: elements.qcComparisonHeaderRow,
    comparisonKeys: elements.qcComparisonKeys,
    comparisonMappings: elements.qcComparisonMappings,
    compileComparisonButton: elements.qcCompileComparisonButton,
    collectComparisonButton: elements.qcCollectComparisonButton,
    comparisonStatus: elements.qcComparisonStatus,
    scheduleName: elements.qcScheduleName,
    scheduleTime: elements.qcScheduleTime,
    scheduleWeekdays: elements.qcScheduleWeekdays,
    createScheduleButton: elements.qcCreateScheduleButton,
    refreshSchedulesButton: elements.qcRefreshSchedulesButton,
    scheduleList: elements.qcScheduleList,
    refreshBugDraftsButton: elements.qcRefreshBugDraftsButton,
    bugDraftList: elements.qcBugDraftList,
    refineButton: elements.qcRefineButton,
    approveButton: elements.qcApproveButton,
    startButton: elements.qcStartRunButton,
    pauseButton: elements.qcPauseRunButton,
    resumeButton: elements.qcResumeRunButton,
    cancelButton: elements.qcCancelRunButton,
    approveStepButton: elements.qcApproveStepButton,
    downloads: elements.qcDownloads,
    downloadExcel: elements.qcDownloadExcel,
    downloadHtml: elements.qcDownloadHtml,
  },
  storageKeys: {
    url: STORAGE_KEYS.qcServiceUrl,
    token: STORAGE_KEYS.qcServiceToken,
    domains: STORAGE_KEYS.qcAllowedDomains,
    discovery: STORAGE_KEYS.qcDiscoveryEnabled,
    activeRun: STORAGE_KEYS.qcActiveRun,
    approvalToken: STORAGE_KEYS.qcRunApprovalToken,
  },
  onRefineRequested: ({ runId, needsReview }) => {
    queueUserMessage(
      `Review draft QC run ${runId}. Load it with qc_get_run_plan and resolve its ${needsReview} ambiguous step mapping(s) using qc_update_step_mapping. Do not invent missing expected business results; leave those as needs_review and explain the blocker. Finish by reporting how many steps still need human review.`,
    );
  },
  onRunStarted: ({ runId, testCases, steps, executionMode = "step", scheduled = false }) => {
    void sendRuntime("set_qc_execution_mode", {
      executionMode,
      tabId: activeWorkModeTurn?.target?.tabId ?? null,
    }).catch(() => {});
    queueUserMessage(
      `Execute ${scheduled ? "scheduled " : ""}approved Excel QC run ${runId}: ${testCases} test case(s), ${steps} step(s). Load the canonical plan with qc_get_run_plan and process it sequentially. For each step call qc_begin_step, observe-act-stabilize-verify through browser tools, then qc_record_step. Use fast execution only for controls explicitly returned as verified by hicas_get_skill_context; otherwise use step mode or needs_review. Read every pagination page or virtualized segment for comparisons. Do not skip terminal records. Call qc_complete_run only after every step is recorded.`,
    );
  },
  onComparisonRunReady: ({ runId, comparisonId, execute = false }) => {
    if (!execute) {
      elements.statusLine.textContent =
        `Comparison plan ${runId} is ready for mapping/key review and approval.`;
      return;
    }
    queueUserMessage(
      `Execute approved Data Compare run ${runId}, comparison ${comparisonId}. Extract every row from the current ERP grid across all pagination pages and virtualized segments. Use the approved field mapping and key only; send the complete row array with qc_record_comparison_actual. Ambiguous mapping or incomplete grid coverage must be needs_review, never a product defect.`,
    );
  },
  getActiveTarget: () => sendRuntime("browser_tool", {
    tool: "browser_get_active_context",
    args: {},
  }),
  getKnowledgeTarget: (url) => hicasSkill.routeMetadata(url),
  onSchedulesChanged: (schedules) => {
    void sendRuntime("qc_schedules_sync", { schedules }).catch(() => {});
  },
  onStatus: (message, tone) => {
    renderQcChatStatus(message, tone);
  },
  onRunChanged: (run, detail) => {
    renderQcRunCard(run, detail);
  },
  onSendBugDraft: async (item) => {
    const draft = item.draft || {};
    const searchTool = [...activeMcpTools.values()].find(
      (tool) => tool.toolName === "redmine_search_issues",
    );
    const createTool = [...activeMcpTools.values()].find(
      (tool) => tool.toolName === "redmine_create_issue",
    );
    if (!createTool) {
      throw new Error("Connect the Redmine connector in Lumi Settings before sending this draft.");
    }
    let duplicates = [];
    if (searchTool) {
      const searchResult = await runMcpTool(searchTool, {
        projectId: draft.project_id,
        statusId: "open",
        limit: 100,
        sort: "updated_on:desc",
      }, `redmine-duplicate-${item.id}`);
      const issues = searchResult?.issues || searchResult?.structuredContent?.issues || [];
      const fingerprintText = `${draft.module || ""} ${draft.step_id || ""}`.toLowerCase();
      duplicates = issues.filter((issue) => {
        const text = `${issue.subject || ""} ${issue.description || ""}`.toLowerCase();
        return fingerprintText.split(/\s+/).filter((term) => term.length > 3)
          .some((term) => text.includes(term));
      }).slice(0, 5);
    }
    if (
      duplicates.length
      && !window.confirm(
        `Redmine may already contain ${duplicates.length} similar open issue(s): `
        + `${duplicates.map((issue) => `#${issue.id}`).join(", ")}. Send anyway?`,
      )
    ) {
      throw new Error("Send cancelled after possible duplicate warning.");
    }
    const result = await runMcpTool(createTool, {
      projectId: draft.project_id,
      subject: draft.subject,
      description: draft.description,
      ...(draft.tracker_id ? { trackerId: draft.tracker_id } : {}),
      ...(draft.priority_id ? { priorityId: draft.priority_id } : {}),
      ...(draft.assigned_to_id ? { assignedToId: draft.assigned_to_id } : {}),
    }, `redmine-send-${item.id}`);
    const issue = result?.issue || result?.structuredContent?.issue || result;
    const issueId = Number(issue?.id);
    if (!Number.isInteger(issueId) || issueId < 1) {
      throw new Error("Redmine did not return a created issue ID.");
    }
    return {
      issueId,
      issueUrl: issue?.url || "",
    };
  },
  onCriticalApprovalGranted: ({ runId, stepId }) => {
    queueUserMessage(
      `The user granted separate approval for high-risk QC step ${stepId} in run ${runId}. Begin that exact step again, then continue the approved run without broadening its scope.`,
    );
  },
  onStatus: (message, tone) => {
    if (tone === "error") elements.statusLine.textContent = message;
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

function isExcelWorkbookFile(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  return Number(file?.size) > 0 && (
    name.endsWith(".xlsx")
    || type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}

function renderPendingImageAttachment() {
  elements.imageAttachmentTray.replaceChildren();
  const pendingAttachment = pendingWorkbookAttachment || pendingImageAttachment;
  elements.imageAttachmentTray.hidden = !pendingAttachment;
  if (!pendingAttachment) return;

  const card = document.createElement("div");
  card.className = "image-attachment-card";
  let preview;
  if (pendingAttachment.kind === "workbook") {
    preview = document.createElement("span");
    preview.className = "workbook-attachment-mark";
    preview.textContent = "XLSX";
  } else {
    preview = document.createElement("img");
    preview.src = pendingAttachment.previewDataUrl;
    preview.alt = `Attached image ${pendingAttachment.name}`;
  }
  const copy = document.createElement("div");
  copy.className = "image-attachment-copy";
  const name = document.createElement("strong");
  name.textContent = pendingAttachment.name;
  const details = document.createElement("span");
  details.textContent = pendingAttachment.kind === "workbook"
    ? `Excel QC workbook · ${formatImageAttachmentSize(pendingAttachment.byteSize)}`
    : `${pendingAttachment.width} × ${pendingAttachment.height} · ${formatImageAttachmentSize(pendingAttachment.byteSize)}`;
  copy.append(name, details);
  const remove = document.createElement("button");
  remove.className = "image-attachment-remove";
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove attached file");
  remove.title = "Remove attached file";
  remove.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18"></path>
    </svg>
  `;
  remove.addEventListener("click", () => {
    pendingImageAttachment = null;
    pendingWorkbookAttachment = null;
    renderPendingImageAttachment();
    syncMessageComposer();
    elements.messageInput.focus();
  });
  card.append(preview, copy, remove);
  elements.imageAttachmentTray.append(card);
}

function clearPendingImageAttachment() {
  pendingImageAttachment = null;
  pendingWorkbookAttachment = null;
  elements.imageAttachmentInput.value = "";
  renderPendingImageAttachment();
}

async function attachImageFiles(files) {
  const selectedFiles = Array.from(files || []);
  const file = selectedFiles[0];
  if (!file || imageAttachmentPending) {
    if (!file) elements.statusLine.textContent = "Drop or paste a JPEG, PNG, WebP, or GIF image.";
    return false;
  }

  imageAttachmentPending = true;
  syncMessageComposer();
  elements.statusLine.textContent = "Preparing image attachment…";
  try {
    const attachment = await prepareImageAttachment(file);
    pendingWorkbookAttachment = null;
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

async function attachComposerFiles(files) {
  const selectedFiles = Array.from(files || []);
  const file = selectedFiles[0];
  if (!file) {
    elements.statusLine.textContent = "Choose an image or an Excel QC workbook.";
    return false;
  }
  if (!isExcelWorkbookFile(file)) return attachImageFiles(selectedFiles);
  if (imageAttachmentPending) return false;
  if (file.size > 50 * 1024 * 1024) {
    elements.statusLine.textContent = "Excel workbooks must be 50 MB or smaller.";
    return false;
  }
  imageAttachmentPending = true;
  syncMessageComposer();
  try {
    pendingImageAttachment = null;
    pendingWorkbookAttachment = {
      kind: "workbook",
      file,
      name: String(file.name || "QC-workbook.xlsx"),
      byteSize: Number(file.size) || 0,
    };
    renderPendingImageAttachment();
    elements.statusLine.textContent =
      `Attached ${pendingWorkbookAttachment.name}. Send it to compile a QC Run Plan in chat.`;
    return true;
  } finally {
    imageAttachmentPending = false;
    elements.imageAttachmentInput.value = "";
    syncMessageComposer();
  }
}

function syncMessageComposer() {
  const ready = sessionStatus === "ready";
  const transportReady = isGeminiTransportReady();
  const hasText = Boolean(elements.messageInput.value.trim());
  const hasContent = hasText || Boolean(pendingImageAttachment || pendingWorkbookAttachment);
  const cancelMode = ready && agentTurnActive && !turnCancellationPending && !hasContent;
  const queueMode = ready
    && (agentTurnActive || turnCancellationPending || !transportReady)
    && hasContent;
  elements.messageInput.disabled = textSendPending;
  elements.messageInput.placeholder = textSendPending
    ? "Preparing your message…"
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
  elements.imageAttachmentButton.disabled = textSendPending || imageAttachmentPending;
  elements.messageSubmit.disabled =
    textSendPending
    || imageAttachmentPending
    || (!hasContent && !cancelMode);
}

function syncQueuedMessagePanel() {
  const count = queuedUserMessages.length;
  elements.messageQueue.hidden = count === 0;
  if (!count) return;
  const preview = queuedImageMessagePreview(queuedUserMessages[0]);
  elements.messageQueuePreview.textContent = preview;
  elements.messageQueuePreview.title = preview;
  elements.messageQueueCount.textContent = count > 1 ? `+${count - 1}` : "";
  elements.messageQueueSteer.disabled = turnCancellationPending || !isGeminiTransportReady();
  elements.messageQueueSteer.title = isGeminiTransportReady()
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
    ? status.controllerReady === false
      ? "Preparing Work Mode for this page..."
      : "Prompt-ready. Lumi will work on this exact tab."
    : status?.reason || "Lumi can open or switch to a website from this tab.";
  elements.connectTabButton.textContent = connected ? "Work" : navigationReady ? "Ready" : "Waiting";
  elements.connectTabButton.title = connected
    ? status.url || "This tab is the Work Mode target"
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
  const recentHistory = trimConversationHistory(conversationHistory);
  conversationHistory.splice(0, conversationHistory.length, ...recentHistory);
  void persistHistoryMessage(normalizedRole, clean);
}

async function ensureActiveConversation() {
  if (activeConversationId) {
    const existing = await conversationHistoryStore.getConversation(activeConversationId);
    if (existing) return existing;
  }
  const conversation = await conversationHistoryStore.createConversation();
  activeConversationId = conversation.id;
  await chrome.storage.local.set({
    [HISTORY_ACTIVE_CONVERSATION_STORAGE_KEY]: activeConversationId,
  });
  return conversation;
}

async function persistHistoryMessage(role, text, {
  kind = "chat",
  runId = qcWorkspace?.activeRun?.run_id || "",
} = {}) {
  if (!historyReady) return;
  try {
    const conversation = await ensureActiveConversation();
    await conversationHistoryStore.addMessage(conversation.id, {
      role,
      text,
      kind,
      runId,
    });
    historyLimitWarning = "";
    if (!elements.historyDrawer.hidden) await renderHistoryList();
  } catch (error) {
    historyLimitWarning = error instanceof Error ? error.message : "Could not save chat history.";
    elements.historyStatus.textContent = historyLimitWarning;
    elements.statusLine.textContent = historyLimitWarning;
  }
}

async function recordTaskHistoryEvent(event) {
  if (event?.type === "task_started") {
    void sendRuntime("task_target_lock", {
      taskId: event.taskId,
      runId: qcWorkspace?.activeRun?.run_id || "",
      tabId: activeWorkModeTurn?.target?.tabId ?? null,
    }).catch(() => {});
    return;
  }
  if (event?.type !== "task_done") return;
  if (!event.success) {
    await raiseTerminalAttention(event);
  }
  void sendRuntime("set_qc_execution_mode", { executionMode: "step" }).catch(() => {});
  void sendRuntime("task_target_release", { taskId: event.taskId }).catch(() => {});
  if (!historyReady) return;
  const outcome = event.success ? "Completed" : "Failed";
  await persistHistoryMessage(
    "system",
    `${outcome}: ${event.result}${event.evidence ? `\nEvidence: ${event.evidence}` : ""}`,
    {
      kind: event.success ? "task_summary" : "terminal_error",
    },
  );
}

function renderRunAttention(attention) {
  elements.runAttention.hidden = !attention;
  if (!attention) return;
  elements.runAttentionTitle.textContent = attention.title || "LUMI needs your attention";
  elements.runAttentionMessage.textContent =
    attention.message || "The current workflow stopped.";
  elements.runAttentionReturn.disabled = !Number.isInteger(attention.tabId);
  elements.runAttentionAcknowledge.disabled = Number.isInteger(attention.tabId);
}

async function raiseTerminalAttention(event) {
  const message = String(event.result || event.evidence || "The current workflow failed.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
  const runId = qcWorkspace?.activeRun?.run_id || "";
  const attention = await sendRuntime("attention_raise", {
    taskId: event.taskId,
    runId,
    tabId: activeWorkModeTurn?.target?.tabId ?? null,
    title: "LUMI workflow stopped",
    message,
  }).catch(() => ({
    taskId: event.taskId,
    tabId: activeWorkModeTurn?.target?.tabId ?? null,
    title: "LUMI workflow stopped",
    message,
  }));
  renderRunAttention(attention);
  avatarController.transitionState("error", { forMs: AVATAR_ERROR_STATE_DURATION_MS });
  elements.statusLine.textContent = message;
  let savedEvidence = null;
  const taskUrl = activeWorkModeTurn?.target?.url || "";
  if (qcWorkspace.mayCaptureOwnedSandboxEvidence(taskUrl)) {
    const captured = await captureCurrentTabFrame().catch(() => null);
    if (
      captured?.frame
      && captured.source?.tabId === activeWorkModeTurn?.target?.tabId
    ) {
      savedEvidence = await qcWorkspace.saveTerminalEvidence(
        captured.frame,
        captured.source.url || taskUrl,
      ).catch(() => null);
    }
  }
  await qcWorkspace.blockActiveRun(message).catch(() => null);
  if (savedEvidence?.path) {
    void persistHistoryMessage(
      "system",
      `Terminal evidence recorded for the owned sandbox run: ${savedEvidence.path}`,
      { kind: "task_summary" },
    );
  }
}

function formatHistoryTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

async function renderHistoryList() {
  const conversations = await conversationHistoryStore.listConversations();
  const usage = await conversationHistoryStore.storageUsage();
  elements.historyStatus.textContent = historyLimitWarning
    || `${usage.conversations}/100 chats · ${(usage.bytes / (1024 * 1024)).toFixed(1)}/100 MB`;
  elements.historyList.replaceChildren();
  for (const conversation of conversations) {
    const item = document.createElement("li");
    item.dataset.active = String(conversation.id === activeConversationId);
    const open = document.createElement("button");
    open.type = "button";
    open.dataset.action = "open";
    open.dataset.conversationId = conversation.id;
    const title = document.createElement("strong");
    title.textContent = conversation.title;
    const metadata = document.createElement("small");
    metadata.textContent =
      `${conversation.messageCount} messages · ${formatHistoryTime(conversation.updatedAt)}`;
    open.append(title, metadata);
    const actions = document.createElement("div");
    actions.className = "history-item-actions";
    for (const [action, label] of [["rename", "Rename"], ["delete", "Delete"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.dataset.conversationId = conversation.id;
      button.textContent = label;
      actions.append(button);
    }
    item.append(open, actions);
    elements.historyList.append(item);
  }
}

async function restoreConversation(conversationId, { reconnect = true } = {}) {
  if (taskOrchestrator.activeTask) {
    elements.historyStatus.textContent = "Finish or stop the current task before switching chats.";
    return false;
  }
  const conversation = await conversationHistoryStore.getConversation(conversationId);
  if (!conversation) return false;
  const messages = await conversationHistoryStore.getMessages(conversationId);
  clearConversationContext();
  if (messages.length) elements.transcript.replaceChildren();
  for (const message of messages) {
    if (!["user", "model"].includes(message.role)) continue;
    const role = message.role === "model" ? "lumi" : "user";
    const rendered = createMessage(role, message.text);
    if (role === "lumi") renderMarkdown(rendered.content, message.text);
    conversationHistory.push({ role: message.role, text: message.text });
  }
  if (qcWorkspace?.activeRun) renderQcRunCard(qcWorkspace.activeRun);
  const recentHistory = trimConversationHistory(conversationHistory);
  conversationHistory.splice(0, conversationHistory.length, ...recentHistory);
  activeConversationId = conversation.id;
  await chrome.storage.local.set({
    [HISTORY_ACTIVE_CONVERSATION_STORAGE_KEY]: activeConversationId,
  });
  await renderHistoryList();
  elements.historyDrawer.hidden = true;
  if (reconnect && sessionStatus === "ready") {
    void restartSessionWithContext("Loading local chat history…");
  }
  return true;
}

async function createNewConversation() {
  if (taskOrchestrator.activeTask) {
    elements.historyStatus.textContent = "Finish or stop the current task before starting a new chat.";
    return;
  }
  try {
    const conversation = await conversationHistoryStore.createConversation();
    activeConversationId = conversation.id;
    await chrome.storage.local.set({
      [HISTORY_ACTIVE_CONVERSATION_STORAGE_KEY]: activeConversationId,
    });
    clearConversationContext();
    if (qcWorkspace?.activeRun) renderQcRunCard(qcWorkspace.activeRun);
    await renderHistoryList();
    elements.historyDrawer.hidden = true;
    if (sessionStatus === "ready") {
      void restartSessionWithContext("Starting a new local chat…", {
        discardOldContext: true,
      });
    }
  } catch (error) {
    historyLimitWarning = error instanceof Error ? error.message : "Could not create a new chat.";
    elements.historyStatus.textContent = historyLimitWarning;
  }
}

async function initializeConversationHistory() {
  await conversationHistoryStore.openDatabase();
  const stored = await chrome.storage.local.get(HISTORY_ACTIVE_CONVERSATION_STORAGE_KEY);
  activeConversationId = String(stored[HISTORY_ACTIVE_CONVERSATION_STORAGE_KEY] || "");
  historyReady = true;
  let conversation = activeConversationId
    ? await conversationHistoryStore.getConversation(activeConversationId)
    : null;
  if (!conversation) conversation = await ensureActiveConversation();
  await restoreConversation(conversation.id, { reconnect: false });
  await renderHistoryList();
}

function clearConversationContext() {
  for (const message of activeTranscriptReveals) {
    cancelAnimationFrame(message.revealFrameId);
  }
  activeTranscriptReveals.clear();
  if (thinkingCollapseFrameId !== null) cancelAnimationFrame(thinkingCollapseFrameId);
  thinkingCollapseFrameId = null;
  completedThinkingMessagesAwaitingContent.clear();
  lumiContentSequence = 0;
  conversationHistory.length = 0;
  queuedUserMessages.length = 0;
  taskOrchestrator.clear();
  taskStepView.clear();
  clearTimeout(transcriptProgrammaticScrollTimerId);
  transcriptProgrammaticScrollTimerId = null;
  transcriptProgrammaticScroll = false;
  transcriptAutoFollow = true;
  hasConnectedInPanelLifetime = false;
  pendingThinkingReconnect = false;
  for (const role of Object.keys(partialMessages)) {
    partialMessages[role]?.disclosure?.dispose();
    partialMessages[role] = null;
  }
  elements.transcript.innerHTML = initialTranscriptMarkup;
  elements.messageInput.value = "";
  imageAttachmentPending = false;
  imageDragDepth = 0;
  elements.messageForm.classList.remove("is-image-dragging");
  clearPendingImageAttachment();
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

function scrollTranscriptToLatest({ smooth = false, force = false } = {}) {
  if (!force && (!transcriptAutoFollow || taskStepView.isReviewing)) return false;
  const top = elements.transcript.scrollHeight;
  if (smooth && typeof elements.transcript.scrollTo === "function") {
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

function createMessage(role, text, { attachment = null } = {}) {
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
  if (role === "user" && attachment) article.classList.add("message-attachment");
  const author = document.createElement("span");
  author.textContent = role === "lumi" ? "Lumi" : "You";
  const content = document.createElement(role === "lumi" ? "div" : "p");
  if (role === "lumi") content.className = "message-content";
  content.textContent = text;
  article.append(author);
  if (role === "user" && attachment) {
    if (attachment.kind === "workbook") {
      const file = document.createElement("div");
      file.className = "message-workbook-attachment";
      const mark = document.createElement("span");
      mark.textContent = "XLSX";
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = attachment.name || "QC workbook.xlsx";
      const detail = document.createElement("small");
      detail.textContent = `${formatImageAttachmentSize(attachment.byteSize)} · Excel QC workbook`;
      copy.append(name, detail);
      file.append(mark, copy);
      article.append(file);
    } else {
      const image = document.createElement("img");
      image.className = "message-attachment-preview";
      image.src = attachment.previewDataUrl;
      image.alt = attachment.name || "Attached image";
      article.append(image);
    }
  }
  article.append(content);
  elements.transcript.append(article);
  scrollTranscriptToLatest();
  return { article, content, role, text, visibleText: text };
}

function qcStats(run) {
  const plan = run?.plan || {};
  return {
    cases: Number(plan.stats?.test_cases || plan.test_cases?.length || 0),
    steps: Number(plan.stats?.steps || 0),
    review: Number(plan.stats?.needs_review || 0),
    highRisk: Number(plan.stats?.high_risk || 0),
  };
}

function qcStatusLabel(status) {
  return ({
    draft: "Review required",
    approved: "Approved",
    running: "Running",
    paused: "Paused",
    completed: "Completed",
    failed: "Failed",
    blocked: "Needs attention",
    cancelled: "Cancelled",
  })[status] || String(status || "Draft");
}

function qcActionButton(label, action, { primary = false, danger = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.qcAction = action;
  if (primary) button.classList.add("is-primary");
  if (danger) button.classList.add("is-danger");
  button.addEventListener("click", () => {
    void runQcCardAction(action, button);
  });
  return button;
}

async function runQcCardAction(action, button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    if (action === "refine") qcWorkspace.requestRefine();
    else if (action === "approve") await qcWorkspace.transitionRun("approve");
    else if (action === "start") await qcWorkspace.transitionRun("start");
    else if (action === "pause") await qcWorkspace.transitionRun("pause");
    else if (action === "resume") await qcWorkspace.transitionRun("resume");
    else if (action === "cancel") await qcWorkspace.transitionRun("cancel");
    else if (action === "approve_step") await qcWorkspace.approveCriticalStep();
    else if (action === "download_xlsx") await qcWorkspace.downloadArtifact("xlsx");
    else if (action === "download_html") await qcWorkspace.downloadArtifact("html");
    else if (action === "settings") await openSettings();
  } finally {
    button.disabled = false;
  }
}

function renderQcChatStatus(message, tone = "") {
  const clean = String(message || "").trim();
  if (!clean) return;
  qcRunCardNotice = { message: clean, tone: String(tone || "") };
  if (qcWorkspace?.activeRun) {
    renderQcRunCard(qcWorkspace.activeRun);
    return;
  }
  elements.statusLine.textContent = clean;
  if (!["error", "warning"].includes(tone)) return;
  const rendered = createMessage("lumi", `QC: ${clean}`);
  rendered.article.classList.add("qc-chat-service-message");
  const settings = qcActionButton("Open QC settings", "settings");
  rendered.article.append(settings);
}

function renderQcRunCard(run, detail = {}) {
  if (!run) {
    qcRunCardElement?.remove();
    qcRunCardElement = null;
    qcRunCardId = "";
    return;
  }
  if (!qcRunCardElement?.isConnected || qcRunCardId !== run.run_id) {
    qcRunCardElement?.remove();
    qcRunCardElement = document.createElement("article");
    qcRunCardElement.className = "message message-lumi qc-chat-card";
    qcRunCardId = run.run_id;
    elements.transcript.append(qcRunCardElement);
  }
  const card = qcRunCardElement;
  const priorPlanOpen = card.querySelector(".qc-chat-plan")?.open === true;
  card.replaceChildren();

  const author = document.createElement("span");
  author.textContent = "Lumi · QC";
  const shell = document.createElement("section");
  shell.className = "qc-chat-shell";
  shell.dataset.status = run.status || "draft";

  const header = document.createElement("header");
  const headingCopy = document.createElement("div");
  const eyebrow = document.createElement("small");
  eyebrow.textContent = "RUN PLAN";
  const heading = document.createElement("strong");
  heading.textContent = run.plan?.title
    || run.plan?.test_cases?.[0]?.title
    || `QC run ${String(run.run_id || "").slice(0, 8)}`;
  headingCopy.append(eyebrow, heading);
  const status = document.createElement("span");
  status.className = "qc-chat-status";
  status.textContent = qcStatusLabel(run.status);
  header.append(headingCopy, status);

  const stats = detail.stats || qcStats(run);
  const metrics = document.createElement("div");
  metrics.className = "qc-chat-metrics";
  for (const [value, label, tone] of [
    [stats.cases, "cases", ""],
    [stats.steps, "steps", ""],
    [stats.review, "review", stats.review ? "warning" : ""],
    [stats.highRisk, "high risk", stats.highRisk ? "danger" : ""],
  ]) {
    const metric = document.createElement("span");
    if (tone) metric.dataset.tone = tone;
    const number = document.createElement("strong");
    number.textContent = String(value);
    metric.append(number, document.createTextNode(label));
    metrics.append(metric);
  }

  const notice = document.createElement("p");
  notice.className = "qc-chat-notice";
  notice.dataset.tone = qcRunCardNotice.tone;
  notice.textContent = qcRunCardNotice.message
    || (run.status === "draft"
      ? "Review the complete plan below before approving any ERP changes."
      : `Run ${String(run.run_id || "").slice(0, 8)} is ${qcStatusLabel(run.status).toLowerCase()}.`);

  const plan = document.createElement("details");
  plan.className = "qc-chat-plan";
  plan.open = priorPlanOpen;
  const planSummary = document.createElement("summary");
  planSummary.textContent = `Review full plan · ${stats.steps} step${stats.steps === 1 ? "" : "s"}`;
  const planBody = document.createElement("div");
  planBody.className = "qc-chat-plan-body";
  for (const testCase of run.plan?.test_cases || []) {
    const testCaseCard = document.createElement("section");
    const title = document.createElement("strong");
    title.textContent = `${testCase.id || "Case"} · ${testCase.title || "Untitled test case"}`;
    const steps = document.createElement("ol");
    for (const step of testCase.steps || []) {
      const item = document.createElement("li");
      item.dataset.status = step.status || "";
      const action = document.createElement("b");
      action.textContent = `${step.action || "step"} · ${step.target || step.id || "target"}`;
      const instruction = document.createElement("span");
      instruction.textContent = step.instruction || "";
      const expected = document.createElement("small");
      expected.textContent = step.expected
        ? `Expected: ${step.expected}`
        : "Expected result missing · needs review";
      item.append(action, instruction, expected);
      steps.append(item);
    }
    testCaseCard.append(title, steps);
    planBody.append(testCaseCard);
  }
  plan.append(planSummary, planBody);

  const actions = document.createElement("footer");
  actions.className = "qc-chat-actions";
  if (run.status === "draft" && stats.review > 0) {
    actions.append(qcActionButton("Refine with Lumi", "refine", { primary: true }));
  } else if (run.status === "draft") {
    actions.append(qcActionButton("Approve plan", "approve", { primary: true }));
  } else if (run.status === "approved") {
    actions.append(
      qcActionButton("Start run", "start", { primary: true }),
      qcActionButton("Cancel", "cancel", { danger: true }),
    );
  } else if (run.status === "running") {
    actions.append(
      qcActionButton("Pause", "pause"),
      qcActionButton("Cancel", "cancel", { danger: true }),
    );
  } else if (run.status === "paused") {
    actions.append(
      qcActionButton("Resume", "resume", { primary: true }),
      qcActionButton("Cancel", "cancel", { danger: true }),
    );
  }
  const activeStep = detail.activeStep || qcWorkspace?.activeStep;
  if (
    activeStep?.risk === "high"
    && ["running", "paused"].includes(run.status)
  ) {
    actions.prepend(qcActionButton("Approve high-risk step", "approve_step", { primary: true }));
  }
  if (["completed", "failed"].includes(run.status)) {
    actions.append(
      qcActionButton("Executed Excel", "download_xlsx"),
      qcActionButton("HTML report", "download_html"),
    );
  }
  actions.append(qcActionButton("QC settings", "settings"));
  shell.append(header, metrics, notice, plan, actions);
  card.append(author, shell);
  scrollTranscriptToLatest({ smooth: true });
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

function clearSessionRotationTimer() {
  if (sessionRotationTimerId === null) return;
  clearTimeout(sessionRotationTimerId);
  sessionRotationTimerId = null;
}

function sessionHasInFlightWork() {
  return Boolean(
    agentTurnActive
    || turnCancellationPending
    || panelAudio.isUserSpeechActive()
    || browserToolRunning
    || pendingToolCallIds.size
    || pendingLiveTranslationStart
    || textSendPending
  );
}

function armSessionRotation(delayMs = SESSION_CONNECTION_ROTATION_MS) {
  clearSessionRotationTimer();
  if (!shouldMaintainGeminiSession) return;
  sessionRotationTimerId = setTimeout(() => {
    sessionRotationTimerId = null;
    if (
      sessionStatus !== "ready"
      || websocket?.readyState !== WebSocket.OPEN
      || pendingSessionHandoffSocket
      || sessionHasInFlightWork()
      || (!sessionResumptionHandle && !contextRefreshPending)
    ) {
      armSessionRotation(SESSION_ROTATION_RETRY_MS);
      return;
    }
    scheduleAutomaticSessionReconnect(
      contextRefreshPending
        ? "Refreshing Gemini Live with recent context only."
        : "Refreshing Gemini Live before its connection limit.",
      { discardOldContext: contextRefreshPending },
    );
  }, delayMs);
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
    || automaticSessionReconnectAttempt >= MAX_AUTOMATIC_SESSION_RECONNECT_ATTEMPTS
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
    armSessionRotation(SESSION_ROTATION_RETRY_MS);
    return false;
  }

  const reconnectInBackground = sessionStatus === "ready"
    || backgroundSessionReconnectPending;
  automaticSessionReconnectAttempt += 1;
  const reconnectDelayMs = delayMs ?? automaticSessionReconnectDelayMs(
    automaticSessionReconnectAttempt,
  );
  clearSessionRotationTimer();
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
  clearSessionRotationTimer();
  closePendingSessionHandoff();
  shouldMaintainGeminiSession = false;
  sessionConnectionOptions = null;
  sessionResumptionHandle = "";
  automaticSessionReconnectAttempt = 0;
  serverRotationPending = false;
  contextRefreshPending = false;
  backgroundSessionReconnectPending = false;
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

function redactAuditText(value) {
  return String(value || "")
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_API_KEY]")
    .replace(
      /\b(password|passwd|pwd|otp|secret|token|authorization|cookie)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 8000);
}

function auditBrowserArguments(tool, args = {}) {
  const audit = { ...args };
  delete audit._lumiWorkPolicy;
  delete audit.confirmed;
  if (tool === "browser_input_text") audit.text = "[REDACTED_INPUT]";
  if (Array.isArray(audit.filePaths)) {
    audit.filePaths = audit.filePaths.map((value) =>
      String(value).split(/[\\/]/).at(-1)).slice(0, 12);
  }
  return audit;
}

function auditBrowserResult(result = {}) {
  const verification = result?.controllerVerification || {};
  const diagnostics = result?.runtimeDiagnostics || {};
  return {
    success: result?.success !== false,
    message: redactAuditText(result?.message || result?.error || ""),
    url: redactAuditText(verification.url || result?.url || ""),
    title: redactAuditText(verification.title || result?.title || ""),
    query: redactAuditText(verification.query || ""),
    queryMatched: verification.queryMatched,
    evidence: redactAuditText(
      verification.content
      || verification.pageState
      || result?.content
      || "",
    ),
    consoleErrors: Array.isArray(diagnostics.consoleErrors)
      ? diagnostics.consoleErrors.slice(-50)
      : [],
    networkErrors: Array.isArray(diagnostics.networkErrors)
      ? diagnostics.networkErrors.slice(-50)
      : [],
  };
}

async function runBrowserTool(tool, args) {
  browserToolRunning = true;
  const controllerStartedAt = performance.now();
  const isUiAction = BROWSER_UI_ACTION_TOOLS.has(tool);
  avatarController.transitionState(isUiAction ? "ui_control" : "thinking");
  try {
    const activeContext = await sendRuntime("browser_tool", {
      tool: "browser_get_active_context",
      args: {},
    }).catch(() => null);
    if (isUiAction) {
      const knowledgeGate = await hicasSkill.actionGate(activeContext?.url || "");
      if (knowledgeGate.required && !knowledgeGate.prepared) {
        const error = new Error(knowledgeGate.error);
        error.recoverable = true;
        throw error;
      }
    }
    const qcRunActive = ["running", "paused"].includes(qcWorkspace.activeRun?.status);
    let effectiveExecutionMode = "step";
    if (
      isUiAction
      && qcRunActive
      && qcWorkspace.activeRun?.plan?.execution_mode === "fast_verified"
    ) {
      const controlCheck = await hicasSkill.verifiedControl({
        url: activeContext?.url || "",
        recordId: qcWorkspace.activeStep?.skill_record || "",
      });
      const fastAllowed = controlCheck.allowed
        && qcWorkspace.activeStep?.coverage_status === "verified";
      effectiveExecutionMode = fastAllowed ? "fast_verified" : "step";
      await sendRuntime("set_qc_execution_mode", {
        tabId: activeWorkModeTurn?.target?.tabId ?? null,
        executionMode: effectiveExecutionMode,
      });
    }
    const workModeAuthorization = isUiAction && !qcRunActive
      ? authorizeWorkModeAction({
          turn: activeWorkModeTurn,
          tool,
          args,
          currentContext: activeContext,
          ownedProjectUrls: ownedWorkModeProjectUrls,
        })
      : { args, projectPolicy: null };
    const qcAuthorizedArgs = isUiAction
      ? await qcWorkspace.authorizeBrowserAction(
          tool,
          workModeAuthorization.args,
          activeContext?.url || "",
        )
      : null;
    const executionArgs = qcAuthorizedArgs || workModeAuthorization.args || args;
    await qcWorkspace.recordAgentEvent({
      type: isUiAction ? "browser_action_started" : "browser_observation_started",
      phase: isUiAction ? "ACT" : "OBSERVE",
      payload: {
        tool,
        arguments: auditBrowserArguments(tool, executionArgs),
        url: activeContext?.url || "",
        execution_mode: effectiveExecutionMode,
      },
    });
    let result = tool === "browser_inspect_screenshot"
      ? await captureAndSendVisualInspectionFrame()
      : await sendRuntime("browser_tool", { tool, args: executionArgs });
    const actionCompletedAt = performance.now();
    if (tool === "browser_capture_screenshot" && result?.previewDataUrl) {
      createCapturedTabMessage(result);
      result = { ...result };
      delete result.previewDataUrl;
    }
    if (isUiAction) {
      const stabilizationStartedAt = performance.now();
      result = {
        ...result,
        controllerVerification: await collectAutomaticBrowserVerification({
          tool,
          args: executionArgs,
          result,
          readPageState: (query) => sendRuntime("browser_tool", {
            tool: "browser_get_page_state",
            args: query ? { query } : {},
          }),
        }),
      };
      result.lumiTimings = {
        controller_ms: Math.round(actionCompletedAt - controllerStartedAt),
        stabilize_ms: Math.round(performance.now() - stabilizationStartedAt),
        total_ms: Math.round(performance.now() - controllerStartedAt),
      };
      result.runtimeDiagnostics = await sendRuntime("collect_runtime_diagnostics", {
        tabId: activeWorkModeTurn?.target?.tabId ?? null,
        clear: true,
      }).catch(() => ({
        installed: false,
        consoleErrors: [],
        networkErrors: [],
      }));
      if (!qcRunActive) {
        recordCreatedProjectFromResult({
          turn: activeWorkModeTurn,
          tool,
          args: executionArgs,
          beforeContext: activeContext,
          result,
          ownedProjectUrls: ownedWorkModeProjectUrls,
        });
      }
    }
    await qcWorkspace.recordAgentEvent({
      type: isUiAction ? "browser_action_completed" : "browser_observation_completed",
      phase: isUiAction ? "VERIFY" : "OBSERVE",
      payload: {
        tool,
        result: auditBrowserResult(result),
        timings: result?.lumiTimings || {
          total_ms: Math.round(performance.now() - controllerStartedAt),
        },
      },
    });
    void qcWorkspace.recordDiscovery({
      url: result?.controllerVerification?.url || result?.url || activeContext?.url || "",
      title: result?.controllerVerification?.title || result?.title || activeContext?.title || "",
      tool,
      args: auditBrowserArguments(tool, executionArgs),
      result: auditBrowserResult(result),
    });
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
    await qcWorkspace.recordAgentEvent({
      type: "browser_tool_failed",
      phase: "RECOVER",
      payload: {
        tool,
        error: redactAuditText(error instanceof Error ? error.message : error),
        recoverable: error?.recoverable !== false,
        timings: {
          total_ms: Math.round(performance.now() - controllerStartedAt),
        },
      },
    }).catch(() => null);
    avatarController.transitionState("error", { forMs: AVATAR_ERROR_STATE_DURATION_MS });
    if (error?.recoverable !== false) {
      elements.qcStatus.dataset.tone = "warning";
      elements.qcStatus.textContent =
        `Recoverable browser issue: ${redactAuditText(error instanceof Error ? error.message : error)}`;
    }
    if (tool === "browser_upload_file") {
      const detail = error instanceof Error ? error.message : String(error || "Unknown upload error.");
      elements.statusLine.textContent = `Upload failed: ${detail}`;
    }
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
    budget_available: "The controller rejected step-budget exhaustion as a blocker. Preserve milestone memory and continue the unfinished original request.",
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
  if (!running || sourceSocket !== websocket) return false;
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

async function handleServerMessage(event, sourceSocket, sessionThinkingLevel) {
  const raw = typeof event.data === "string" ? event.data : await event.data.text();
  const response = JSON.parse(raw);
  const completingHandoff = sourceSocket === pendingSessionHandoffSocket;
  if (sourceSocket !== websocket && !completingHandoff) return;
  if (shouldRefreshLiveContext(response.usageMetadata)) {
    contextRefreshPending = true;
  }

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
      contextRefreshPending = false;
      sessionResumptionHandle = sourceSocket.lumiLatestResumptionHandle || "";
    }
    sourceSocket.lumiSetupComplete = true;
    const completedInBackground = sourceSocket.lumiBackgroundReconnect === true;
    automaticSessionReconnectAttempt = 0;
    clearAutomaticSessionReconnectTimer();
    armSessionRotation();
    sessionReadyAt = performance.now();
    hideConnectionNotice();
    clearSetupTimeout(sourceSocket);
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
    const resumedExistingSession = Boolean(sourceSocket.lumiResumptionHandle);
    const reconnectingExistingConversation = hasConnectedInPanelLifetime;
    if (!resumedExistingSession) {
      sendJson(buildInitialHistoryClientContent(conversationHistory), sourceSocket);
    }
    hasConnectedInPanelLifetime = true;
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
      elements.muteButton.disabled = false;
      syncMessageComposer();
      syncQueuedMessagePanel();
    } else {
      setSessionStatus("ready", readyMessage);
    }
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
      let isQcToolCall = false;
      let isHicasSkillToolCall = false;
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
            budget_available: "Step budget remains available; continue the unfinished workflow.",
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
          if (
            actionArgs.success === true
            && ["running", "paused"].includes(qcWorkspace.activeRun?.status)
          ) {
            throw new Error(
              "The active QC run is not complete. Record every remaining step and call qc_complete_run before done.",
            );
          }
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
        isQcToolCall = isQcTool(actionName);
        isHicasSkillToolCall = isHicasSkillTool(actionName);
        const isLiveTranslationTool = actionName === LIVE_TRANSLATE_TOOL_NAME;
        mcpTool = activeMcpTools.get(actionName) || null;
        if (
          !isBrowserTool
          && !isLiveTranslationTool
          && !isQcToolCall
          && !isHicasSkillToolCall
          && !mcpTool
        ) {
          throw new Error(`Unsupported tool: ${actionName}`);
        }
        if (mcpTool?.disabled) throw new Error("This MCP tool is disabled for the rest of this session.");
        activityTool = isLiveTranslationTool
          ? {
              activityLabel: "BUILT-IN TOOL",
              toolName: LIVE_TRANSLATE_TOOL_NAME,
              serverName: "Gemini Live Translate",
            }
          : isQcToolCall
            ? {
                activityLabel: "QC TOOL",
                toolName: actionName,
                serverName: "Lumi QC Local Service",
              }
          : isHicasSkillToolCall
            ? {
                activityLabel: "ERP SKILL",
                toolName: actionName,
                serverName: "Packaged HICAS knowledge",
              }
          : mcpTool;
        renderStandaloneActivity = Boolean(activityTool)
          && shouldRenderStandaloneToolActivity(orchestration);
        if (renderStandaloneActivity) {
          createMcpActivityCard(callId, activityTool, actionArgs);
        }
        let result = isLiveTranslationTool
          ? await runLiveTranslationTool(actionArgs)
          : isHicasSkillToolCall
            ? await hicasSkill.lookup(
                actionArgs,
                (await sendRuntime("browser_tool", {
                  tool: "browser_get_active_context",
                  args: {},
                }).catch(() => null))?.url || "",
              )
          : isQcToolCall
            ? await qcWorkspace.runTool(actionName, actionArgs)
          : isBrowserTool
            ? await runBrowserTool(actionName, actionArgs)
            : normalizeMcpToolResult(await runMcpTool(mcpTool, actionArgs, callId));
        if (isBrowserTool) {
          result = addBrowserWorkflowContext(result, {
            toolName: actionName,
            userRequest: activeTurnUserRequest,
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
              userRequest: activeTurnUserRequest,
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
      if (wasUserCancellation) {
        elements.statusLine.textContent = "Current action cancelled. Lumi is ready for your next request.";
      }
      flushQueuedUserMessage();
      responseAudioGate.reset();
    }
  }
  if (contextRefreshPending && !sessionHasInFlightWork()) {
    scheduleAutomaticSessionReconnect(
      "Refreshing Gemini Live with recent context only.",
      { discardOldContext: true },
    );
  } else if (serverRotationPending && !sessionHasInFlightWork()) {
    scheduleAutomaticSessionReconnect("Gemini Live requested a connection rotation.");
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
  } = options;
  const sessionModel = options.model || MODEL;
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
        model: `models/${sessionModel}`,
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
            ),
          }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }, sessionSocket);
  };
  sessionSocket.onmessage = (event) => {
    void handleServerMessage(event, sessionSocket, sessionThinkingLevel).catch((error) => {
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

    const primaryModelUnavailable = !expected
      && !sessionSocket.lumiSetupComplete
      && sessionModel !== FALLBACK_MODEL
      && /(model|resource).*(not found|unsupported|unavailable)|not found.*model/i.test(reason);
    if (primaryModelUnavailable) {
      if (closingActiveSocket) websocket = null;
      if (closingHandoffSocket) pendingSessionHandoffSocket = null;
      setSessionStatus(
        "connecting",
        `Primary Live model is unavailable. Retrying with ${FALLBACK_MODEL}…`,
      );
      openGeminiSocket({
        ...options,
        model: FALLBACK_MODEL,
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
      if (sessionSocket.lumiDiscardOldContext) contextRefreshPending = true;
      websocket = handoffPredecessorSocket;
      backgroundSessionReconnectPending = false;
      const retryDelay = automaticSessionReconnectAttempt
        >= MAX_AUTOMATIC_SESSION_RECONNECT_ATTEMPTS
        ? SESSION_ROTATION_RETRY_MS
        : automaticSessionReconnectDelayMs(automaticSessionReconnectAttempt);
      if (automaticSessionReconnectAttempt >= MAX_AUTOMATIC_SESSION_RECONNECT_ATTEMPTS) {
        automaticSessionReconnectAttempt = 0;
      }
      armSessionRotation(retryDelay);
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
    if (
      !expected
      && !isGeminiKeyIssue(reason)
      && scheduleAutomaticSessionReconnect(
        reason || "Gemini Live closed the idle connection.",
        { allowInFlight: true },
      )
    ) return;

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

function cleanupMedia() {
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
  taskOrchestrator.cancelTask("The Gemini Live session ended before the task completed.");
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
    await qcWorkspace.recordAgentEvent({
      type: "browser_tool_failed",
      phase: "RECOVER",
      payload: {
        tool,
        error: error instanceof Error ? error.message : String(error || "Browser tool failed."),
      },
    }).catch(() => {});
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

async function submitWorkbookQc(text, attachment) {
  if (!attachment?.file || textSendPending) return false;
  if (agentTurnActive || turnCancellationPending) {
    elements.statusLine.textContent =
      "Finish or stop the current Lumi action before compiling another QC workbook.";
    return false;
  }
  if (["approved", "running", "paused"].includes(qcWorkspace.activeRun?.status)) {
    elements.statusLine.textContent =
      "Finish or cancel the active QC run before compiling another workbook.";
    return false;
  }
  const prompt = String(text || "").trim();
  const displayText = prompt || `Create a QC Run Plan from ${attachment.name}`;
  textSendPending = true;
  syncMessageComposer();
  createMessage("user", displayText, { attachment });
  rememberConversationTurn(
    "user",
    `${displayText} [Attached workbook: ${attachment.name}]`,
  );
  elements.messageInput.value = "";
  clearPendingImageAttachment();
  resizeMessageInput();
  elements.statusLine.textContent = "Compiling the Excel workbook into a QC Run Plan…";
  try {
    const run = await qcWorkspace.compileWorkbook(attachment.file);
    void persistHistoryMessage(
      "system",
      `QC Run Plan ${run.run_id} compiled from ${attachment.name}.`,
      { kind: "task_summary", runId: run.run_id },
    );
    elements.statusLine.textContent =
      "Run Plan ready in chat. Review every step, then approve it here.";
    return true;
  } catch {
    elements.statusLine.textContent =
      "Could not compile this workbook. Open QC settings to check the local service.";
    return false;
  } finally {
    textSendPending = false;
    syncMessageComposer();
  }
}

async function sendText(
  text,
  {
    attachment = null,
    clearComposer = true,
    render = true,
    remember = true,
  } = {},
) {
  const clean = String(text || "").trim();
  const selectedAttachment = attachment?.frame?.data ? attachment : null;
  if (
    (!clean && !selectedAttachment)
    || textSendPending
    || !isGeminiTransportReady()
    || agentTurnActive
    || turnCancellationPending
  ) return false;
  textSendPending = true;
  syncMessageComposer();
  const frame = selectedAttachment?.frame || null;
  const userRequest = clean
    || "Please inspect the attached image and respond with the most helpful relevant analysis.";
  const activeContext = await sendRuntime("browser_tool", {
    tool: "browser_get_active_context",
    args: {},
  }).catch(() => null);
  activeWorkModeTurn = createWorkModeTurn({
    userRequest,
    activeContext,
  });
  const modelText = activeWorkModeTurn.modelText;
  textSendPending = false;
  if (!isGeminiTransportReady() || agentTurnActive || turnCancellationPending) {
    syncMessageComposer();
    return false;
  }
  const displayText = clean || `Image · ${selectedAttachment.name}`;
  const videoSent = frame ? sendJson({ realtimeInput: { video: frame } }) : true;
  const textSent = videoSent && sendJson({ realtimeInput: { text: modelText } });
  if (!videoSent || !textSent) {
    const failedSocket = websocket;
    if (failedSocket?.readyState < WebSocket.CLOSING) {
      try {
        failedSocket.close(4002, "Gemini realtime send failed");
      } catch {
        // The close event or setup timeout will recover this transport.
      }
    }
    elements.statusLine.textContent = clearComposer
      ? "Message was not sent and remains in the composer while Lumi restores the connection."
      : "Queued message was not sent; Lumi will retry it after restoring the connection.";
    syncMessageComposer();
    return false;
  }

  activeTurnUserRequest = userRequest;
  turnExecutionSequence += 1;
  if (suppressServerOutputUntilNextUserTurn) markFreshUserInputStarted();
  responseAudioGate.reset();
  finalizeTranscript("user");
  finalizeTranscript("lumi");
  finalizeTranscript("thinking");
  if (render) createMessage("user", displayText, { attachment: selectedAttachment });
  if (remember) {
    rememberConversationTurn(
      "user",
      selectedAttachment ? `${userRequest} [Attached image: ${selectedAttachment.name}]` : userRequest,
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
elements.transcript.addEventListener("scroll", () => {
  if (transcriptProgrammaticScroll) return;
  transcriptAutoFollow = isScrollAtBottom(elements.transcript);
}, { passive: true });
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
  void attachComposerFiles(elements.imageAttachmentInput.files);
});
elements.messageInput.addEventListener("paste", (event) => {
  const files = imageFilesFromClipboard(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  void attachImageFiles(files);
});
elements.messageForm.addEventListener("dragenter", (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  event.preventDefault();
  imageDragDepth += 1;
  elements.messageForm.classList.add("is-image-dragging");
});
elements.messageForm.addEventListener("dragover", (event) => {
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
  imageDragDepth = 0;
  elements.messageForm.classList.remove("is-image-dragging");
  void attachComposerFiles(event.dataTransfer?.files);
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
  const workbook = pendingWorkbookAttachment;
  if (workbook) {
    void submitWorkbookQc(message, workbook);
    return;
  }
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
elements.historyButton.addEventListener("click", () => {
  elements.historyDrawer.hidden = !elements.historyDrawer.hidden;
  if (!elements.historyDrawer.hidden) void renderHistoryList();
});
elements.historyCloseButton.addEventListener("click", () => {
  elements.historyDrawer.hidden = true;
});
elements.historyNewButton.addEventListener("click", () => void createNewConversation());
elements.historyClearButton.addEventListener("click", () => {
  if (!window.confirm("Delete all local Lumi chat history on this computer?")) return;
  void (async () => {
    await conversationHistoryStore.clear();
    activeConversationId = "";
    await chrome.storage.local.remove(HISTORY_ACTIVE_CONVERSATION_STORAGE_KEY);
    await createNewConversation();
  })();
});
elements.historyList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const conversationId = button.dataset.conversationId;
  if (!conversationId) return;
  if (button.dataset.action === "open") {
    void restoreConversation(conversationId);
    return;
  }
  if (button.dataset.action === "rename") {
    void (async () => {
      const conversation = await conversationHistoryStore.getConversation(conversationId);
      const title = window.prompt("Rename local chat", conversation?.title || "");
      if (title === null) return;
      await conversationHistoryStore.renameConversation(conversationId, title);
      await renderHistoryList();
    })();
    return;
  }
  if (button.dataset.action === "delete") {
    if (!window.confirm("Delete this local chat history?")) return;
    void (async () => {
      await conversationHistoryStore.deleteConversation(conversationId);
      if (conversationId === activeConversationId) {
        activeConversationId = "";
        await createNewConversation();
      } else {
        await renderHistoryList();
      }
    })();
  }
});
elements.runAttentionReturn.addEventListener("click", () => {
  void (async () => {
    try {
      await sendRuntime("attention_return_to_target");
      elements.runAttentionAcknowledge.disabled = false;
      elements.statusLine.textContent = "Returned to the ERP tab that needs review.";
    } catch (error) {
      elements.statusLine.textContent =
        error instanceof Error ? error.message : "Could not return to the ERP tab.";
    }
  })();
});
elements.runAttentionAcknowledge.addEventListener("click", () => {
  void (async () => {
    try {
      await sendRuntime("attention_acknowledge");
      renderRunAttention(null);
      elements.statusLine.textContent =
        "The alert was acknowledged. Resume the run only after checking the failed step.";
    } catch (error) {
      elements.statusLine.textContent =
        error instanceof Error ? error.message : "Could not acknowledge the alert.";
    }
  })();
});
window.addEventListener("unload", () => {
  intentionalClose = true;
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
  if (message?.type === EXTENSION_EVENTS.scheduledRun && message.result?.run) {
    void (async () => {
      const canExecute = sessionStatus === "ready" && isGeminiTransportReady();
      await qcWorkspace.activateScheduledRun(message.result, { execute: canExecute });
      if (!canExecute) {
        const reason =
          "The scheduled run was blocked because the Gemini Live agent session is not ready.";
        await qcWorkspace.blockActiveRun(reason).catch(() => null);
        const attention = await sendRuntime("attention_raise", {
          runId: message.result.run.run_id,
          tabId: message.tabId,
          title: "LUMI scheduled run blocked",
          message: reason,
        }).catch(() => null);
        renderRunAttention(attention);
      }
    })();
    return;
  }
  if (message?.type === EXTENSION_EVENTS.attention) {
    renderRunAttention(message.attention || null);
    return;
  }
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
    }
    return;
  }
  if (message?.type === EXTENSION_EVENTS.targetChanged) void refreshTarget();
});

async function initialize() {
  elements.extensionVersion.textContent = `v${chrome.runtime.getManifest().version}`;
  await initializeConversationHistory();
  await qcWorkspace.initialize();
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
  const activeAttention = await sendRuntime("attention_status").catch(() => null);
  renderRunAttention(activeAttention);
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
