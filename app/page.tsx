"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { StudioConversationPanel } from "./components/StudioConversationPanel";
import { StudioHeader } from "./components/StudioHeader";
import { StudioSettingsPanel } from "./components/StudioSettingsPanel";
import { StudioStage } from "./components/StudioStage";
import { useAudioInputDevices } from "./hooks/useAudioInputDevices";
import { useMouthAnimation } from "./hooks/useMouthAnimation";
import { useStudioPreferences } from "./hooks/useStudioPreferences";
import { useVoicePreview } from "./hooks/useVoicePreview";
import type { PixelAvatarState } from "./lib/avatar-catalog";
import {
  formatMcpValue,
  normalizeMcpToolResult,
  type ActiveMcpTool,
  type McpServerView,
  type McpToolPolicy,
} from "./lib/mcp";
import {
  BASE_SYSTEM_INSTRUCTION,
  DEFAULT_VIDEO_MODE,
  DIRECT_WS_ENDPOINT,
  MIC_CAPTURE_PROCESSOR,
  MODEL,
  WS_ENDPOINT,
} from "./lib/live/config";
import {
  base64ToInt16,
  bytesToBase64,
  floatToPcm16,
  mergeTranscriptText,
  resampleTo16k,
} from "./lib/live/audio";
import {
  describeMicrophoneError,
  describeVideoError,
  getLiveAuth,
  getLiveTranslationSocketUrl,
  requestVideoStream,
} from "./lib/live/media";
import { LiveTranslationController, type LiveTranslationState } from "./lib/live/translation-client";
import {
  getLiveTranslationLanguageLabel,
  LIVE_TRANSLATE_TOOL_DECLARATION,
  LIVE_TRANSLATE_TOOL_NAME,
  LIVE_TRANSLATION_GUIDANCE,
  normalizeLiveTranslationLanguageCode,
} from "./lib/live/translation-config";
import {
  createPageMediaRuntime,
  createPageToolRuntime,
  createPageTranscriptRuntime,
} from "./lib/live/page-runtime";
import {
  buildPendingCancellationResponses,
  registerPendingFunctionCalls,
  settlePendingFunctionCalls,
} from "./lib/live/tool-call-ledger";
import {
  STUDIO_PAGE_AGENT_GUIDANCE,
  STUDIO_PAGE_AGENT_TOOL_DECLARATIONS,
  STUDIO_PAGE_AGENT_TOOL_NAMES,
} from "./lib/live/studio-page-agent";
import type {
  ChatMessage,
  McpApprovalRequest,
  Role,
  SessionStatus,
  VideoMode,
} from "./lib/live/types";

function createMcpActivityTiming() {
  const startedAt = Date.now();
  return {
    startedAt,
    startedLabel: new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(startedAt)),
  };
}

function formatMcpActivityDuration(startedAt?: number) {
  if (!startedAt) return "—";
  const elapsed = Math.max(0, Date.now() - startedAt);
  return elapsed < 1000 ? `${elapsed} ms` : `${(elapsed / 1000).toFixed(1)} s`;
}

export default function Home() {
  const {
    scene,
    setScene,
    outfit,
    setOutfit,
    themePreference,
    chooseTheme,
    petalsEnabled,
    choosePetals,
  } = useStudioPreferences();
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("Ready when you are");
  const [isMuted, setIsMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const {
    audioInputs,
    selectedDeviceId,
    setSelectedDeviceId,
    refreshAudioInputs,
  } = useAudioInputDevices();
  const [videoMode, setVideoMode] = useState<VideoMode>(DEFAULT_VIDEO_MODE);
  const {
    voiceName,
    voicePreviewPhase,
    selectedVoiceProfile,
    chooseVoice,
    previewSelectedVoice,
    stopVoicePreview,
  } = useVoicePreview({ status, onStatusMessage: setStatusMessage });
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpBusy, setMcpBusy] = useState(true);
  const [mcpMessage, setMcpMessage] = useState("");
  const [mcpApproval, setMcpApproval] = useState<McpApprovalRequest | null>(null);
  const [mcpAvatarState, setMcpAvatarState] = useState<PixelAvatarState | null>(null);
  const [agentTurnActive, setAgentTurnActive] = useState(false);
  const [turnCancellationPending, setTurnCancellationPending] = useState(false);
  const [liveTranslationState, setLiveTranslationState] = useState<LiveTranslationState>("off");
  const [liveTranslationTarget, setLiveTranslationTarget] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "lumi",
      text: "Hi! I’m Lumi. Pick a cozy scene, then start a voice chat whenever you’re ready. ✦",
    },
  ]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const nextPlaybackTimeRef = useRef(0);
  const speakingRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const mediaRuntimeRef = useRef<ReturnType<typeof createPageMediaRuntime> | null>(null);
  const transcriptRuntimeRef = useRef<ReturnType<typeof createPageTranscriptRuntime> | null>(null);
  const toolRuntimeRef = useRef<ReturnType<typeof createPageToolRuntime> | null>(null);
  if (mediaRuntimeRef.current === null) mediaRuntimeRef.current = createPageMediaRuntime();
  if (transcriptRuntimeRef.current === null) transcriptRuntimeRef.current = createPageTranscriptRuntime();
  if (toolRuntimeRef.current === null) toolRuntimeRef.current = createPageToolRuntime();
  const { mouthFrame, resetMouthFrame } = useMouthAnimation({
    analyserRef,
    audioContextRef,
    speakingRef,
    nextPlaybackTimeRef,
  });

  const updateTurnCancellationPending = (pending: boolean) => {
    toolRuntimeRef.current!.turnCancellationPending = pending;
    setTurnCancellationPending(pending);
  };

  const updateAgentTurnActive = (active: boolean) => {
    if (
      active
      && (
        toolRuntimeRef.current!.turnCancellationPending
        || (toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn && !toolRuntimeRef.current!.freshUserInputStarted)
      )
    ) return;
    const nextActive = mediaRuntimeRef.current!.ready && active;
    toolRuntimeRef.current!.agentTurnActive = nextActive;
    setAgentTurnActive(nextActive);
  };

  const clearTurnCancellationBoundaryTimer = () => {
    if (toolRuntimeRef.current!.turnCancellationBoundaryTimer !== null) {
      window.clearTimeout(toolRuntimeRef.current!.turnCancellationBoundaryTimer);
      toolRuntimeRef.current!.turnCancellationBoundaryTimer = null;
    }
  };

  const markFreshUserInputStarted = () => {
    toolRuntimeRef.current!.freshUserInputStarted = true;
    if (!toolRuntimeRef.current!.cancelledTurnBoundarySeen) return;
    toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn = false;
    toolRuntimeRef.current!.cancelledTurnBoundarySeen = false;
    toolRuntimeRef.current!.freshUserInputStarted = false;
  };

  const markCancelledTurnBoundarySeen = () => {
    clearTurnCancellationBoundaryTimer();
    toolRuntimeRef.current!.cancelledTurnBoundarySeen = true;
    if (!toolRuntimeRef.current!.freshUserInputStarted) return;
    toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn = false;
    toolRuntimeRef.current!.cancelledTurnBoundarySeen = false;
    toolRuntimeRef.current!.freshUserInputStarted = false;
    updateAgentTurnActive(true);
  };

  const setTransientMcpAvatarState = useCallback((nextState: PixelAvatarState, duration = 0) => {
    if (toolRuntimeRef.current!.mcpAvatarTimer !== null) window.clearTimeout(toolRuntimeRef.current!.mcpAvatarTimer);
    setMcpAvatarState(nextState);
    toolRuntimeRef.current!.mcpAvatarTimer = duration > 0
      ? window.setTimeout(() => {
          toolRuntimeRef.current!.mcpAvatarTimer = null;
          setMcpAvatarState(null);
        }, duration)
      : null;
  }, []);

  const refreshMcpServers = useCallback(async (showBusy = false) => {
    if (showBusy) setMcpBusy(true);
    try {
      const servers = await toolRuntimeRef.current!.mcpManager.refreshAll(true);
      setMcpServers(servers);
      const failedCount = servers.filter((server) => server.status === "error").length;
      if (showBusy) {
        setMcpMessage(failedCount
          ? `${servers.length - failedCount} connected · ${failedCount} need attention`
          : servers.length ? `${servers.length} MCP server${servers.length === 1 ? "" : "s"} ready` : "");
      }
      return servers;
    } finally {
      if (showBusy) setMcpBusy(false);
    }
  }, []);

  const requestMcpPermission = useCallback((
    tool: ActiveMcpTool,
    args: Record<string, unknown>,
    id: string,
  ) => new Promise<boolean>((resolve) => {
    if (toolRuntimeRef.current!.mcpApproval) {
      window.clearTimeout(toolRuntimeRef.current!.mcpApproval.timeoutId);
      toolRuntimeRef.current!.mcpApproval.resolve(false);
    }
    const timeoutId = window.setTimeout(() => {
      if (toolRuntimeRef.current!.mcpApproval?.id !== id) return;
      toolRuntimeRef.current!.mcpApproval = null;
      setMcpApproval(null);
      resolve(false);
    }, 45000);
    const request = { id, tool, args, resolve, timeoutId };
    toolRuntimeRef.current!.mcpApproval = request;
    setMcpApproval(request);
    setMessages((current) => current.map((message) =>
      message.id === `mcp-${id}` ? { ...message, state: "waiting" } : message));
  }), []);

  useEffect(() => {
    let disposed = false;
    toolRuntimeRef.current!.mcpManager.hydrate()
      .then((servers) => {
        if (disposed) return;
        setMcpServers(servers);
        const failedCount = servers.filter((server) => server.status === "error").length;
        if (failedCount) {
          setMcpMessage(`${failedCount} installed MCP server${failedCount === 1 ? "" : "s"} need attention`);
        }
      })
      .catch((error) => {
        if (!disposed) {
          setMcpMessage(error instanceof Error ? error.message : "Could not load installed MCP servers.");
        }
      })
      .finally(() => {
        if (!disposed) setMcpBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    mediaRuntimeRef.current!.muted = isMuted;
  }, [isMuted]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  useEffect(() => {
    const transcriptTimers = transcriptRuntimeRef.current!.finalizeTimers;
    const activeMcpCallControllers = toolRuntimeRef.current!.activeMcpCallControllers;
    const pendingToolCallIds = toolRuntimeRef.current!.pendingToolCallIds;
    const pendingToolCallNames = toolRuntimeRef.current!.pendingToolCallNames;
    return () => {
      mediaRuntimeRef.current!.intentionalClose = true;
      mediaRuntimeRef.current!.websocket?.close();
      mediaRuntimeRef.current!.micStream?.getTracks().forEach((track) => track.stop());
      if (mediaRuntimeRef.current!.videoFrameTimer !== null) window.clearTimeout(mediaRuntimeRef.current!.videoFrameTimer);
      Object.values(transcriptTimers).forEach((timer) => {
        if (timer !== null) window.clearTimeout(timer);
      });
      if (toolRuntimeRef.current!.mcpAvatarTimer !== null) window.clearTimeout(toolRuntimeRef.current!.mcpAvatarTimer);
      if (toolRuntimeRef.current!.turnCancellationDrainTimer !== null) window.clearTimeout(toolRuntimeRef.current!.turnCancellationDrainTimer);
      if (toolRuntimeRef.current!.turnCancellationWatchdogTimer !== null) window.clearTimeout(toolRuntimeRef.current!.turnCancellationWatchdogTimer);
      if (toolRuntimeRef.current!.turnCancellationBoundaryTimer !== null) window.clearTimeout(toolRuntimeRef.current!.turnCancellationBoundaryTimer);
      if (toolRuntimeRef.current!.mcpApproval) {
        window.clearTimeout(toolRuntimeRef.current!.mcpApproval.timeoutId);
        toolRuntimeRef.current!.mcpApproval.resolve(false);
      }
      activeMcpCallControllers.forEach((controller) => controller.abort());
      activeMcpCallControllers.clear();
      pendingToolCallIds.clear();
      pendingToolCallNames.clear();
      toolRuntimeRef.current!.mcpApproval = null;
      toolRuntimeRef.current!.studioPageAgent?.dispose();
      mediaRuntimeRef.current!.liveTranslationController?.stop();
      mediaRuntimeRef.current!.liveTranslationController = null;
      mediaRuntimeRef.current!.videoStream?.getTracks().forEach((track) => track.stop());
      audioContextRef.current?.close();
    };
  }, []);

  const finalizeTranscript = (role: Role) => {
    const runtime = transcriptRuntimeRef.current!;
    const idKey = role === "user" ? "userPartialId" : "lumiPartialId";
    const timer = transcriptRuntimeRef.current!.finalizeTimers[role];
    if (timer !== null) window.clearTimeout(timer);
    transcriptRuntimeRef.current!.finalizeTimers[role] = null;
    runtime[idKey] = null;
  };

  const scheduleTranscriptFinalization = (role: Role, delay = 900) => {
    const previousTimer = transcriptRuntimeRef.current!.finalizeTimers[role];
    if (previousTimer !== null) window.clearTimeout(previousTimer);
    transcriptRuntimeRef.current!.finalizeTimers[role] = window.setTimeout(() => {
      finalizeTranscript(role);
    }, delay);
  };

  const updateTranscript = (role: Role, text: string) => {
    if (!text.trim()) return;
    const runtime = transcriptRuntimeRef.current!;
    const idKey = role === "user" ? "userPartialId" : "lumiPartialId";
    const pendingTimer = transcriptRuntimeRef.current!.finalizeTimers[role];
    if (pendingTimer !== null) {
      window.clearTimeout(pendingTimer);
      transcriptRuntimeRef.current!.finalizeTimers[role] = null;
    }

    if (!runtime[idKey]) {
      transcriptRuntimeRef.current!.messageSequence += 1;
      runtime[idKey] = `${role}-transcript-${transcriptRuntimeRef.current!.messageSequence}`;
    }
    const messageId = runtime[idKey]!;

    setMessages((current) => {
      const existing = current.find((message) => message.id === messageId);
      if (!existing) return [...current, { id: messageId, role, text }];
      const mergedText = mergeTranscriptText(existing.text, text);
      if (mergedText === existing.text) return current;
      return current.map((message) => (
        message.id === messageId ? { ...message, text: mergedText } : message
      ));
    });

    if (transcriptRuntimeRef.current!.awaitingNewUserTurn) scheduleTranscriptFinalization(role);
  };

  const stopPlayback = () => {
    mediaRuntimeRef.current!.playbackSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    });
    mediaRuntimeRef.current!.playbackSources.clear();
    nextPlaybackTimeRef.current = audioContextRef.current?.currentTime ?? 0;
    speakingRef.current = false;
    resetMouthFrame();
  };

  const playPcmChunk = (base64: string) => {
    const context = audioContextRef.current;
    const analyser = analyserRef.current;
    if (!context || !analyser) return;

    const pcm = base64ToInt16(base64);
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) floats[i] = pcm[i] / 32768;

    const buffer = context.createBuffer(1, floats.length, 24000);
    buffer.copyToChannel(floats, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);

    const startAt = Math.max(context.currentTime + 0.025, nextPlaybackTimeRef.current);
    nextPlaybackTimeRef.current = startAt + buffer.duration;
    mediaRuntimeRef.current!.playbackSources.add(source);
    speakingRef.current = true;

    source.onended = () => {
      mediaRuntimeRef.current!.playbackSources.delete(source);
      if (mediaRuntimeRef.current!.playbackSources.size === 0 && context.currentTime >= nextPlaybackTimeRef.current - 0.05) {
        speakingRef.current = false;
      }
    };
    source.start(startAt);
  };

  const sendJson = (payload: unknown) => {
    const websocket = mediaRuntimeRef.current!.websocket;
    if (websocket?.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(payload));
  };

  const stopVideoCapture = () => {
    if (mediaRuntimeRef.current!.videoFrameTimer !== null) {
      window.clearTimeout(mediaRuntimeRef.current!.videoFrameTimer);
      mediaRuntimeRef.current!.videoFrameTimer = null;
    }

    mediaRuntimeRef.current!.sharedAudioSource?.disconnect();
    mediaRuntimeRef.current!.sharedAudioGain?.disconnect();
    mediaRuntimeRef.current!.sharedAudioSource = null;
    mediaRuntimeRef.current!.sharedAudioGain = null;

    const stream = mediaRuntimeRef.current!.videoStream;
    mediaRuntimeRef.current!.videoStream = null;
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });

    const video = videoElementRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    mediaRuntimeRef.current!.activeVideoMode = "none";
  };

  const setSharedAudioVolume = (volume: number) => {
    const gain = mediaRuntimeRef.current!.sharedAudioGain?.gain;
    const context = audioContextRef.current;
    if (!gain || !context) return false;
    gain.cancelScheduledValues(context.currentTime);
    gain.setTargetAtTime(Math.min(1, Math.max(0, volume)), context.currentTime, 0.025);
    return true;
  };

  const sendVideoFrame = () => {
    const video = videoElementRef.current;
    if (!mediaRuntimeRef.current!.ready || mediaRuntimeRef.current!.activeVideoMode === "none" || !video || video.readyState < 2) {
      return;
    }

    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) return;

    const maxDimension = 1024;
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    const canvas = videoCanvasRef.current ?? document.createElement("canvas");
    videoCanvasRef.current = canvas;
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const drawingContext = canvas.getContext("2d", { alpha: false });
    if (!drawingContext) return;

    drawingContext.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
    const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
    sendJson({
      realtimeInput: {
        video: { data, mimeType: "image/jpeg" },
      },
    });
  };

  const startVideoFrames = () => {
    if (mediaRuntimeRef.current!.videoFrameTimer !== null) window.clearTimeout(mediaRuntimeRef.current!.videoFrameTimer);
    if (mediaRuntimeRef.current!.activeVideoMode === "none") return;

    const tick = () => {
      sendVideoFrame();
      if (mediaRuntimeRef.current!.activeVideoMode !== "none") {
        mediaRuntimeRef.current!.videoFrameTimer = window.setTimeout(tick, 1000);
      }
    };
    mediaRuntimeRef.current!.videoFrameTimer = window.setTimeout(tick, 1000);
  };

  const attachVideoStream = async (stream: MediaStream, mode: Exclude<VideoMode, "none">) => {
    const video = videoElementRef.current;
    if (!video) throw new Error("The video preview is not ready.");

    mediaRuntimeRef.current!.videoStream = stream;
    mediaRuntimeRef.current!.activeVideoMode = mode;
    video.srcObject = stream;
    await video.play();

    const audioTrack = stream.getAudioTracks()[0];
    const audioContext = audioContextRef.current;
    const audioSettings = audioTrack?.getSettings() as (MediaTrackSettings & {
      suppressLocalAudioPlayback?: boolean;
    }) | undefined;
    const audioConstraints = audioTrack?.getConstraints() as (MediaTrackConstraints & {
      suppressLocalAudioPlayback?: boolean;
    }) | undefined;
    const sourceAudioIsSuppressed = audioSettings?.suppressLocalAudioPlayback === true
      || audioConstraints?.suppressLocalAudioPlayback === true;
    if (mode === "screen" && audioTrack && audioContext && sourceAudioIsSuppressed) {
      const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
      const gain = audioContext.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(audioContext.destination);
      mediaRuntimeRef.current!.sharedAudioSource = source;
      mediaRuntimeRef.current!.sharedAudioGain = gain;
    }

    const track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        if (mediaRuntimeRef.current!.videoStream !== stream) return;
        stopVideoCapture();
        setVideoMode("none");
        if (mediaRuntimeRef.current!.ready) {
          setStatusMessage(`${mode === "screen" ? "Screen sharing" : "Camera"} stopped — voice chat is still live`);
        }
      };
    }
  };

  const toggleMute = () => {
    const nextMuted = !mediaRuntimeRef.current!.muted;
    mediaRuntimeRef.current!.muted = nextMuted;
    setIsMuted(nextMuted);
    if (nextMuted) {
      setMicLevel(0);
      sendJson({ realtimeInput: { audioStreamEnd: true } });
    }
  };

  const setupMicrophone = async (context: AudioContext, stream: MediaStream) => {
    await context.audioWorklet.addModule("/audio/lumi-pcm-capture-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(context, MIC_CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });

    processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const mono = event.data;
      let energy = 0;
      for (const sample of mono) energy += sample * sample;
      const rms = Math.sqrt(energy / mono.length);
      const now = performance.now();
      if (now - mediaRuntimeRef.current!.lastMicUiUpdate >= 75) {
        const visibleLevel = mediaRuntimeRef.current!.muted
          ? 0
          : Math.min(1, Math.max(0, (rms - 0.0035) * 16));
        setMicLevel(visibleLevel);
        mediaRuntimeRef.current!.lastMicUiUpdate = now;
      }

      if (mediaRuntimeRef.current!.ready && !mediaRuntimeRef.current!.muted && transcriptRuntimeRef.current!.awaitingNewUserTurn && rms >= 0.012) {
        transcriptRuntimeRef.current!.awaitingNewUserTurn = false;
        if (toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn) markFreshUserInputStarted();
        mediaRuntimeRef.current!.suppressAgentAudioForTurn = false;
        finalizeTranscript("user");
        finalizeTranscript("lumi");
      }

      if (!mediaRuntimeRef.current!.ready || mediaRuntimeRef.current!.muted || toolRuntimeRef.current!.turnCancellationPending) return;
      if (
        toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn
        && !toolRuntimeRef.current!.freshUserInputStarted
      ) return;
      const websocket = mediaRuntimeRef.current!.websocket;
      if (!websocket || websocket.readyState !== WebSocket.OPEN) return;

      const pcm = floatToPcm16(resampleTo16k(mono, context.sampleRate));
      websocket.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: bytesToBase64(pcm),
              mimeType: "audio/pcm;rate=16000",
            },
          },
        }),
      );
    };

    source.connect(processor);
    mediaRuntimeRef.current!.micSource = source;
    mediaRuntimeRef.current!.micProcessor = processor;
  };

  const updateToolMessage = (
    id: string,
    state: NonNullable<ChatMessage["state"]>,
    text: string,
  ) => {
    setMessages((current) => current.map((message) =>
      message.id === id
        ? {
            ...message,
            state,
            text,
            durationLabel: ["completed", "failed", "cancelled"].includes(state)
              ? formatMcpActivityDuration(message.startedAt)
              : message.durationLabel,
          }
        : message));
  };

  const clearTurnCancellationTimers = () => {
    if (toolRuntimeRef.current!.turnCancellationDrainTimer !== null) {
      window.clearTimeout(toolRuntimeRef.current!.turnCancellationDrainTimer);
      toolRuntimeRef.current!.turnCancellationDrainTimer = null;
    }
    if (toolRuntimeRef.current!.turnCancellationWatchdogTimer !== null) {
      window.clearTimeout(toolRuntimeRef.current!.turnCancellationWatchdogTimer);
      toolRuntimeRef.current!.turnCancellationWatchdogTimer = null;
    }
  };

  const resetPendingTurnExecution = (message = "Cancelled by the user.") => {
    void toolRuntimeRef.current!.studioPageAgent?.cancel();
    const cancelledResponses = buildPendingCancellationResponses(
      toolRuntimeRef.current!.pendingToolCallIds,
      toolRuntimeRef.current!.pendingToolCallNames,
    );
    for (const callId of toolRuntimeRef.current!.pendingToolCallIds) {
      toolRuntimeRef.current!.cancelledToolCallIds.add(callId);
      toolRuntimeRef.current!.activeMcpCallControllers.get(callId)?.abort();
      updateToolMessage(`mcp-${callId}`, "cancelled", message);
    }
    toolRuntimeRef.current!.activeMcpCallControllers.forEach((controller) => controller.abort());
    toolRuntimeRef.current!.activeMcpCallControllers.clear();
    toolRuntimeRef.current!.pendingToolCallIds.clear();
    toolRuntimeRef.current!.pendingToolCallNames.clear();

    if (toolRuntimeRef.current!.mcpApproval) {
      const approval = toolRuntimeRef.current!.mcpApproval;
      window.clearTimeout(approval.timeoutId);
      toolRuntimeRef.current!.cancelledToolCallIds.add(approval.id);
      toolRuntimeRef.current!.mcpApproval = null;
      setMcpApproval(null);
      approval.resolve(false);
    }

    if (toolRuntimeRef.current!.mcpAvatarTimer !== null) window.clearTimeout(toolRuntimeRef.current!.mcpAvatarTimer);
    toolRuntimeRef.current!.mcpAvatarTimer = null;
    setMcpAvatarState(null);
    transcriptRuntimeRef.current!.awaitingNewUserTurn = false;
    stopPlayback();
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    return cancelledResponses;
  };

  const completeTurnCancellation = () => {
    if (!toolRuntimeRef.current!.turnCancellationPending) return;
    clearTurnCancellationTimers();
    resetPendingTurnExecution();
    updateTurnCancellationPending(false);
    updateAgentTurnActive(false);
    transcriptRuntimeRef.current!.awaitingNewUserTurn = true;
    setStatusMessage("Current action stopped — waiting silently for your next instruction");
    setTransientMcpAvatarState("listening", 600);
  };

  const scheduleTurnCancellationCompletion = () => {
    if (toolRuntimeRef.current!.turnCancellationDrainTimer !== null) {
      window.clearTimeout(toolRuntimeRef.current!.turnCancellationDrainTimer);
    }
    toolRuntimeRef.current!.turnCancellationDrainTimer = window.setTimeout(completeTurnCancellation, 120);
  };

  const runLiveTranslationTool = async (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const action = String(args.action ?? "").trim().toLowerCase();
    const controller = mediaRuntimeRef.current!.liveTranslationController;
    if (!controller) throw new Error("Start the Lumi voice session before using Live Translate.");

    if (action === "status") {
      const targetLanguageCode = controller.getTargetLanguageCode();
      return {
        state: controller.isActive() ? "active" : "off",
        ...(targetLanguageCode ? { targetLanguageCode } : {}),
      };
    }

    if (action === "stop") {
      const wasActive = controller.isActive();
      controller.stop();
      setSharedAudioVolume(1);
      setLiveTranslationState("off");
      setLiveTranslationTarget("");
      setStatusMessage(wasActive
        ? "Live translation stopped — Lumi is still listening"
        : "Live translation was already off");
      return { success: true, state: "off", wasActive };
    }

    if (action !== "start") {
      throw new Error("Live Translate action must be start, stop, or status.");
    }
    const targetLanguageCode = normalizeLiveTranslationLanguageCode(args.targetLanguageCode);
    if (!targetLanguageCode) {
      throw new Error("Choose one of the supported Live Translate target languages.");
    }
    if (mediaRuntimeRef.current!.activeVideoMode !== "screen") {
      throw new Error("Live Translate needs the Screen source. End voice, choose Screen, start again, and select the Chrome tab playing the video.");
    }
    const inputStream = mediaRuntimeRef.current!.videoStream;
    if (!inputStream?.getAudioTracks().length) {
      throw new Error("The shared Chrome tab has no audio track. End voice, reconnect with Screen, and enable Share tab audio in Chrome's picker.");
    }
    if (controller.isActive() && controller.getTargetLanguageCode() === targetLanguageCode) {
      const sourceAudioDucked = setSharedAudioVolume(0.06);
      mediaRuntimeRef.current!.suppressAgentAudioForTurn = true;
      stopPlayback();
      return {
        success: true,
        state: "active",
        targetLanguageCode,
        alreadyActive: true,
        sourcePlaybackVolume: sourceAudioDucked ? 0.06 : null,
        sourceAudioDucked,
      };
    }

    await controller.start({ inputStream, targetLanguageCode, signal });
    const sourceAudioDucked = setSharedAudioVolume(0.06);
    const languageLabel = getLiveTranslationLanguageLabel(targetLanguageCode);
    mediaRuntimeRef.current!.suppressAgentAudioForTurn = true;
    stopPlayback();
    setLiveTranslationTarget(targetLanguageCode);
    setStatusMessage(sourceAudioDucked
      ? `Live translating the shared video to ${languageLabel} · source audio at 6%`
      : `Live translating the shared video to ${languageLabel} · Chrome did not expose source-volume control`);
    return {
      success: true,
      state: "active",
      targetLanguageCode,
      source: "shared Chrome tab audio",
      audioOwner: "Gemini Live Translate tool",
      sourcePlaybackVolume: sourceAudioDucked ? 0.06 : null,
      sourceAudioDucked,
    };
  };

  const handleServerMessage = async (event: MessageEvent) => {
    const raw = typeof event.data === "string" ? event.data : await event.data.text();
    const response = JSON.parse(raw);

    for (const id of response.toolCallCancellation?.ids ?? []) {
      if (typeof id !== "string") continue;
      toolRuntimeRef.current!.cancelledToolCallIds.add(id);
      toolRuntimeRef.current!.activeMcpCallControllers.get(id)?.abort();
      toolRuntimeRef.current!.pendingToolCallIds.delete(id);
      toolRuntimeRef.current!.pendingToolCallNames.delete(id);
      updateToolMessage(`mcp-${id}`, "cancelled", "Gemini cancelled this tool call because the current turn changed.");
      if (toolRuntimeRef.current!.mcpApproval?.id === id) {
        window.clearTimeout(toolRuntimeRef.current!.mcpApproval.timeoutId);
        toolRuntimeRef.current!.mcpApproval.resolve(false);
        toolRuntimeRef.current!.mcpApproval = null;
        setMcpApproval(null);
      }
    }

    if (response.setupComplete) {
      clearTurnCancellationTimers();
      clearTurnCancellationBoundaryTimer();
      toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn = false;
      toolRuntimeRef.current!.cancelledTurnBoundarySeen = false;
      toolRuntimeRef.current!.freshUserInputStarted = false;
      mediaRuntimeRef.current!.ready = true;
      transcriptRuntimeRef.current!.awaitingNewUserTurn = false;
      updateTurnCancellationPending(false);
      setStatus("ready");
      const activeSource = mediaRuntimeRef.current!.activeVideoMode;
      const sourceMessage = activeSource === "screen"
        ? "Lumi is listening and viewing your shared screen"
        : activeSource === "camera"
          ? "Lumi is listening and viewing your camera"
          : mediaRuntimeRef.current!.videoNotice || "Lumi is listening — vision is off";
      setStatusMessage(sourceMessage);
      startVideoFrames();
      updateAgentTurnActive(true);
      sendJson({
        realtimeInput: {
          text: "Greet the player warmly in one short sentence and invite them to begin our roleplay.",
        },
      });
    }

    const serverContent = response.serverContent;
    const parts = serverContent?.modelTurn?.parts ?? [];
    const functionCalls = response.toolCall?.functionCalls ?? [];
    const hasTurnPayload = Boolean(
      parts.length > 0
      || serverContent?.inputTranscription?.text
      || serverContent?.outputTranscription?.text
      || functionCalls.length > 0
    );
    if (toolRuntimeRef.current!.turnCancellationPending) {
      if (hasTurnPayload && toolRuntimeRef.current!.turnCancellationDrainTimer !== null) {
        window.clearTimeout(toolRuntimeRef.current!.turnCancellationDrainTimer);
        toolRuntimeRef.current!.turnCancellationDrainTimer = null;
      }
      for (const functionCall of functionCalls) {
        if (typeof functionCall.id === "string") {
          toolRuntimeRef.current!.cancelledToolCallIds.add(functionCall.id);
          toolRuntimeRef.current!.activeMcpCallControllers.get(functionCall.id)?.abort();
        }
      }
      const cancelledResponses = functionCalls
        .filter((functionCall: { id?: unknown; name?: unknown }) => (
          typeof functionCall.id === "string" && typeof functionCall.name === "string"
        ))
        .map((functionCall: { id?: unknown; name?: unknown }) => ({
          id: String(functionCall.id),
          name: String(functionCall.name),
          response: { error: "Cancelled by the user before this tool could run." },
        }));
      if (cancelledResponses.length > 0) {
        sendJson({ toolResponse: { functionResponses: cancelledResponses } });
      }
      if (serverContent?.interrupted || serverContent?.turnComplete) {
        markCancelledTurnBoundarySeen();
      }
      if (serverContent?.interrupted) resetPendingTurnExecution();
      if (serverContent?.turnComplete) scheduleTurnCancellationCompletion();
      return;
    }
    if (toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn) {
      const cancelledResponses = functionCalls
        .filter((functionCall: { id?: unknown; name?: unknown }) => (
          typeof functionCall.id === "string" && typeof functionCall.name === "string"
        ))
        .map((functionCall: { id?: unknown; name?: unknown }) => ({
          id: String(functionCall.id),
          name: String(functionCall.name),
          response: { error: "Ignored because the previous turn was cancelled." },
        }));
      for (const functionCall of functionCalls) {
        if (typeof functionCall.id === "string") {
          toolRuntimeRef.current!.cancelledToolCallIds.add(functionCall.id);
        }
      }
      if (cancelledResponses.length > 0) {
        sendJson({ toolResponse: { functionResponses: cancelledResponses } });
      }
      if (
        serverContent?.interrupted
        || serverContent?.turnComplete
        || (toolRuntimeRef.current!.freshUserInputStarted && serverContent?.inputTranscription?.text)
      ) {
        markCancelledTurnBoundarySeen();
        if (toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn) updateAgentTurnActive(false);
      }
      return;
    }
    if (
      parts.length > 0
      || serverContent?.inputTranscription?.text
      || serverContent?.outputTranscription?.text
      || functionCalls.length > 0
    ) updateAgentTurnActive(true);
    for (const part of parts) {
      if (part.inlineData?.data && !mediaRuntimeRef.current!.suppressAgentAudioForTurn) {
        playPcmChunk(part.inlineData.data);
      }
    }

    if (serverContent?.inputTranscription?.text) {
      updateTranscript("user", serverContent.inputTranscription.text);
    }
    if (serverContent?.outputTranscription?.text) {
      updateTranscript("lumi", serverContent.outputTranscription.text);
    }
    if (serverContent?.interrupted) {
      const wasUserCancellation = toolRuntimeRef.current!.turnCancellationPending;
      updateTurnCancellationPending(false);
      stopPlayback();
      scheduleTranscriptFinalization("lumi");
      updateAgentTurnActive(false);
      if (wasUserCancellation) {
        setStatusMessage("Current action cancelled â€” Lumi is ready for your next request");
      }
    }
    if (serverContent?.turnComplete) {
      const wasUserCancellation = toolRuntimeRef.current!.turnCancellationPending;
      updateTurnCancellationPending(false);
      transcriptRuntimeRef.current!.awaitingNewUserTurn = true;
      scheduleTranscriptFinalization("user");
      scheduleTranscriptFinalization("lumi");
      updateAgentTurnActive(false);
      if (wasUserCancellation) {
        setStatusMessage("Current action cancelled â€” Lumi is ready for your next request");
      }
    }

    if (functionCalls.length > 0) {
      const cancellationSequence = toolRuntimeRef.current!.turnCancellationSequence;
      const functionResponses = [];
      const functionCallBatch = functionCalls.map((functionCall: {
        id?: unknown;
        name: string;
        args?: Record<string, unknown>;
      }) => {
        toolRuntimeRef.current!.mcpToolCallSequence += 1;
        return {
          ...functionCall,
          id: typeof functionCall.id === "string"
            ? functionCall.id
            : `tool-${toolRuntimeRef.current!.mcpToolCallSequence}`,
        };
      });
      registerPendingFunctionCalls(
        functionCallBatch,
        toolRuntimeRef.current!.pendingToolCallIds,
        toolRuntimeRef.current!.pendingToolCallNames,
        toolRuntimeRef.current!.cancelledToolCallIds,
      );
      for (const functionCall of functionCallBatch) {
        if (
          cancellationSequence !== toolRuntimeRef.current!.turnCancellationSequence
          || toolRuntimeRef.current!.turnCancellationPending
        ) break;
        const callId = functionCall.id;
        if (toolRuntimeRef.current!.cancelledToolCallIds.has(callId)) continue;
        const isLiveTranslationTool = functionCall.name === LIVE_TRANSLATE_TOOL_NAME;
        const isStudioPageAgentTool = STUDIO_PAGE_AGENT_TOOL_NAMES.has(functionCall.name);
        const mcpTool = toolRuntimeRef.current!.mcpManager.getActiveTool(functionCall.name);
        const activityId = `mcp-${callId}`;
        let mcpCallController: AbortController | null = null;
        try {
          if (!isLiveTranslationTool && !isStudioPageAgentTool && !mcpTool) {
            throw new Error(`Unsupported tool: ${functionCall.name}`);
          }
          const args = functionCall.args && typeof functionCall.args === "object"
            ? functionCall.args as Record<string, unknown>
            : {};

          if (isLiveTranslationTool || isStudioPageAgentTool || mcpTool) {
            setTransientMcpAvatarState("tool_call");
            setMessages((current) => [
              ...current,
              {
                id: activityId,
                role: "tool",
                title: isLiveTranslationTool
                  ? "live_translate"
                  : isStudioPageAgentTool ? functionCall.name : mcpTool!.toolName,
                activityLabel: mcpTool ? "MCP TOOL" : "BUILT-IN TOOL",
                serverName: isLiveTranslationTool
                  ? "Gemini Live Translate"
                  : isStudioPageAgentTool ? "Lumi Web Studio · PageAgent" : mcpTool!.serverName,
                args: formatMcpValue(args, 24000),
                text: "No result yet.",
                state: "running",
                ...createMcpActivityTiming(),
              },
            ]);
            if (mcpTool?.permission === "ask") {
              const allowed = await requestMcpPermission(mcpTool, args, callId);
              if (!allowed) throw new Error("MCP tool permission was denied or timed out.");
            }
          }

          mcpCallController = new AbortController();
          toolRuntimeRef.current!.activeMcpCallControllers.set(callId, mcpCallController);
          const result = isLiveTranslationTool
            ? await runLiveTranslationTool(args, mcpCallController.signal)
            : isStudioPageAgentTool
              ? await toolRuntimeRef.current!.studioPageAgent!.run(functionCall.name, args, mcpCallController.signal)
              : normalizeMcpToolResult(
              await toolRuntimeRef.current!.mcpManager.callFunction(functionCall.name, args, {
                signal: mcpCallController.signal,
              }),
            );

          if (
            toolRuntimeRef.current!.cancelledToolCallIds.has(callId)
            || cancellationSequence !== toolRuntimeRef.current!.turnCancellationSequence
          ) {
            if (isLiveTranslationTool || isStudioPageAgentTool || mcpTool) {
              updateToolMessage(activityId, "cancelled", "The tool result arrived after this turn was cancelled.");
            }
            continue;
          }
          if (isLiveTranslationTool || isStudioPageAgentTool || mcpTool) {
            updateToolMessage(activityId, "completed", formatMcpValue(result, 24000));
            setTransientMcpAvatarState("success", 1760);
          }
          functionResponses.push({
            id: callId,
            name: functionCall.name,
            response: { result },
          });
        } catch (error) {
          if (
            toolRuntimeRef.current!.cancelledToolCallIds.has(callId)
            || cancellationSequence !== toolRuntimeRef.current!.turnCancellationSequence
          ) {
            if (isLiveTranslationTool || isStudioPageAgentTool || mcpTool) {
              updateToolMessage(activityId, "cancelled", "The tool was cancelled before it completed.");
            }
            continue;
          }
          if (isLiveTranslationTool || isStudioPageAgentTool || mcpTool) {
            const message = error instanceof Error ? error.message : "The tool failed.";
            updateToolMessage(activityId, "failed", message);
            setTransientMcpAvatarState("error", 2080);
          }
          functionResponses.push({
            id: callId,
            name: functionCall.name,
            response: {
              error: error instanceof Error ? error.message : "The tool failed.",
            },
          });
        } finally {
          if (mcpCallController) toolRuntimeRef.current!.activeMcpCallControllers.delete(callId);
        }
      }

      if (
        functionResponses.length
        && cancellationSequence === toolRuntimeRef.current!.turnCancellationSequence
        && !toolRuntimeRef.current!.turnCancellationPending
      ) {
        sendJson({ toolResponse: { functionResponses } });
        settlePendingFunctionCalls(
          functionResponses,
          toolRuntimeRef.current!.pendingToolCallIds,
          toolRuntimeRef.current!.pendingToolCallNames,
        );
        for (const functionResponse of functionResponses) {
          toolRuntimeRef.current!.cancelledToolCallIds.delete(functionResponse.id);
        }
      }
    }
    if (serverContent?.turnComplete && functionCalls.length === 0) {
      mediaRuntimeRef.current!.suppressAgentAudioForTurn = false;
    }
  };

  const stopSession = (showIdle = true) => {
    clearTurnCancellationTimers();
    clearTurnCancellationBoundaryTimer();
    toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn = false;
    toolRuntimeRef.current!.cancelledTurnBoundarySeen = false;
    toolRuntimeRef.current!.freshUserInputStarted = false;
    mediaRuntimeRef.current!.suppressAgentAudioForTurn = false;
    mediaRuntimeRef.current!.intentionalClose = true;
    mediaRuntimeRef.current!.ready = false;
    transcriptRuntimeRef.current!.awaitingNewUserTurn = false;
    updateTurnCancellationPending(false);
    updateAgentTurnActive(false);
    toolRuntimeRef.current!.turnCancellationSequence += 1;
    for (const callId of toolRuntimeRef.current!.pendingToolCallIds) {
      toolRuntimeRef.current!.cancelledToolCallIds.add(callId);
      updateToolMessage(
        `mcp-${callId}`,
        "cancelled",
        "The live session ended before this MCP tool completed.",
      );
    }
    if (toolRuntimeRef.current!.mcpApproval) {
      window.clearTimeout(toolRuntimeRef.current!.mcpApproval.timeoutId);
      toolRuntimeRef.current!.cancelledToolCallIds.add(toolRuntimeRef.current!.mcpApproval.id);
      updateToolMessage(
        `mcp-${toolRuntimeRef.current!.mcpApproval.id}`,
        "cancelled",
        "The live session ended before this MCP tool was approved.",
      );
      toolRuntimeRef.current!.mcpApproval.resolve(false);
    }
    toolRuntimeRef.current!.mcpApproval = null;
    setMcpApproval(null);
    toolRuntimeRef.current!.activeMcpCallControllers.forEach((controller) => controller.abort());
    toolRuntimeRef.current!.activeMcpCallControllers.clear();
    void toolRuntimeRef.current!.studioPageAgent?.cancel();
    toolRuntimeRef.current!.pendingToolCallIds.clear();
    toolRuntimeRef.current!.pendingToolCallNames.clear();
    if (toolRuntimeRef.current!.mcpAvatarTimer !== null) window.clearTimeout(toolRuntimeRef.current!.mcpAvatarTimer);
    toolRuntimeRef.current!.mcpAvatarTimer = null;
    setMcpAvatarState(null);
    toolRuntimeRef.current!.cancelledToolCallIds.clear();
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    mediaRuntimeRef.current!.liveTranslationController?.stop();
    mediaRuntimeRef.current!.liveTranslationController = null;
    setLiveTranslationState("off");
    setLiveTranslationTarget("");
    stopPlayback();
    mediaRuntimeRef.current!.websocket?.close();
    mediaRuntimeRef.current!.websocket = null;
    stopVideoCapture();
    if (mediaRuntimeRef.current!.micProcessor) mediaRuntimeRef.current!.micProcessor.port.onmessage = null;
    mediaRuntimeRef.current!.micProcessor?.disconnect();
    mediaRuntimeRef.current!.micSource?.disconnect();
    mediaRuntimeRef.current!.micStream?.getTracks().forEach((track) => track.stop());
    mediaRuntimeRef.current!.micStream = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    mediaRuntimeRef.current!.muted = false;
    setIsMuted(false);
    setMicLevel(0);
    if (showIdle) {
      setStatus("idle");
      setStatusMessage("Ready when you are");
    }
  };

  const startSession = async () => {
    if (status === "ready") {
      stopSession();
      return;
    }

    const requestedVideoMode = videoMode;
    clearTurnCancellationTimers();
    clearTurnCancellationBoundaryTimer();
    toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn = false;
    toolRuntimeRef.current!.cancelledTurnBoundarySeen = false;
    toolRuntimeRef.current!.freshUserInputStarted = false;
    mediaRuntimeRef.current!.suppressAgentAudioForTurn = false;
    setStatus("connecting");
    updateTurnCancellationPending(false);
    updateAgentTurnActive(false);
    toolRuntimeRef.current!.turnCancellationSequence += 1;
    setStatusMessage(requestedVideoMode === "screen"
      ? "Choose the Chrome Tab you want Lumi to see…"
      : requestedVideoMode === "camera"
        ? "Requesting camera and microphone access…"
        : "Opening a voice channel…");
    mediaRuntimeRef.current!.intentionalClose = false;
    mediaRuntimeRef.current!.videoNotice = "";

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access requires HTTPS or localhost in a supported browser.");
      }

      const context = new AudioContext({ latencyHint: "interactive" });
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.45;
      analyser.connect(context.destination);
      analyserRef.current = analyser;
      nextPlaybackTimeRef.current = context.currentTime;
      await context.resume();

      const [liveAuth, stream, videoResult, activeMcpServers] = await Promise.all([
        getLiveAuth(),
        navigator.mediaDevices.getUserMedia({
          audio: {
            ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }).then((mediaStream) => {
          mediaRuntimeRef.current!.micStream = mediaStream;
          return mediaStream;
        }),
        requestVideoStream(requestedVideoMode)
          .then((mediaStream) => {
            mediaRuntimeRef.current!.videoStream = mediaStream;
            return { stream: mediaStream, error: null as unknown };
          })
          .catch((error: unknown) => ({ stream: null, error })),
        refreshMcpServers(false),
      ]);

      if (videoResult.error) {
        mediaRuntimeRef.current!.videoNotice = describeVideoError(videoResult.error, requestedVideoMode);
        setVideoMode("none");
      } else if (videoResult.stream && requestedVideoMode !== "none") {
        try {
          await attachVideoStream(videoResult.stream, requestedVideoMode);
        } catch (error) {
          stopVideoCapture();
          mediaRuntimeRef.current!.videoNotice = describeVideoError(error, requestedVideoMode);
          setVideoMode("none");
        }
      }
      await refreshAudioInputs(false);
      await setupMicrophone(context, stream);
      mediaRuntimeRef.current!.liveTranslationController = new LiveTranslationController({
        audioContext: context,
        createSocketUrl: getLiveTranslationSocketUrl,
        onStateChange: (nextState, detail) => {
          setLiveTranslationState(nextState);
          if (nextState === "off") {
            setLiveTranslationTarget("");
            setSharedAudioVolume(1);
          }
          else {
            const languageCode = normalizeLiveTranslationLanguageCode(detail);
            if (languageCode) setLiveTranslationTarget(languageCode);
          }
          if (nextState === "error" && detail) setStatusMessage(detail);
        },
        onError: (error) => setStatusMessage(error.message),
      });

      const websocketUrl = liveAuth.kind === "apiKey"
        ? `${DIRECT_WS_ENDPOINT}?key=${encodeURIComponent(liveAuth.credential)}`
        : `${WS_ENDPOINT}?access_token=${encodeURIComponent(liveAuth.credential)}`;
      const functionDeclarations = [
        LIVE_TRANSLATE_TOOL_DECLARATION,
        ...STUDIO_PAGE_AGENT_TOOL_DECLARATIONS,
        ...toolRuntimeRef.current!.mcpManager.buildFunctionDeclarations(activeMcpServers),
      ];
      const sessionInstruction = [
        BASE_SYSTEM_INSTRUCTION,
        LIVE_TRANSLATION_GUIDANCE,
        STUDIO_PAGE_AGENT_GUIDANCE,
        toolRuntimeRef.current!.mcpManager.buildSessionGuidance(activeMcpServers),
      ].filter(Boolean).join("\n\n");
      const websocket = new WebSocket(websocketUrl);
      mediaRuntimeRef.current!.websocket = websocket;
      websocket.onopen = () => {
        websocket.send(
          JSON.stringify({
            setup: {
              model: `models/${MODEL}`,
              generationConfig: {
                responseModalities: ["AUDIO"],
                mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName } },
                },
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
              tools: functionDeclarations.length ? [{ functionDeclarations }] : [],
              systemInstruction: {
                parts: [
                  {
                    text: sessionInstruction,
                  },
                ],
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          }),
        );
      };
      websocket.onmessage = handleServerMessage;
      websocket.onerror = () => {
        setStatus("error");
        setStatusMessage("The voice channel hit a snag");
      };
      websocket.onclose = (event) => {
        const wasIntentional = mediaRuntimeRef.current!.intentionalClose;
        mediaRuntimeRef.current!.ready = false;
        speakingRef.current = false;
        if (!wasIntentional) {
          stopSession(false);
          const reason = event.reason.replace(/\s+/g, " ").trim();
          const detail = reason
            ? ` (${event.code}): ${reason.slice(0, 150)}`
            : event.code ? ` (code ${event.code})` : "";
          setStatus("error");
          setStatusMessage(`Voice chat ended${detail} — tap to reconnect`);
        }
      };
    } catch (error) {
      stopSession(false);
      setStatus("error");
      setStatusMessage(describeMicrophoneError(error));
    }
  };

  const sendText = (text: string) => {
    const clean = text.trim();
    if (
      !clean
      || status !== "ready"
      || toolRuntimeRef.current!.agentTurnActive
      || toolRuntimeRef.current!.turnCancellationPending
    ) return;
    toolRuntimeRef.current!.turnCancellationSequence += 1;
    if (toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn) markFreshUserInputStarted();
    transcriptRuntimeRef.current!.awaitingNewUserTurn = false;
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    setMessages((current) => [
      ...current,
      { id: `typed-${Date.now()}`, role: "user", text: clean },
    ]);
    updateTurnCancellationPending(false);
    updateAgentTurnActive(true);
    sendJson({ realtimeInput: { text: clean } });
    setInput("");
  };

  const cancelCurrentTurn = () => {
    if (status !== "ready" || !toolRuntimeRef.current!.agentTurnActive) return;
    clearTurnCancellationTimers();
    clearTurnCancellationBoundaryTimer();
    updateTurnCancellationPending(true);
    toolRuntimeRef.current!.suppressServerOutputUntilNextUserTurn = true;
    toolRuntimeRef.current!.cancelledTurnBoundarySeen = false;
    toolRuntimeRef.current!.freshUserInputStarted = false;
    toolRuntimeRef.current!.turnCancellationSequence += 1;
    transcriptRuntimeRef.current!.awaitingNewUserTurn = false;
    const cancelledResponses = resetPendingTurnExecution("Cancelled by the user.");
    if (cancelledResponses.length > 0) {
      sendJson({ toolResponse: { functionResponses: cancelledResponses } });
    }
    sendJson({ realtimeInput: { audioStreamEnd: true } });
    updateAgentTurnActive(false);
    setStatusMessage("Stopping the current action…");
    setTransientMcpAvatarState("listening", 600);
    toolRuntimeRef.current!.turnCancellationWatchdogTimer = window.setTimeout(completeTurnCancellation, 80);
    toolRuntimeRef.current!.turnCancellationBoundaryTimer = window.setTimeout(
      markCancelledTurnBoundarySeen,
      1500,
    );
  };

  const submitText = (event: FormEvent) => {
    event.preventDefault();
    if (toolRuntimeRef.current!.agentTurnActive) cancelCurrentTurn();
    else sendText(input);
  };

  const installMcpServer = async () => {
    if (!mcpUrl.trim() || mcpBusy) return;
    setMcpBusy(true);
    setMcpMessage("Running the MCP handshake and loading tools…");
    try {
      const servers = await toolRuntimeRef.current!.mcpManager.add(mcpUrl);
      setMcpServers(servers);
      setMcpUrl("");
      setMcpMessage("MCP installed · tools apply to the next live session");
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : "Could not install this MCP server.");
    } finally {
      setMcpBusy(false);
    }
  };

  const reconnectMcpServer = async (serverId: string) => {
    if (mcpBusy) return;
    setMcpBusy(true);
    setMcpMessage("Reconnecting MCP server…");
    try {
      setMcpServers(await toolRuntimeRef.current!.mcpManager.reconnect(serverId));
      setMcpMessage("MCP server reconnected");
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : "Could not reconnect this MCP server.");
      await refreshMcpServers(false);
    } finally {
      setMcpBusy(false);
    }
  };

  const removeMcpServer = (serverId: string) => {
    setMcpServers(toolRuntimeRef.current!.mcpManager.remove(serverId));
    setMcpMessage("MCP server removed");
  };

  const setMcpToolPolicy = (serverId: string, toolName: string, mode: McpToolPolicy) => {
    setMcpServers(toolRuntimeRef.current!.mcpManager.setToolPolicy(serverId, toolName, mode));
    setMcpMessage("Tool permission updated");
  };

  const setMcpServerPolicy = (serverId: string, mode: McpToolPolicy) => {
    setMcpServers(toolRuntimeRef.current!.mcpManager.setServerPolicy(serverId, mode));
    setMcpMessage("Server permissions updated");
  };

  const resolveMcpApproval = (allowed: boolean, alwaysAllow = false) => {
    const request = toolRuntimeRef.current!.mcpApproval;
    if (!request) return;
    window.clearTimeout(request.timeoutId);
    if (allowed && alwaysAllow) {
      setMcpServers(toolRuntimeRef.current!.mcpManager.setToolPolicy(
        request.tool.serverId,
        request.tool.toolName,
        "allow",
      ));
    }
    if (allowed) {
      updateToolMessage(
        `mcp-${request.id}`,
        "running",
        alwaysAllow ? "Permission granted and saved. Waiting for the tool result…" : "Permission granted. Running…",
      );
    }
    toolRuntimeRef.current!.mcpApproval = null;
    setMcpApproval(null);
    request.resolve(allowed);
  };

  const connectedMcpCount = mcpServers.filter((server) => server.status === "connected").length;
  const enabledMcpToolCount = mcpServers.reduce(
    (total, server) => total + server.enabledToolCount,
    0,
  );
  const composerCancelMode = status === "ready" && agentTurnActive;
  const composerLocked = status !== "ready" || composerCancelMode || turnCancellationPending;
  const pixelAvatarState: PixelAvatarState = mcpAvatarState
    ?? (status === "connecting"
      ? "connecting"
      : status === "error"
        ? "error"
        : mouthFrame > 0
          ? "speaking"
          : status === "ready"
            ? "listening"
            : "idle");
  const toggleVoicePreview = () => {
    if (voicePreviewPhase === "idle") void previewSelectedVoice();
    else {
      stopVoicePreview();
      setStatusMessage("Voice preview stopped");
    }
  };

  return (
    <main className="app-shell">
      <StudioHeader
        status={status}
        liveTranslationState={liveTranslationState}
        liveTranslationTarget={liveTranslationTarget}
        enabledMcpToolCount={enabledMcpToolCount}
        connectedMcpCount={connectedMcpCount}
        mcpServerCount={mcpServers.length}
        themePreference={themePreference}
        onThemeChange={chooseTheme}
      />

      <section className="experience-grid">
        <StudioSettingsPanel
          petalsEnabled={petalsEnabled}
          status={status}
          micLevel={micLevel}
          voiceName={voiceName}
          selectedVoiceProfile={selectedVoiceProfile}
          voicePreviewPhase={voicePreviewPhase}
          audioInputs={audioInputs}
          selectedDeviceId={selectedDeviceId}
          videoMode={videoMode}
          mcpServers={mcpServers}
          mcpUrl={mcpUrl}
          mcpBusy={mcpBusy}
          mcpMessage={mcpMessage}
          onChooseVoice={chooseVoice}
          onToggleVoicePreview={toggleVoicePreview}
          onSelectedDeviceChange={setSelectedDeviceId}
          onVideoModeChange={setVideoMode}
          onMcpUrlChange={setMcpUrl}
          onMcpConnect={() => void installMcpServer()}
          onMcpReconnect={(serverId) => void reconnectMcpServer(serverId)}
          onMcpRemove={removeMcpServer}
          onMcpToolPolicy={setMcpToolPolicy}
          onMcpServerPolicy={setMcpServerPolicy}
        />

        <StudioStage
          scene={scene}
          outfit={outfit}
          petalsEnabled={petalsEnabled}
          status={status}
          isMuted={isMuted}
          micLevel={micLevel}
          mouthFrame={mouthFrame}
          pixelAvatarState={pixelAvatarState}
          liveTranslationState={liveTranslationState}
          videoElementRef={videoElementRef}
          onSceneChange={setScene}
          onOutfitChange={setOutfit}
          onPetalsChange={choosePetals}
          onToggleMute={toggleMute}
          onStartSession={startSession}
        />

        <StudioConversationPanel
          petalsEnabled={petalsEnabled}
          status={status}
          statusMessage={statusMessage}
          mcpApproval={mcpApproval}
          messages={messages}
          transcriptEndRef={transcriptEndRef}
          input={input}
          composerLocked={composerLocked}
          composerCancelMode={composerCancelMode}
          turnCancellationPending={turnCancellationPending}
          onResolveMcpApproval={resolveMcpApproval}
          onSendText={sendText}
          onInputChange={setInput}
          onSubmit={submitText}
        />
      </section>
    </main>
  );
}
