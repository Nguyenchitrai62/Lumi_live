"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { PixelAvatar } from "./components/PixelAvatar";
import { VtuberAvatar } from "./components/VtuberAvatar";
import { McpSettings } from "./components/McpSettings";
import type { PixelAvatarState } from "./lib/avatar-catalog";
import {
  formatMcpValue,
  McpManager,
  normalizeMcpToolResult,
  type ActiveMcpTool,
  type McpServerView,
  type McpToolPolicy,
} from "./lib/mcp";

const MODEL = "gemini-3.1-flash-live-preview";
const WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const DIRECT_WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const EXTENSION_API_KEY_STORAGE_KEY = "lumi-gemini-api-key";
const MIC_CAPTURE_PROCESSOR = "lumi-pcm-capture";

const BASE_SYSTEM_INSTRUCTION = `You are Lumi, a warm, playful anime roleplay companion. Stay in character, use vivid but concise replies, follow the player's chosen scenario, never claim to be human, and keep the conversation friendly and safe. Speak naturally and leave space for the player to respond. When current visual frames are provided, use them to answer questions about the user's shared screen or camera. Never pretend to see anything when vision is off or a current frame is unavailable.`;

const scenes = [
  { id: "bedroom", name: "Cloud room", symbol: "☁" },
  { id: "observatory", name: "Observatory", symbol: "✦" },
  { id: "garden", name: "Moon garden", symbol: "❀" },
] as const;

const voices = [
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
] as const;

type Outfit = "casual" | "moonlit";
type Scene = (typeof scenes)[number]["id"];
type SessionStatus = "idle" | "connecting" | "ready" | "error";
type ThemePreference = "system" | "light" | "dark";
type VoiceName = (typeof voices)[number][0];
type VideoMode = "screen" | "camera" | "none";
type Role = "user" | "lumi";
type ChatMessage = {
  id: string;
  role: Role | "tool";
  text: string;
  title?: string;
  serverName?: string;
  args?: string;
  startedAt?: number;
  startedLabel?: string;
  durationLabel?: string;
  state?: "running" | "waiting" | "completed" | "failed" | "cancelled";
};
type McpApprovalRequest = {
  id: string;
  tool: ActiveMcpTool;
  args: Record<string, unknown>;
  resolve: (allowed: boolean) => void;
  timeoutId: number;
};

const DEFAULT_VIDEO_MODE: VideoMode = "screen";
const videoModes: ReadonlyArray<{ id: VideoMode; label: string }> = [
  { id: "screen", label: "Screen" },
  { id: "camera", label: "Camera" },
  { id: "none", label: "None" },
];

const TOOL_ACTIVITY_LABELS = {
  running: "Running",
  waiting: "Awaiting approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
} as const;

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

function PetalLayer({ className = "", enabled }: { className?: string; enabled: boolean }) {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;

    layer.replaceChildren();
    if (!enabled) return;

    layer.classList.remove("petal-field-entering");
    void layer.offsetWidth;
    layer.classList.add("petal-field-entering");

    const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
    let spawnTimer: number | null = null;

    const spawnPetal = (initialProgress = 0) => {
      if (layer.childElementCount >= 28) return;

      const petal = document.createElement("i");
      const direction = Math.random() > .5 ? 1 : -1;
      const width = randomBetween(6, 11);
      const opacity = randomBetween(.34, .68);
      const fallDistance = Math.max(layer.clientHeight, 320) + 36;
      const duration = randomBetween(16, 26);

      petal.style.left = `${randomBetween(1, 97).toFixed(2)}%`;
      petal.style.width = `${width.toFixed(1)}px`;
      petal.style.height = `${(width * randomBetween(.58, .76)).toFixed(1)}px`;
      petal.style.setProperty("--petal-fall-a", `${(fallDistance * .32).toFixed(1)}px`);
      petal.style.setProperty("--petal-fall-b", `${(fallDistance * .67).toFixed(1)}px`);
      petal.style.setProperty("--petal-fall-c", `${fallDistance.toFixed(1)}px`);
      petal.style.setProperty("--petal-drift-a", `${(direction * randomBetween(12, 48)).toFixed(1)}px`);
      petal.style.setProperty("--petal-drift-b", `${(-direction * randomBetween(8, 42)).toFixed(1)}px`);
      petal.style.setProperty("--petal-drift-c", `${(direction * randomBetween(22, 68)).toFixed(1)}px`);
      petal.style.setProperty("--petal-turn-a", `${(direction * randomBetween(65, 145)).toFixed(0)}deg`);
      petal.style.setProperty("--petal-turn-b", `${(direction * randomBetween(170, 285)).toFixed(0)}deg`);
      petal.style.setProperty("--petal-turn-c", `${(direction * randomBetween(300, 520)).toFixed(0)}deg`);
      petal.style.setProperty("--petal-opacity", opacity.toFixed(2));
      petal.style.setProperty("--petal-fade-opacity", (opacity * .36).toFixed(2));
      petal.style.setProperty("--petal-scale", randomBetween(.72, 1.18).toFixed(2));
      petal.style.animationDuration = `${duration.toFixed(2)}s`;
      if (initialProgress > 0) {
        petal.style.animationDelay = `${-(duration * initialProgress).toFixed(2)}s`;
      }
      petal.addEventListener("animationend", () => petal.remove(), { once: true });
      layer.append(petal);
    };

    const scheduleNext = () => {
      spawnTimer = window.setTimeout(() => {
        spawnPetal();
        scheduleNext();
      }, randomBetween(420, 1100));
    };

    for (let index = 0; index < 16; index += 1) {
      spawnPetal(randomBetween(.08, .88));
    }
    scheduleNext();

    return () => {
      if (spawnTimer !== null) window.clearTimeout(spawnTimer);
      layer.classList.remove("petal-field-entering");
      layer.replaceChildren();
    };
  }, [enabled]);

  return <div ref={layerRef} className={`web-petal-field ${className}`} aria-hidden="true" />;
}

async function requestVideoStream(mode: VideoMode) {
  if (mode === "none") return Promise.resolve<MediaStream | null>(null);

  if (mode === "screen") {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return Promise.reject(new Error("Screen sharing is not supported by this browser."));
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 1, max: 1 },
        displaySurface: "browser",
      },
      audio: false,
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "exclude",
    } as DisplayMediaStreamOptions);
    const displaySurface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
    if (displaySurface && displaySurface !== "browser") {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Choose a Chrome Tab so Lumi can see and control the same page.");
    }
    return stream;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error("Camera access is not supported by this browser."));
  }
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 5, max: 10 },
      facingMode: "user",
    },
    audio: false,
  });
}

type LiveAuth =
  | { kind: "apiKey"; credential: string }
  | { kind: "ephemeral"; credential: string };

async function getLiveAuth(): Promise<LiveAuth> {
  if (window.location.protocol === "chrome-extension:") {
    const apiKey = localStorage.getItem(EXTENSION_API_KEY_STORAGE_KEY)?.trim();
    if (!apiKey) {
      throw new Error("Open Lumi Live settings and save a Gemini API key first.");
    }
    return { kind: "apiKey", credential: apiKey };
  }

  const response = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "The voice token could not be created.");
  }
  const { token } = await response.json();
  if (!token) throw new Error("The voice token response was empty.");
  return { kind: "ephemeral", credential: token };
}

function describeVideoError(error: unknown, mode: VideoMode) {
  const source = mode === "screen" ? "Screen sharing" : "Camera access";
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return `${source} was skipped; voice chat is still available.`;
  }
  if (error instanceof Error && error.message) {
    return `${source} failed: ${error.message}`;
  }
  return `${source} could not be started; voice chat is still available.`;
}

function describeMicrophoneError(error: unknown) {
  if (!(error instanceof DOMException)) {
    return error instanceof Error ? error.message : "Couldn’t start voice chat";
  }

  if (error.name === "NotAllowedError") {
    return "Microphone access is blocked for this site. Allow it from the lock icon, then reconnect.";
  }
  if (error.name === "NotFoundError") {
    return "No microphone was found. Connect one, then reconnect.";
  }
  if (error.name === "NotReadableError") {
    return "The microphone is busy or unavailable. Close another app using it, then reconnect.";
  }
  if (error.name === "OverconstrainedError") {
    return "The selected microphone is no longer available. Choose System default, then reconnect.";
  }
  return error.message || "Couldn’t start voice chat";
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToInt16(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

type VoicePreviewPhase = "connecting" | "playing";

async function playGeminiVoicePreview(
  voiceName: VoiceName,
  onPhase: (phase: VoicePreviewPhase) => void,
  signal: AbortSignal,
) {
  const audioContext = new AudioContext();
  const socketHolder = { current: null as WebSocket | null };
  const playbackSources = new Set<AudioBufferSourceNode>();
  const stopPlayback = () => {
    for (const source of playbackSources) {
      try { source.stop(); } catch { /* Source may already be stopped. */ }
    }
    playbackSources.clear();
  };

  try {
    if (signal.aborted) throw new DOMException("Voice preview stopped.", "AbortError");
    await audioContext.resume();
    const liveAuth = await getLiveAuth();
    if (signal.aborted) throw new DOMException("Voice preview stopped.", "AbortError");
    const websocketUrl = liveAuth.kind === "apiKey"
      ? `${DIRECT_WS_ENDPOINT}?key=${encodeURIComponent(liveAuth.credential)}`
      : `${WS_ENDPOINT}?access_token=${encodeURIComponent(liveAuth.credential)}`;
    let nextPlaybackTime = audioContext.currentTime;
    let receivedAudio = false;
    let turnComplete = false;

    onPhase("connecting");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        finish(new Error("Voice preview timed out. Please try again."));
      }, 18000);

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        signal.removeEventListener("abort", abortPreview);
        if (error) reject(error);
        else resolve();
      };

      const abortPreview = () => {
        stopPlayback();
        socketHolder.current?.close();
        finish(new DOMException("Voice preview stopped.", "AbortError"));
      };
      signal.addEventListener("abort", abortPreview, { once: true });

      const websocket = new WebSocket(websocketUrl);
      socketHolder.current = websocket;
      websocket.onopen = () => {
        websocket.send(JSON.stringify({
          setup: {
            model: `models/${MODEL}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName } },
              },
            },
            systemInstruction: {
              parts: [{
                text: "You are a voice preview. Read the requested English sentence naturally and do not add any other words.",
              }],
            },
          },
        }));
      };

      websocket.onmessage = async (event) => {
        try {
          const raw = typeof event.data === "string" ? event.data : await event.data.text();
          const response = JSON.parse(raw);
          if (response.setupComplete) {
            websocket.send(JSON.stringify({
              realtimeInput: {
                text: "Have a wonderful day!",
              },
            }));
          }

          const parts = response.serverContent?.modelTurn?.parts ?? [];
          for (const part of parts) {
            if (!part.inlineData?.data) continue;
            receivedAudio = true;
            onPhase("playing");
            const pcm = base64ToInt16(part.inlineData.data);
            const floats = new Float32Array(pcm.length);
            for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index] / 32768;
            const buffer = audioContext.createBuffer(1, floats.length, 24000);
            buffer.copyToChannel(floats, 0);
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);
            playbackSources.add(source);
            source.addEventListener("ended", () => playbackSources.delete(source), { once: true });
            const startAt = Math.max(audioContext.currentTime + 0.025, nextPlaybackTime);
            nextPlaybackTime = startAt + buffer.duration;
            source.start(startAt);
          }

          if (response.serverContent?.turnComplete) {
            turnComplete = true;
            websocket.close(1000, "Preview complete");
            const remainingMs = Math.max(0, (nextPlaybackTime - audioContext.currentTime) * 1000);
            window.setTimeout(() => {
              finish(receivedAudio ? undefined : new Error("Gemini returned no preview audio."));
            }, remainingMs + 80);
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Could not read the voice preview."));
        }
      };
      websocket.onerror = () => finish(new Error("Could not connect to Gemini Live for the preview."));
      websocket.onclose = () => {
        if (!turnComplete) finish(new Error("Gemini Live ended before the preview was ready."));
      };
    });
  } finally {
    stopPlayback();
    const websocket = socketHolder.current;
    if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) {
      websocket.close();
    }
    await audioContext.close().catch(() => {});
  }
}

function resampleTo16k(input: Float32Array, inputRate: number) {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const result = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));

  for (let i = 0; i < result.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let total = 0;
    for (let j = start; j < end; j += 1) total += input[j];
    result[i] = total / Math.max(1, end - start);
  }

  return result;
}

function floatToPcm16(floatData: Float32Array) {
  const pcm = new Int16Array(floatData.length);
  for (let i = 0; i < floatData.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, floatData[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

function mergeTranscriptText(current: string, incoming: string) {
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming) || current.endsWith(incoming)) return current;

  const maxOverlap = Math.min(current.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.endsWith(incoming.slice(0, overlap))) {
      return `${current}${incoming.slice(overlap)}`;
    }
  }

  const needsSpace = !/\s$/.test(current) && !/^[\s.,!?;:'")\]}]/.test(incoming);
  return `${current}${needsSpace ? " " : ""}${incoming}`;
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
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoFrameTimerRef = useRef<number | null>(null);
  const activeVideoModeRef = useRef<VideoMode>("none");
  const videoNoticeRef = useRef("");
  const playbackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
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
  const mcpToolCallSequenceRef = useRef(0);
  if (mcpManagerRef.current == null) mcpManagerRef.current = new McpManager();

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
    return () => {
      intentionalCloseRef.current = true;
      websocketRef.current?.close();
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (videoFrameTimerRef.current !== null) window.clearTimeout(videoFrameTimerRef.current);
      Object.values(transcriptTimers).forEach((timer) => {
        if (timer !== null) window.clearTimeout(timer);
      });
      if (mcpAvatarTimerRef.current !== null) window.clearTimeout(mcpAvatarTimerRef.current);
      if (mcpApprovalRef.current) {
        window.clearTimeout(mcpApprovalRef.current.timeoutId);
        mcpApprovalRef.current.resolve(false);
      }
      mcpApprovalRef.current = null;
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
        finalizeTranscript("user");
        finalizeTranscript("lumi");
      }

      if (!readyRef.current || mutedRef.current) return;
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

  const handleServerMessage = async (event: MessageEvent) => {
    const raw = typeof event.data === "string" ? event.data : await event.data.text();
    const response = JSON.parse(raw);

    for (const id of response.toolCallCancellation?.ids ?? []) {
      if (typeof id !== "string") continue;
      cancelledToolCallIdsRef.current.add(id);
      updateToolMessage(`mcp-${id}`, "cancelled", "Gemini cancelled this tool call because the current turn changed.");
      if (mcpApprovalRef.current?.id === id) {
        window.clearTimeout(mcpApprovalRef.current.timeoutId);
        mcpApprovalRef.current.resolve(false);
        mcpApprovalRef.current = null;
        setMcpApproval(null);
      }
    }

    if (response.setupComplete) {
      readyRef.current = true;
      awaitingNewUserTurnRef.current = false;
      setStatus("ready");
      const activeSource = activeVideoModeRef.current;
      const sourceMessage = activeSource === "screen"
        ? "Lumi is listening and viewing your shared screen"
        : activeSource === "camera"
          ? "Lumi is listening and viewing your camera"
          : videoNoticeRef.current || "Lumi is listening — vision is off";
      setStatusMessage(sourceMessage);
      startVideoFrames();
      sendJson({
        realtimeInput: {
          text: "Greet the player warmly in one short sentence and invite them to begin our roleplay.",
        },
      });
    }

    const serverContent = response.serverContent;
    const parts = serverContent?.modelTurn?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) playPcmChunk(part.inlineData.data);
    }

    if (serverContent?.inputTranscription?.text) {
      updateTranscript("user", serverContent.inputTranscription.text);
    }
    if (serverContent?.outputTranscription?.text) {
      updateTranscript("lumi", serverContent.outputTranscription.text);
    }
    if (serverContent?.interrupted) {
      stopPlayback();
      scheduleTranscriptFinalization("lumi");
    }
    if (serverContent?.turnComplete) {
      awaitingNewUserTurnRef.current = true;
      scheduleTranscriptFinalization("user");
      scheduleTranscriptFinalization("lumi");
    }

    const functionCalls = response.toolCall?.functionCalls ?? [];
    if (functionCalls.length > 0) {
      const functionResponses = [];
      for (const functionCall of functionCalls) {
        mcpToolCallSequenceRef.current += 1;
        const callId = typeof functionCall.id === "string"
          ? functionCall.id
          : `tool-${mcpToolCallSequenceRef.current}`;
        if (cancelledToolCallIdsRef.current.has(callId)) continue;
        const mcpTool = mcpManagerRef.current!.getActiveTool(functionCall.name);
        const activityId = `mcp-${callId}`;
        try {
          if (!mcpTool) {
            throw new Error(`Unsupported tool: ${functionCall.name}`);
          }
          const args = functionCall.args && typeof functionCall.args === "object"
            ? functionCall.args as Record<string, unknown>
            : {};

          if (mcpTool) {
            setTransientMcpAvatarState("tool_call");
            setMessages((current) => [
              ...current,
              {
                id: activityId,
                role: "tool",
                title: mcpTool.toolName,
                serverName: mcpTool.serverName,
                args: formatMcpValue(args, 24000),
                text: "No result yet.",
                state: "running",
                ...createMcpActivityTiming(),
              },
            ]);
            if (mcpTool.permission === "ask") {
              const allowed = await requestMcpPermission(mcpTool, args, callId);
              if (!allowed) throw new Error("MCP tool permission was denied or timed out.");
            }
          }

          const result = normalizeMcpToolResult(
            await mcpManagerRef.current!.callFunction(functionCall.name, args),
          );

          if (cancelledToolCallIdsRef.current.has(callId)) {
            if (mcpTool) {
              updateToolMessage(activityId, "cancelled", "The MCP result arrived after this turn was cancelled.");
            }
            continue;
          }
          if (mcpTool) {
            updateToolMessage(activityId, "completed", formatMcpValue(result, 24000));
            setTransientMcpAvatarState("success", 1760);
          }
          functionResponses.push({
            id: callId,
            name: functionCall.name,
            response: { result },
          });
        } catch (error) {
          if (cancelledToolCallIdsRef.current.has(callId)) continue;
          if (mcpTool) {
            const message = error instanceof Error ? error.message : "The MCP tool failed.";
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
          cancelledToolCallIdsRef.current.delete(callId);
        }
      }

      if (functionResponses.length) sendJson({ toolResponse: { functionResponses } });
    }
  };

  const stopSession = (showIdle = true) => {
    intentionalCloseRef.current = true;
    readyRef.current = false;
    awaitingNewUserTurnRef.current = false;
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
    if (mcpAvatarTimerRef.current !== null) window.clearTimeout(mcpAvatarTimerRef.current);
    mcpAvatarTimerRef.current = null;
    setMcpAvatarState(null);
    cancelledToolCallIdsRef.current.clear();
    finalizeTranscript("user");
    finalizeTranscript("lumi");
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
    setStatus("connecting");
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

      const context = new AudioContext();
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

      const websocketUrl = liveAuth.kind === "apiKey"
        ? `${DIRECT_WS_ENDPOINT}?key=${encodeURIComponent(liveAuth.credential)}`
        : `${WS_ENDPOINT}?access_token=${encodeURIComponent(liveAuth.credential)}`;
      const functionDeclarations =
        mcpManagerRef.current!.buildFunctionDeclarations(activeMcpServers);
      const sessionInstruction = [
        BASE_SYSTEM_INSTRUCTION,
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
    if (!clean || status !== "ready") return;
    awaitingNewUserTurnRef.current = false;
    finalizeTranscript("user");
    finalizeTranscript("lumi");
    setMessages((current) => [
      ...current,
      { id: `typed-${Date.now()}`, role: "user", text: clean },
    ]);
    sendJson({ realtimeInput: { text: clean } });
    setInput("");
  };

  const submitText = (event: FormEvent) => {
    event.preventDefault();
    sendText(input);
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
        <aside className="settings-panel" aria-label="Lumi settings">
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
                <small>Optional · one frame/second</small>
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
              <span>{status === "ready" ? "End live chat" : status === "connecting" ? "Connecting live chat…" : "Start live chat"}</span>
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
                    <small>MCP TOOL</small>
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
              <button key={prompt} type="button" onClick={() => sendText(prompt)} disabled={status !== "ready"}>{prompt}</button>
            ))}
          </div>

          <form className="message-form" onSubmit={submitText}>
            <label className="sr-only" htmlFor="message-input">Message Lumi</label>
            <input id="message-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={status === "ready" ? "Or type a message…" : "Start voice chat to message…"} disabled={status !== "ready"} />
            <button type="submit" disabled={status !== "ready" || !input.trim()} aria-label="Send message">↑</button>
          </form>
        </aside>
      </section>
    </main>
  );
}
