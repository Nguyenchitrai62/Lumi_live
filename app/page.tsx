"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { PixelAvatar } from "./components/PixelAvatar";
import { VtuberAvatar } from "./components/VtuberAvatar";
import { McpSettings } from "./components/McpSettings";
import { PetalLayer } from "./components/PetalLayer";
import type { PixelAvatarState } from "./lib/avatar-catalog";
import {
  formatMcpValue,
  McpManager,
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
  scenes,
  TOOL_ACTIVITY_LABELS,
  videoModes,
  voices,
  WS_ENDPOINT,
  type Scene,
  type VoiceName,
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
  StudioPageAgent,
  STUDIO_PAGE_AGENT_GUIDANCE,
  STUDIO_PAGE_AGENT_TOOL_DECLARATIONS,
  STUDIO_PAGE_AGENT_TOOL_NAMES,
} from "./lib/live/studio-page-agent";
import { playGeminiVoicePreview } from "./lib/live/voice-preview";
import type {
  ChatMessage,
  McpApprovalRequest,
  Outfit,
  Role,
  SessionStatus,
  ThemePreference,
  VideoMode,
  VoicePreviewPhase,
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
  const [scene, setScene] = useState<Scene>("bedroom");
  const [outfit, setOutfit] = useState<Outfit>("casual");
  const [mouthFrame, setMouthFrame] = useState(0);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("Ready when you are");
  const [isMuted, setIsMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [videoMode, setVideoMode] = useState<VideoMode>(DEFAULT_VIDEO_MODE);
  const [themePreference, setThemePreference] = useState<ThemePreference>("system");
  const [voiceName, setVoiceName] = useState<VoiceName>("Zephyr");
  const [voicePreviewPhase, setVoicePreviewPhase] = useState<VoicePreviewPhase | "idle">("idle");
  const [petalsEnabled, setPetalsEnabled] = useState(true);
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

  const websocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micProcessorRef = useRef<AudioWorkletNode | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const sharedAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sharedAudioGainRef = useRef<GainNode | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoFrameTimerRef = useRef<number | null>(null);
  const activeVideoModeRef = useRef<VideoMode>("none");
  const videoNoticeRef = useRef("");
  const playbackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const liveTranslationControllerRef = useRef<LiveTranslationController | null>(null);
  const suppressAgentAudioForTurnRef = useRef(false);
  const nextPlaybackTimeRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const readyRef = useRef(false);
  const mutedRef = useRef(false);
  const speakingRef = useRef(false);
  const lastMicUiUpdateRef = useRef(0);
  const userPartialIdRef = useRef<string | null>(null);
  const lumiPartialIdRef = useRef<string | null>(null);
  const transcriptFinalizeTimersRef = useRef<Record<Role, number | null>>({ user: null, lumi: null });
  const awaitingNewUserTurnRef = useRef(false);
  const transcriptMessageSequenceRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const voicePreviewAbortRef = useRef<AbortController | null>(null);
  const mcpManagerRef = useRef<McpManager | null>(null);
  const mcpAvatarTimerRef = useRef<number | null>(null);
  const mcpApprovalRef = useRef<McpApprovalRequest | null>(null);
  const cancelledToolCallIdsRef = useRef<Set<string>>(new Set());
  const pendingToolCallIdsRef = useRef<Set<string>>(new Set());
  const pendingToolCallNamesRef = useRef<Map<string, string>>(new Map());
  const activeMcpCallControllersRef = useRef<Map<string, AbortController>>(new Map());
  const agentTurnActiveRef = useRef(false);
  const turnCancellationPendingRef = useRef(false);
  const turnCancellationSequenceRef = useRef(0);
  const turnCancellationDrainTimerRef = useRef<number | null>(null);
  const turnCancellationWatchdogTimerRef = useRef<number | null>(null);
  const suppressServerOutputUntilNextUserTurnRef = useRef(false);
  const cancelledTurnBoundarySeenRef = useRef(false);
  const freshUserInputStartedRef = useRef(false);
  const studioPageAgentRef = useRef<StudioPageAgent | null>(null);
  const mcpToolCallSequenceRef = useRef(0);
  if (mcpManagerRef.current == null) mcpManagerRef.current = new McpManager();
  if (studioPageAgentRef.current == null) studioPageAgentRef.current = new StudioPageAgent();

  const updateTurnCancellationPending = (pending: boolean) => {
    turnCancellationPendingRef.current = pending;
    setTurnCancellationPending(pending);
  };

  const updateAgentTurnActive = (active: boolean) => {
    if (
      active
      && (
        turnCancellationPendingRef.current
        || (suppressServerOutputUntilNextUserTurnRef.current && !freshUserInputStartedRef.current)
      )
    ) return;
    const nextActive = readyRef.current && active;
    agentTurnActiveRef.current = nextActive;
    setAgentTurnActive(nextActive);
  };

  const markFreshUserInputStarted = () => {
    freshUserInputStartedRef.current = true;
    if (!cancelledTurnBoundarySeenRef.current) return;
    suppressServerOutputUntilNextUserTurnRef.current = false;
    cancelledTurnBoundarySeenRef.current = false;
    freshUserInputStartedRef.current = false;
  };

  const markCancelledTurnBoundarySeen = () => {
    cancelledTurnBoundarySeenRef.current = true;
    if (!freshUserInputStartedRef.current) return;
    suppressServerOutputUntilNextUserTurnRef.current = false;
    cancelledTurnBoundarySeenRef.current = false;
    freshUserInputStartedRef.current = false;
    updateAgentTurnActive(true);
  };

  const setTransientMcpAvatarState = useCallback((nextState: PixelAvatarState, duration = 0) => {
    if (mcpAvatarTimerRef.current !== null) window.clearTimeout(mcpAvatarTimerRef.current);
    setMcpAvatarState(nextState);
    mcpAvatarTimerRef.current = duration > 0
      ? window.setTimeout(() => {
          mcpAvatarTimerRef.current = null;
          setMcpAvatarState(null);
        }, duration)
      : null;
  }, []);

  const refreshMcpServers = useCallback(async (showBusy = false) => {
    if (showBusy) setMcpBusy(true);
    try {
      const servers = await mcpManagerRef.current!.refreshAll(true);
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
    if (mcpApprovalRef.current) {
      window.clearTimeout(mcpApprovalRef.current.timeoutId);
      mcpApprovalRef.current.resolve(false);
    }
    const timeoutId = window.setTimeout(() => {
      if (mcpApprovalRef.current?.id !== id) return;
      mcpApprovalRef.current = null;
      setMcpApproval(null);
      resolve(false);
    }, 45000);
    const request = { id, tool, args, resolve, timeoutId };
    mcpApprovalRef.current = request;
    setMcpApproval(request);
    setMessages((current) => current.map((message) =>
      message.id === `mcp-${id}` ? { ...message, state: "waiting" } : message));
  }), []);

  useEffect(() => {
    let disposed = false;
    mcpManagerRef.current!.hydrate()
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
    const savedTheme = localStorage.getItem("lumi-theme");
    if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") {
      const timer = window.setTimeout(() => setThemePreference(savedTheme), 0);
      return () => window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const savedVoice = localStorage.getItem("lumi-voice");
    if (voices.some(([name]) => name === savedVoice)) {
      const timer = window.setTimeout(() => setVoiceName(savedVoice as VoiceName), 0);
      return () => window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const savedPetals = localStorage.getItem("lumi-petals");
    if (savedPetals === "off") {
      const timer = window.setTimeout(() => setPetalsEnabled(false), 0);
      return () => window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolvedTheme = themePreference === "system"
        ? media.matches ? "dark" : "light"
        : themePreference;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.dataset.themePreference = themePreference;
    };

    applyTheme();
    if (themePreference === "system") media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themePreference]);

  useEffect(() => {
    mutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;

    const refreshAudioInputs = async () => {
      try {
        const devices = await mediaDevices.enumerateDevices();
        setAudioInputs(devices.filter((device) => device.kind === "audioinput"));
      } catch {
        setAudioInputs([]);
      }
    };

    void refreshAudioInputs();
    mediaDevices.addEventListener("devicechange", refreshAudioInputs);
    return () => mediaDevices.removeEventListener("devicechange", refreshAudioInputs);
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  useEffect(() => {
    let animationId = 0;
    const levels = new Uint8Array(128);
    let smoothedRms = 0;
    let displayedFrame = 0;
    let lastFrameChange = 0;

    const animate = (now: number) => {
      const analyser = analyserRef.current;
      const context = audioContextRef.current;
      const playbackActive = Boolean(
        analyser && context && (
          speakingRef.current || context.currentTime < nextPlaybackTimeRef.current + 0.14
        )
      );

      let targetFrame = displayedFrame;
      if (!playbackActive || !analyser) {
        smoothedRms *= 0.72;
        targetFrame = 0;
      } else {
        analyser.getByteTimeDomainData(levels);
        let energy = 0;
        for (const value of levels) {
          const centered = (value - 128) / 128;
          energy += centered * centered;
        }
        const rms = Math.sqrt(energy / levels.length);
        smoothedRms = smoothedRms * 0.68 + rms * 0.32;

        if (displayedFrame === 0) {
          if (smoothedRms > 0.026) targetFrame = 1;
        } else if (displayedFrame === 1) {
          if (smoothedRms > 0.105) targetFrame = 2;
          else if (smoothedRms < 0.014) targetFrame = 0;
        } else if (smoothedRms < 0.062) {
          targetFrame = 1;
        }
      }

      if (targetFrame !== displayedFrame && now - lastFrameChange >= 90) {
        displayedFrame = targetFrame;
        lastFrameChange = now;
        setMouthFrame(targetFrame);
      }
      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationId);
  }, []);

  useEffect(() => {
    const transcriptTimers = transcriptFinalizeTimersRef.current;
    const activeMcpCallControllers = activeMcpCallControllersRef.current;
    const pendingToolCallIds = pendingToolCallIdsRef.current;
    const pendingToolCallNames = pendingToolCallNamesRef.current;
    return () => {
      intentionalCloseRef.current = true;
      websocketRef.current?.close();
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (videoFrameTimerRef.current !== null) window.clearTimeout(videoFrameTimerRef.current);
      Object.values(transcriptTimers).forEach((timer) => {
        if (timer !== null) window.clearTimeout(timer);
      });
      if (mcpAvatarTimerRef.current !== null) window.clearTimeout(mcpAvatarTimerRef.current);
      if (turnCancellationDrainTimerRef.current !== null) window.clearTimeout(turnCancellationDrainTimerRef.current);
      if (turnCancellationWatchdogTimerRef.current !== null) window.clearTimeout(turnCancellationWatchdogTimerRef.current);
      if (mcpApprovalRef.current) {
        window.clearTimeout(mcpApprovalRef.current.timeoutId);
        mcpApprovalRef.current.resolve(false);
      }
      activeMcpCallControllers.forEach((controller) => controller.abort());
      activeMcpCallControllers.clear();
      pendingToolCallIds.clear();
      pendingToolCallNames.clear();
      mcpApprovalRef.current = null;
      studioPageAgentRef.current?.dispose();
      liveTranslationControllerRef.current?.stop();
      liveTranslationControllerRef.current = null;
      videoStreamRef.current?.getTracks().forEach((track) => track.stop());
      audioContextRef.current?.close();
    };
  }, []);

  const finalizeTranscript = (role: Role) => {
    const idRef = role === "user" ? userPartialIdRef : lumiPartialIdRef;
    const timer = transcriptFinalizeTimersRef.current[role];
    if (timer !== null) window.clearTimeout(timer);
    transcriptFinalizeTimersRef.current[role] = null;
    idRef.current = null;
  };

  const scheduleTranscriptFinalization = (role: Role, delay = 900) => {
    const previousTimer = transcriptFinalizeTimersRef.current[role];
    if (previousTimer !== null) window.clearTimeout(previousTimer);
    transcriptFinalizeTimersRef.current[role] = window.setTimeout(() => {
      finalizeTranscript(role);
    }, delay);
  };

  const updateTranscript = (role: Role, text: string) => {
    if (!text.trim()) return;
    const idRef = role === "user" ? userPartialIdRef : lumiPartialIdRef;
    const pendingTimer = transcriptFinalizeTimersRef.current[role];
    if (pendingTimer !== null) {
      window.clearTimeout(pendingTimer);
      transcriptFinalizeTimersRef.current[role] = null;
    }

    if (!idRef.current) {
      transcriptMessageSequenceRef.current += 1;
      idRef.current = `${role}-transcript-${transcriptMessageSequenceRef.current}`;
    }
    const messageId = idRef.current;
    idRef.current = messageId;

    setMessages((current) => {
      const existing = current.find((message) => message.id === messageId);
      if (!existing) return [...current, { id: messageId, role, text }];
      const mergedText = mergeTranscriptText(existing.text, text);
      if (mergedText === existing.text) return current;
      return current.map((message) => (
        message.id === messageId ? { ...message, text: mergedText } : message
      ));
    });

    if (awaitingNewUserTurnRef.current) scheduleTranscriptFinalization(role);
  };

  const stopPlayback = () => {
    playbackSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    });
    playbackSourcesRef.current.clear();
    nextPlaybackTimeRef.current = audioContextRef.current?.currentTime ?? 0;
    speakingRef.current = false;
    setMouthFrame(0);
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
    playbackSourcesRef.current.add(source);
    speakingRef.current = true;

    source.onended = () => {
      playbackSourcesRef.current.delete(source);
      if (playbackSourcesRef.current.size === 0 && context.currentTime >= nextPlaybackTimeRef.current - 0.05) {
        speakingRef.current = false;
      }
    };
    source.start(startAt);
  };

  const sendJson = (payload: unknown) => {
    const websocket = websocketRef.current;
    if (websocket?.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(payload));
  };

  const stopVideoCapture = () => {
    if (videoFrameTimerRef.current !== null) {
      window.clearTimeout(videoFrameTimerRef.current);
      videoFrameTimerRef.current = null;
    }

    sharedAudioSourceRef.current?.disconnect();
    sharedAudioGainRef.current?.disconnect();
    sharedAudioSourceRef.current = null;
    sharedAudioGainRef.current = null;

    const stream = videoStreamRef.current;
    videoStreamRef.current = null;
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });

    const video = videoElementRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    activeVideoModeRef.current = "none";
  };

  const setSharedAudioVolume = (volume: number) => {
    const gain = sharedAudioGainRef.current?.gain;
    const context = audioContextRef.current;
    if (!gain || !context) return false;
    gain.cancelScheduledValues(context.currentTime);
    gain.setTargetAtTime(Math.min(1, Math.max(0, volume)), context.currentTime, 0.025);
    return true;
  };

  const sendVideoFrame = () => {
    const video = videoElementRef.current;
    if (!readyRef.current || activeVideoModeRef.current === "none" || !video || video.readyState < 2) {
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
    if (videoFrameTimerRef.current !== null) window.clearTimeout(videoFrameTimerRef.current);
    if (activeVideoModeRef.current === "none") return;

    const tick = () => {
      sendVideoFrame();
      if (activeVideoModeRef.current !== "none") {
        videoFrameTimerRef.current = window.setTimeout(tick, 1000);
      }
    };
    videoFrameTimerRef.current = window.setTimeout(tick, 1000);
  };

  const attachVideoStream = async (stream: MediaStream, mode: Exclude<VideoMode, "none">) => {
    const video = videoElementRef.current;
    if (!video) throw new Error("The video preview is not ready.");

    videoStreamRef.current = stream;
    activeVideoModeRef.current = mode;
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
      sharedAudioSourceRef.current = source;
      sharedAudioGainRef.current = gain;
    }

    const track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        if (videoStreamRef.current !== stream) return;
        stopVideoCapture();
        setVideoMode("none");
        if (readyRef.current) {
          setStatusMessage(`${mode === "screen" ? "Screen sharing" : "Camera"} stopped — voice chat is still live`);
        }
      };
    }
  };

  const toggleMute = () => {
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
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
      if (now - lastMicUiUpdateRef.current >= 75) {
        const visibleLevel = mutedRef.current
          ? 0
          : Math.min(1, Math.max(0, (rms - 0.0035) * 16));
        setMicLevel(visibleLevel);
        lastMicUiUpdateRef.current = now;
      }

      if (readyRef.current && !mutedRef.current && awaitingNewUserTurnRef.current && rms >= 0.012) {
        awaitingNewUserTurnRef.current = false;
        if (suppressServerOutputUntilNextUserTurnRef.current) markFreshUserInputStarted();
        suppressAgentAudioForTurnRef.current = false;
        finalizeTranscript("user");
        finalizeTranscript("lumi");
      }

      if (!readyRef.current || mutedRef.current || turnCancellationPendingRef.current) return;
      if (
        suppressServerOutputUntilNextUserTurnRef.current
        && !freshUserInputStartedRef.current
      ) return;
      const websocket = websocketRef.current;
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
    micSourceRef.current = source;
    micProcessorRef.current = processor;
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
    if (turnCancellationDrainTimerRef.current !== null) {
      window.clearTimeout(turnCancellationDrainTimerRef.current);
      turnCancellationDrainTimerRef.current = null;
    }
    if (turnCancellationWatchdogTimerRef.current !== null) {
      window.clearTimeout(turnCancellationWatchdogTimerRef.current);
      turnCancellationWatchdogTimerRef.current = null;
    }
  };

  const resetPendingTurnExecution = (message = "Cancelled by the user.") => {
    void studioPageAgentRef.current?.cancel();
    const cancelledResponses: Array<{
      id: string;
      name: string;
      response: { error: string };
    }> = [];
    for (const callId of pendingToolCallIdsRef.current) {
      cancelledToolCallIdsRef.current.add(callId);
      activeMcpCallControllersRef.current.get(callId)?.abort();
      updateToolMessage(`mcp-${callId}`, "cancelled", message);
      const name = pendingToolCallNamesRef.current.get(callId);
      if (name) {
        cancelledResponses.push({
          id: callId,
          name,
          response: { error: "Cancelled by the user before this tool could finish." },
        });
      }
    }
    activeMcpCallControllersRef.current.forEach((controller) => controller.abort());
    activeMcpCallControllersRef.current.clear();
    pendingToolCallIdsRef.current.clear();
    pendingToolCallNamesRef.current.clear();

    if (mcpApprovalRef.current) {
      const approval = mcpApprovalRef.current;
      window.clearTimeout(approval.timeoutId);
      cancelledToolCallIdsRef.current.add(approval.id);
      mcpApprovalRef.current = null;
      setMcpApproval(null);
      approval.resolve(false);
    }

    if (mcpAvatarTimerRef.current !== null) window.clearTimeout(mcpAvatarTimerRef.current);
    mcpAvatarTimerRef.current = null;
    setMcpAvatarState(null);
    awaitingNewUserTurnRef.current = false;
    stopPlayback();
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    return cancelledResponses;
  };

  const completeTurnCancellation = () => {
    if (!turnCancellationPendingRef.current) return;
    clearTurnCancellationTimers();
    resetPendingTurnExecution();
    updateTurnCancellationPending(false);
    updateAgentTurnActive(false);
    awaitingNewUserTurnRef.current = true;
    setStatusMessage("Current action stopped — waiting silently for your next instruction");
    setTransientMcpAvatarState("listening", 600);
  };

  const scheduleTurnCancellationCompletion = () => {
    if (turnCancellationDrainTimerRef.current !== null) {
      window.clearTimeout(turnCancellationDrainTimerRef.current);
    }
    turnCancellationDrainTimerRef.current = window.setTimeout(completeTurnCancellation, 120);
  };

  const runLiveTranslationTool = async (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const action = String(args.action ?? "").trim().toLowerCase();
    const controller = liveTranslationControllerRef.current;
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
    if (activeVideoModeRef.current !== "screen") {
      throw new Error("Live Translate needs the Screen source. End voice, choose Screen, start again, and select the Chrome tab playing the video.");
    }
    const inputStream = videoStreamRef.current;
    if (!inputStream?.getAudioTracks().length) {
      throw new Error("The shared Chrome tab has no audio track. End voice, reconnect with Screen, and enable Share tab audio in Chrome's picker.");
    }
    if (controller.isActive() && controller.getTargetLanguageCode() === targetLanguageCode) {
      const sourceAudioDucked = setSharedAudioVolume(0.06);
      suppressAgentAudioForTurnRef.current = true;
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
    suppressAgentAudioForTurnRef.current = true;
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
      cancelledToolCallIdsRef.current.add(id);
      activeMcpCallControllersRef.current.get(id)?.abort();
      updateToolMessage(`mcp-${id}`, "cancelled", "Gemini cancelled this tool call because the current turn changed.");
      if (mcpApprovalRef.current?.id === id) {
        window.clearTimeout(mcpApprovalRef.current.timeoutId);
        mcpApprovalRef.current.resolve(false);
        mcpApprovalRef.current = null;
        setMcpApproval(null);
      }
    }

    if (response.setupComplete) {
      clearTurnCancellationTimers();
      suppressServerOutputUntilNextUserTurnRef.current = false;
      cancelledTurnBoundarySeenRef.current = false;
      freshUserInputStartedRef.current = false;
      readyRef.current = true;
      awaitingNewUserTurnRef.current = false;
      updateTurnCancellationPending(false);
      setStatus("ready");
      const activeSource = activeVideoModeRef.current;
      const sourceMessage = activeSource === "screen"
        ? "Lumi is listening and viewing your shared screen"
        : activeSource === "camera"
          ? "Lumi is listening and viewing your camera"
          : videoNoticeRef.current || "Lumi is listening — vision is off";
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
    if (turnCancellationPendingRef.current) {
      if (hasTurnPayload && turnCancellationDrainTimerRef.current !== null) {
        window.clearTimeout(turnCancellationDrainTimerRef.current);
        turnCancellationDrainTimerRef.current = null;
      }
      for (const functionCall of functionCalls) {
        if (typeof functionCall.id === "string") {
          cancelledToolCallIdsRef.current.add(functionCall.id);
          activeMcpCallControllersRef.current.get(functionCall.id)?.abort();
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
    if (suppressServerOutputUntilNextUserTurnRef.current) {
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
          cancelledToolCallIdsRef.current.add(functionCall.id);
        }
      }
      if (cancelledResponses.length > 0) {
        sendJson({ toolResponse: { functionResponses: cancelledResponses } });
      }
      if (
        serverContent?.interrupted
        || serverContent?.turnComplete
        || (freshUserInputStartedRef.current && serverContent?.inputTranscription?.text)
      ) {
        markCancelledTurnBoundarySeen();
        if (suppressServerOutputUntilNextUserTurnRef.current) updateAgentTurnActive(false);
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
      if (part.inlineData?.data && !suppressAgentAudioForTurnRef.current) {
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
      const wasUserCancellation = turnCancellationPendingRef.current;
      updateTurnCancellationPending(false);
      stopPlayback();
      scheduleTranscriptFinalization("lumi");
      updateAgentTurnActive(false);
      if (wasUserCancellation) {
        setStatusMessage("Current action cancelled â€” Lumi is ready for your next request");
      }
    }
    if (serverContent?.turnComplete) {
      const wasUserCancellation = turnCancellationPendingRef.current;
      updateTurnCancellationPending(false);
      awaitingNewUserTurnRef.current = true;
      scheduleTranscriptFinalization("user");
      scheduleTranscriptFinalization("lumi");
      updateAgentTurnActive(false);
      if (wasUserCancellation) {
        setStatusMessage("Current action cancelled â€” Lumi is ready for your next request");
      }
    }

    if (functionCalls.length > 0) {
      const cancellationSequence = turnCancellationSequenceRef.current;
      const functionResponses = [];
      for (const functionCall of functionCalls) {
        if (
          cancellationSequence !== turnCancellationSequenceRef.current
          || turnCancellationPendingRef.current
        ) break;
        mcpToolCallSequenceRef.current += 1;
        const callId = typeof functionCall.id === "string"
          ? functionCall.id
          : `tool-${mcpToolCallSequenceRef.current}`;
        if (cancelledToolCallIdsRef.current.has(callId)) continue;
        pendingToolCallIdsRef.current.add(callId);
        pendingToolCallNamesRef.current.set(callId, functionCall.name);
        const isLiveTranslationTool = functionCall.name === LIVE_TRANSLATE_TOOL_NAME;
        const isStudioPageAgentTool = STUDIO_PAGE_AGENT_TOOL_NAMES.has(functionCall.name);
        const mcpTool = mcpManagerRef.current!.getActiveTool(functionCall.name);
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
          activeMcpCallControllersRef.current.set(callId, mcpCallController);
          const result = isLiveTranslationTool
            ? await runLiveTranslationTool(args, mcpCallController.signal)
            : isStudioPageAgentTool
              ? await studioPageAgentRef.current!.run(functionCall.name, args, mcpCallController.signal)
              : normalizeMcpToolResult(
              await mcpManagerRef.current!.callFunction(functionCall.name, args, {
                signal: mcpCallController.signal,
              }),
            );

          if (
            cancelledToolCallIdsRef.current.has(callId)
            || cancellationSequence !== turnCancellationSequenceRef.current
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
            cancelledToolCallIdsRef.current.has(callId)
            || cancellationSequence !== turnCancellationSequenceRef.current
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
          if (mcpCallController) activeMcpCallControllersRef.current.delete(callId);
          pendingToolCallIdsRef.current.delete(callId);
          pendingToolCallNamesRef.current.delete(callId);
          if (
            cancellationSequence === turnCancellationSequenceRef.current
            && !turnCancellationPendingRef.current
          ) cancelledToolCallIdsRef.current.delete(callId);
        }
      }

      if (
        functionResponses.length
        && cancellationSequence === turnCancellationSequenceRef.current
        && !turnCancellationPendingRef.current
      ) sendJson({ toolResponse: { functionResponses } });
    }
    if (serverContent?.turnComplete && functionCalls.length === 0) {
      suppressAgentAudioForTurnRef.current = false;
    }
  };

  const stopSession = (showIdle = true) => {
    clearTurnCancellationTimers();
    suppressServerOutputUntilNextUserTurnRef.current = false;
    cancelledTurnBoundarySeenRef.current = false;
    freshUserInputStartedRef.current = false;
    suppressAgentAudioForTurnRef.current = false;
    intentionalCloseRef.current = true;
    readyRef.current = false;
    awaitingNewUserTurnRef.current = false;
    updateTurnCancellationPending(false);
    updateAgentTurnActive(false);
    turnCancellationSequenceRef.current += 1;
    for (const callId of pendingToolCallIdsRef.current) {
      cancelledToolCallIdsRef.current.add(callId);
      updateToolMessage(
        `mcp-${callId}`,
        "cancelled",
        "The live session ended before this MCP tool completed.",
      );
    }
    if (mcpApprovalRef.current) {
      window.clearTimeout(mcpApprovalRef.current.timeoutId);
      cancelledToolCallIdsRef.current.add(mcpApprovalRef.current.id);
      updateToolMessage(
        `mcp-${mcpApprovalRef.current.id}`,
        "cancelled",
        "The live session ended before this MCP tool was approved.",
      );
      mcpApprovalRef.current.resolve(false);
    }
    mcpApprovalRef.current = null;
    setMcpApproval(null);
    activeMcpCallControllersRef.current.forEach((controller) => controller.abort());
    activeMcpCallControllersRef.current.clear();
    void studioPageAgentRef.current?.cancel();
    pendingToolCallIdsRef.current.clear();
    pendingToolCallNamesRef.current.clear();
    if (mcpAvatarTimerRef.current !== null) window.clearTimeout(mcpAvatarTimerRef.current);
    mcpAvatarTimerRef.current = null;
    setMcpAvatarState(null);
    cancelledToolCallIdsRef.current.clear();
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    liveTranslationControllerRef.current?.stop();
    liveTranslationControllerRef.current = null;
    setLiveTranslationState("off");
    setLiveTranslationTarget("");
    stopPlayback();
    websocketRef.current?.close();
    websocketRef.current = null;
    stopVideoCapture();
    if (micProcessorRef.current) micProcessorRef.current.port.onmessage = null;
    micProcessorRef.current?.disconnect();
    micSourceRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    mutedRef.current = false;
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
    suppressServerOutputUntilNextUserTurnRef.current = false;
    cancelledTurnBoundarySeenRef.current = false;
    freshUserInputStartedRef.current = false;
    suppressAgentAudioForTurnRef.current = false;
    setStatus("connecting");
    updateTurnCancellationPending(false);
    updateAgentTurnActive(false);
    turnCancellationSequenceRef.current += 1;
    setStatusMessage(requestedVideoMode === "screen"
      ? "Choose the Chrome Tab you want Lumi to see…"
      : requestedVideoMode === "camera"
        ? "Requesting camera and microphone access…"
        : "Opening a voice channel…");
    intentionalCloseRef.current = false;
    videoNoticeRef.current = "";

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
          micStreamRef.current = mediaStream;
          return mediaStream;
        }),
        requestVideoStream(requestedVideoMode)
          .then((mediaStream) => {
            videoStreamRef.current = mediaStream;
            return { stream: mediaStream, error: null as unknown };
          })
          .catch((error: unknown) => ({ stream: null, error })),
        refreshMcpServers(false),
      ]);

      if (videoResult.error) {
        videoNoticeRef.current = describeVideoError(videoResult.error, requestedVideoMode);
        setVideoMode("none");
      } else if (videoResult.stream && requestedVideoMode !== "none") {
        try {
          await attachVideoStream(videoResult.stream, requestedVideoMode);
        } catch (error) {
          stopVideoCapture();
          videoNoticeRef.current = describeVideoError(error, requestedVideoMode);
          setVideoMode("none");
        }
      }
      try {
        const availableDevices = await navigator.mediaDevices.enumerateDevices();
        setAudioInputs(availableDevices.filter((device) => device.kind === "audioinput"));
      } catch {
        // The active stream can still be used if device labels are unavailable.
      }
      await setupMicrophone(context, stream);
      liveTranslationControllerRef.current = new LiveTranslationController({
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
        ...mcpManagerRef.current!.buildFunctionDeclarations(activeMcpServers),
      ];
      const sessionInstruction = [
        BASE_SYSTEM_INSTRUCTION,
        LIVE_TRANSLATION_GUIDANCE,
        STUDIO_PAGE_AGENT_GUIDANCE,
        mcpManagerRef.current!.buildSessionGuidance(activeMcpServers),
      ].filter(Boolean).join("\n\n");
      const websocket = new WebSocket(websocketUrl);
      websocketRef.current = websocket;
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
        const wasIntentional = intentionalCloseRef.current;
        readyRef.current = false;
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
      || agentTurnActiveRef.current
      || turnCancellationPendingRef.current
    ) return;
    turnCancellationSequenceRef.current += 1;
    if (suppressServerOutputUntilNextUserTurnRef.current) markFreshUserInputStarted();
    awaitingNewUserTurnRef.current = false;
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
    if (status !== "ready" || !agentTurnActiveRef.current) return;
    clearTurnCancellationTimers();
    updateTurnCancellationPending(true);
    suppressServerOutputUntilNextUserTurnRef.current = true;
    cancelledTurnBoundarySeenRef.current = false;
    freshUserInputStartedRef.current = false;
    turnCancellationSequenceRef.current += 1;
    awaitingNewUserTurnRef.current = false;
    const cancelledResponses = resetPendingTurnExecution("Cancelled by the user.");
    if (cancelledResponses.length > 0) {
      sendJson({ toolResponse: { functionResponses: cancelledResponses } });
    }
    sendJson({ realtimeInput: { audioStreamEnd: true } });
    updateAgentTurnActive(false);
    setStatusMessage("Stopping the current action…");
    setTransientMcpAvatarState("listening", 600);
    turnCancellationWatchdogTimerRef.current = window.setTimeout(completeTurnCancellation, 80);
  };

  const submitText = (event: FormEvent) => {
    event.preventDefault();
    if (agentTurnActiveRef.current) cancelCurrentTurn();
    else sendText(input);
  };

  const installMcpServer = async () => {
    if (!mcpUrl.trim() || mcpBusy) return;
    setMcpBusy(true);
    setMcpMessage("Running the MCP handshake and loading tools…");
    try {
      const servers = await mcpManagerRef.current!.add(mcpUrl);
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
      setMcpServers(await mcpManagerRef.current!.reconnect(serverId));
      setMcpMessage("MCP server reconnected");
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : "Could not reconnect this MCP server.");
      await refreshMcpServers(false);
    } finally {
      setMcpBusy(false);
    }
  };

  const removeMcpServer = (serverId: string) => {
    setMcpServers(mcpManagerRef.current!.remove(serverId));
    setMcpMessage("MCP server removed");
  };

  const setMcpToolPolicy = (serverId: string, toolName: string, mode: McpToolPolicy) => {
    setMcpServers(mcpManagerRef.current!.setToolPolicy(serverId, toolName, mode));
    setMcpMessage("Tool permission updated");
  };

  const setMcpServerPolicy = (serverId: string, mode: McpToolPolicy) => {
    setMcpServers(mcpManagerRef.current!.setServerPolicy(serverId, mode));
    setMcpMessage("Server permissions updated");
  };

  const resolveMcpApproval = (allowed: boolean, alwaysAllow = false) => {
    const request = mcpApprovalRef.current;
    if (!request) return;
    window.clearTimeout(request.timeoutId);
    if (allowed && alwaysAllow) {
      setMcpServers(mcpManagerRef.current!.setToolPolicy(
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
    mcpApprovalRef.current = null;
    setMcpApproval(null);
    request.resolve(allowed);
  };

  const chooseTheme = (theme: ThemePreference) => {
    localStorage.setItem("lumi-theme", theme);
    setThemePreference(theme);
  };

  const choosePetals = (enabled: boolean) => {
    localStorage.setItem("lumi-petals", enabled ? "on" : "off");
    setPetalsEnabled(enabled);
  };

  const stopVoicePreview = () => {
    const activePreview = voicePreviewAbortRef.current;
    if (!activePreview) return;
    voicePreviewAbortRef.current = null;
    activePreview.abort();
    setVoicePreviewPhase("idle");
  };

  const chooseVoice = (voice: VoiceName) => {
    stopVoicePreview();
    localStorage.setItem("lumi-voice", voice);
    setVoiceName(voice);
    const profile = voices.find(([name]) => name === voice) ?? voices[0];
    setStatusMessage(`${voice} selected · ${profile[1]} · ${profile[2]}`);
  };

  const previewSelectedVoice = async () => {
    if (voicePreviewPhase !== "idle" || status === "ready" || status === "connecting") return;
    const previewController = new AbortController();
    voicePreviewAbortRef.current = previewController;
    setVoicePreviewPhase("connecting");
    setStatusMessage(`Preparing a short ${voiceName} preview…`);
    try {
      await playGeminiVoicePreview(voiceName, setVoicePreviewPhase, previewController.signal);
      setStatusMessage(`${voiceName} preview finished — start a new session when this voice feels right`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setStatusMessage(error instanceof Error ? error.message : "Could not play the voice preview");
      }
    } finally {
      if (voicePreviewAbortRef.current === previewController) {
        voicePreviewAbortRef.current = null;
        setVoicePreviewPhase("idle");
      }
    }
  };

  const selectedVoiceProfile = voices.find(([name]) => name === voiceName) ?? voices[0];

  useEffect(() => () => {
    voicePreviewAbortRef.current?.abort();
  }, []);

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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Lumi Live home">
          <span className="brand-mark" aria-hidden="true">✦</span>
          <span>Lumi <strong>Live</strong></span>
        </div>
        <div className="header-status">
          {liveTranslationState !== "off" && (
            <div
              className={`mcp-pill translate-pill translate-${liveTranslationState}`}
              title="Gemini Live Translate is playing the translated video audio"
            >
              <span className={liveTranslationState === "active" ? "connected" : ""} aria-hidden="true" />
              Translate {liveTranslationTarget || "…"}
            </div>
          )}
          <div className="mcp-pill" title={`${enabledMcpToolCount} MCP tools available`}>
            <span className={connectedMcpCount ? "connected" : ""} aria-hidden="true" />
            MCP {connectedMcpCount}/{mcpServers.length}
          </div>
          <div className="theme-switcher topbar-theme-switcher" role="group" aria-label="Color theme">
            {([
              ["system", "◐", "System"],
              ["light", "☀", "Light"],
              ["dark", "☾", "Dark"],
            ] as const).map(([theme, icon, label]) => (
              <button
                key={theme}
                type="button"
                className={themePreference === theme ? "selected" : ""}
                onClick={() => chooseTheme(theme)}
                aria-pressed={themePreference === theme}
                title={label}
              >
                <span className="theme-icon" aria-hidden="true">{icon}</span>
                <span className="theme-label">{label}</span>
              </button>
            ))}
          </div>
          <div className="model-pill">
            <span className={`status-dot status-${status}`} />
            <span className="model-label">Gemini 3.1 Flash Live</span>
            <span className="model-short">Live model</span>
          </div>
        </div>
      </header>

      <section className="experience-grid">
        <aside className={`settings-panel ${petalsEnabled ? "petals-enabled" : "petals-disabled"}`} aria-label="Lumi settings">
          <PetalLayer className="settings-petal-field" enabled={petalsEnabled} />
          <div className="settings-panel-scroll">
          <div className="settings-panel-head">
            <div>
              <span className="eyebrow">WEB STUDIO</span>
              <h1>Settings</h1>
            </div>
            <span className={`connection-badge badge-${status}`}>
              {status === "ready" ? "Live" : status === "connecting" ? "Joining" : status === "error" ? "Retry" : "Ready"}
            </span>
          </div>

          <section className="settings-section" aria-labelledby="live-input-title">
            <div className="settings-section-head">
              <div>
                <span className="eyebrow">LIVE INPUT</span>
                <h2 id="live-input-title">Voice & vision</h2>
              </div>
              <i className={`settings-live-dot ${micLevel >= 0.08 ? "hearing" : ""}`} aria-hidden="true" />
            </div>

            <label className="settings-field" htmlFor="lumi-voice">
              <span>
                <strong>Voice</strong>
                <small>{selectedVoiceProfile[1]} · {selectedVoiceProfile[2]}</small>
              </span>
              <select
                id="lumi-voice"
                value={voiceName}
                onChange={(event) => chooseVoice(event.target.value as VoiceName)}
                disabled={status === "ready" || status === "connecting"}
              >
                {voices.map(([name, gender, style]) => (
                  <option key={name} value={name}>{name} · {gender} · {style}</option>
                ))}
              </select>
            </label>
            <button
              className={`settings-preview-button voice-preview-${voicePreviewPhase}`}
              type="button"
              onClick={() => {
                if (voicePreviewPhase === "idle") void previewSelectedVoice();
                else {
                  stopVoicePreview();
                  setStatusMessage("Voice preview stopped");
                }
              }}
              disabled={status === "ready" || status === "connecting"}
            >
              <span aria-hidden="true">{voicePreviewPhase === "idle" ? "▶" : "■"}</span>
              {voicePreviewPhase === "idle" ? "Preview selected voice" : "Stop preview"}
            </button>

            <label className="settings-field" htmlFor="microphone-device">
              <span>
                <strong>Microphone</strong>
                <small>{micLevel >= 0.08 ? "Hearing you" : "Input device"}</small>
              </span>
              <select
                id="microphone-device"
                value={selectedDeviceId}
                onChange={(event) => setSelectedDeviceId(event.target.value)}
                disabled={status === "ready" || status === "connecting"}
              >
                <option value="">System default</option>
                {audioInputs.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>

            <div className="settings-choice">
              <span>
                <strong>Vision source</strong>
                <small>Screen also enables video-audio translation</small>
              </span>
              <div className="segmented-control" role="group" aria-label="Vision source">
                {videoModes.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className={videoMode === mode.id ? "selected" : ""}
                    onClick={() => setVideoMode(mode.id)}
                    disabled={status === "ready" || status === "connecting"}
                    aria-pressed={videoMode === mode.id}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <McpSettings
            servers={mcpServers}
            url={mcpUrl}
            busy={mcpBusy}
            message={mcpMessage}
            onUrlChange={setMcpUrl}
            onConnect={() => void installMcpServer()}
            onReconnect={(serverId) => void reconnectMcpServer(serverId)}
            onRemove={removeMcpServer}
            onToolPolicy={setMcpToolPolicy}
            onServerPolicy={setMcpServerPolicy}
          />

          </div>
        </aside>

        <section className={`stage scene-${scene} ${petalsEnabled ? "petals-enabled" : "petals-disabled"}`} aria-label={`${scenes.find((item) => item.id === scene)?.name} character stage`}>
          <div className="scene-glow" />
          <div className="scene-motion" aria-hidden="true">
            <span className="scene-haze" />
            <span className="ambient-mote ambient-mote-one" />
            <span className="ambient-mote ambient-mote-two" />
            <span className="ambient-mote ambient-mote-three" />
            <span className="ambient-mote ambient-mote-four" />
          </div>
          <PetalLayer className="stage-petal-field" enabled={petalsEnabled} />
          <video ref={videoElementRef} className="capture-video" autoPlay muted playsInline aria-hidden="true" />
          <div className="stage-toolbar">
            <span className="stage-kicker">NOW TOGETHER</span>
            <div className="stage-customize" aria-label="Character appearance controls">
              <div>
                <span className="customize-label">SCENE</span>
                <div className="scene-options">
                  {scenes.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`scene-option scene-chip-${item.id} ${scene === item.id ? "selected" : ""}`}
                      onClick={() => setScene(item.id)}
                      aria-label={item.name}
                      aria-pressed={scene === item.id}
                      title={item.name}
                    >
                      <span>{item.symbol}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="customize-label">OUTFIT</span>
                <div className="outfit-options">
                  <button type="button" className={outfit === "casual" ? "selected" : ""} onClick={() => setOutfit("casual")} aria-pressed={outfit === "casual"}>Cozy</button>
                  <button type="button" className={outfit === "moonlit" ? "selected" : ""} onClick={() => setOutfit("moonlit")} aria-pressed={outfit === "moonlit"}>Moonlit</button>
                </div>
              </div>
              <button
                className="petal-toggle stage-petal-toggle"
                type="button"
                aria-label={petalsEnabled ? "Turn petals off" : "Turn petals on"}
                aria-pressed={petalsEnabled}
                onClick={() => choosePetals(!petalsEnabled)}
                title="Petals"
              >
                <span className="petal-toggle-icon" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className={`avatar avatar-${outfit}`} aria-label={`Lumi wearing the ${outfit} outfit`}>
            <VtuberAvatar outfit={outfit} mouthFrame={mouthFrame} />
          </div>

          <div className="stage-caption">
            <div>
              <span className="name-row">Lumi <span>✦</span></span>
              <span className="mood-row">{status === "ready" ? (isMuted ? "Waiting quietly" : "Listening to you") : "Your starlight companion"}</span>
            </div>
            <div className={`voice-wave ${mouthFrame > 0 ? "voice-wave-active" : ""}`} aria-hidden="true">
              <i /><i /><i /><i /><i />
            </div>
            <PixelAvatar state={pixelAvatarState} />
          </div>

          <div className="call-dock">
            {status === "ready" && (
              <button className={`round-control ${isMuted ? "round-control-muted" : ""}`} type="button" onClick={toggleMute} aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}>
                {isMuted ? "×" : "⌁"}
              </button>
            )}
            <button className={`voice-button voice-button-${status}`} type="button" onClick={startSession} disabled={status === "connecting"}>
              <span className={status === "ready" ? "stop-symbol" : "mic-icon"} aria-hidden="true" />
              <span>{status === "ready"
                ? liveTranslationState === "active" || liveTranslationState === "connecting" || liveTranslationState === "reconnecting"
                  ? "End live chat + translate"
                  : "End live chat"
                : status === "connecting" ? "Connecting live chat…" : "Start live chat"}</span>
            </button>
          </div>
        </section>

        <aside className={`conversation-panel ${petalsEnabled ? "petals-enabled" : "petals-disabled"}`}>
          <PetalLayer className="conversation-petal-field" enabled={petalsEnabled} />
          <div className="conversation-head">
            <div>
              <span className="eyebrow">HISTORY</span>
              <h1>Conversation</h1>
            </div>
            <span className={`connection-badge badge-${status}`}>
              {status === "ready" ? "Live" : status === "connecting" ? "Joining" : status === "error" ? "Retry" : "Offline"}
            </span>
          </div>

          <div className={`status-note note-${status}`} role="status">
            <span>{status === "error" ? "!" : status === "ready" ? "●" : "✦"}</span>
            <p>{statusMessage}</p>
          </div>

          {mcpApproval && (
            <section className="mcp-tool-notice" role="alert" aria-labelledby="mcp-tool-notice-title">
              <span className="mcp-tool-notice-icon" aria-hidden="true">!</span>
              <div className="mcp-tool-notice-copy">
                <strong id="mcp-tool-notice-title">Allow MCP tool: {mcpApproval.tool.toolName}?</strong>
                <p>{mcpApproval.tool.serverName} wants to run this tool with:</p>
                <code>{formatMcpValue(mcpApproval.args, 260)}</code>
              </div>
              <div className="mcp-tool-notice-actions">
                <button type="button" className="mcp-tool-notice-secondary" onClick={() => resolveMcpApproval(false)}>Deny</button>
                <button type="button" className="mcp-tool-notice-tertiary" onClick={() => resolveMcpApproval(true, true)}>Always allow</button>
                <button type="button" className="mcp-tool-notice-primary" onClick={() => resolveMcpApproval(true)}>Allow once</button>
              </div>
            </section>
          )}

          <div className="transcript" aria-live="polite">
            {messages.map((message) => message.role === "tool" ? (
              <details key={message.id} className="mcp-activity" data-state={message.state}>
                <summary>
                  <span className="mcp-activity-icon" aria-hidden="true" />
                  <span>
                    <small>{message.activityLabel || "MCP TOOL"}</small>
                    <strong>{message.title}</strong>
                  </span>
                  <span className="mcp-activity-status" role="status">
                    {message.state ? TOOL_ACTIVITY_LABELS[message.state] : "Running"}
                  </span>
                  <span className="mcp-activity-chevron" aria-hidden="true" />
                </summary>
                <div className="mcp-activity-body">
                  <dl className="mcp-activity-meta">
                    <div><dt>Server</dt><dd>{message.serverName || "MCP server"}</dd></div>
                    <div><dt>Started</dt><dd>{message.startedLabel || "—"}</dd></div>
                    <div><dt>Duration</dt><dd>{message.durationLabel || (message.state === "waiting" ? "Waiting" : "Running")}</dd></div>
                  </dl>
                  <section>
                    <span>Arguments</span>
                    <pre>{message.args || "No arguments."}</pre>
                  </section>
                  {message.state && !["running", "waiting"].includes(message.state) && (
                    <section>
                      <span>{message.state === "failed" ? "Error" : message.state === "cancelled" ? "Cancellation" : "Result"}</span>
                      <pre>{message.text}</pre>
                    </section>
                  )}
                </div>
              </details>
            ) : (
              <div key={message.id} className={`message message-${message.role}`}>
                <span className="message-author">{message.role === "lumi" ? "Lumi" : "You"}</span>
                <p>{message.text}</p>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>

          <div className="quick-prompts" aria-label="Roleplay starters">
            {["Set a moonlit café scene", "Tell me a tiny secret", "Let’s go on an adventure"].map((prompt) => (
              <button key={prompt} type="button" onClick={() => sendText(prompt)} disabled={composerLocked}>{prompt}</button>
            ))}
          </div>

          <form className="message-form" onSubmit={submitText}>
            <label className="sr-only" htmlFor="message-input">Message Lumi</label>
            <input
              id="message-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={status !== "ready"
                ? "Start voice chat to message…"
                : turnCancellationPending ? "Cancelling current action…"
                  : composerCancelMode ? "Lumi is working…" : "Or type a message…"}
              disabled={composerLocked}
            />
            <button
              type="submit"
              data-mode={composerCancelMode ? "cancel" : "send"}
              disabled={status !== "ready" || turnCancellationPending || (!composerCancelMode && !input.trim())}
              aria-label={composerCancelMode ? "Cancel current action" : "Send message"}
              title={composerCancelMode ? "Cancel current action" : "Send message"}
            >
              <span className="message-send-icon" aria-hidden="true">↑</span>
              <span className="message-cancel-icon" aria-hidden="true" />
            </button>
          </form>
        </aside>
      </section>
    </main>
  );
}
