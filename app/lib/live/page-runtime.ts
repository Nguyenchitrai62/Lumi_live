import { McpManager } from "../mcp";
import { StudioPageAgent } from "./studio-page-agent";
import type { LiveTranslationController } from "./translation-client";
import type { McpApprovalRequest, Role, VideoMode } from "./types";

export function createPageMediaRuntime() {
  return {
    websocket: null as WebSocket | null,
    micStream: null as MediaStream | null,
    micSource: null as MediaStreamAudioSourceNode | null,
    micProcessor: null as AudioWorkletNode | null,
    videoStream: null as MediaStream | null,
    sharedAudioSource: null as MediaStreamAudioSourceNode | null,
    sharedAudioGain: null as GainNode | null,
    videoFrameTimer: null as number | null,
    activeVideoMode: "none" as VideoMode,
    videoNotice: "",
    playbackSources: new Set<AudioBufferSourceNode>(),
    liveTranslationController: null as LiveTranslationController | null,
    suppressAgentAudioForTurn: false,
    intentionalClose: false,
    ready: false,
    muted: false,
    lastMicUiUpdate: 0,
  };
}

export function createPageTranscriptRuntime() {
  return {
    userPartialId: null as string | null,
    lumiPartialId: null as string | null,
    finalizeTimers: { user: null, lumi: null } as Record<Role, number | null>,
    awaitingNewUserTurn: false,
    messageSequence: 0,
  };
}

export function createPageToolRuntime() {
  return {
    mcpManager: new McpManager(),
    studioPageAgent: new StudioPageAgent(),
    mcpAvatarTimer: null as number | null,
    mcpApproval: null as McpApprovalRequest | null,
    cancelledToolCallIds: new Set<string>(),
    pendingToolCallIds: new Set<string>(),
    pendingToolCallNames: new Map<string, string>(),
    activeMcpCallControllers: new Map<string, AbortController>(),
    agentTurnActive: false,
    turnCancellationPending: false,
    turnCancellationSequence: 0,
    turnCancellationDrainTimer: null as number | null,
    turnCancellationWatchdogTimer: null as number | null,
    suppressServerOutputUntilNextUserTurn: false,
    cancelledTurnBoundarySeen: false,
    freshUserInputStarted: false,
    mcpToolCallSequence: 0,
  };
}
