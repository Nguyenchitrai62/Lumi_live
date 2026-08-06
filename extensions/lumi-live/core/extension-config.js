export const EXTENSION_EVENTS = Object.freeze({
  flowRecordedStep: "lumi_live_flow_recorded_step",
  flowRecordingChanged: "lumi_live_flow_recording_changed",
  flowReplayProgress: "lumi_live_flow_replay_progress",
  lifecycle: "lumi_live_lifecycle",
  request: "lumi_live_request",
  targetChanged: "lumi_live_target_changed",
  translationState: "lumi_live_translation_state",
  videoAnalysisProgress: "lumi_live_video_analysis_progress",
});

// Bump this whenever an already-open tab must reject an older injected
// controller. The version is part of both the message source and global key,
// so a stale controller cannot answer requests intended for the new bundle.
export const PAGE_CONTROLLER_PROTOCOL_VERSION = 4;

export const STORAGE_KEYS = Object.freeze({
  apiKey: "lumiGeminiApiKey",
  groqApiKey: "lumiGroqApiKey",
  avatarMode: "lumiAvatarMode",
  capturedTabAssets: "lumiCapturedTabAssets",
  chatHistory: "lumiLocalChatHistory",
  elementHighlights: "lumiShowElementHighlights",
  fastMode: "lumiFastMode",
  fastWorkspaceGroupId: "lumiFastWorkspaceGroupId",
  fallingPetals: "lumiFallingPetals",
  recordedFlowDraft: "lumiRecordedFlowDraft",
  recordedFlows: "lumiRecordedFlows",
  legacyMcpUrl: "lumiMcpServerUrl",
  mcpDisabledTools: "lumiDisabledMcpTools",
  mcpConnectorCredentials: "lumiMcpConnectorCredentials",
  mcpServers: "lumiMcpServers",
  mcpToolPolicies: "lumiMcpToolPolicies",
  microphoneEnabled: "lumiMicrophoneEnabled",
  microphoneGrantedAt: "lumiMicrophoneGrantedAt",
  targetTabId: "lumiLiveTargetTabId",
  thinkingLevel: "lumiGeminiThinkingLevel",
  voice: "lumiGeminiVoice",
});
