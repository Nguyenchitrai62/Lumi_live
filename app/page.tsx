"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

const MODEL = "gemini-3.1-flash-live-preview";
const WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

const outfits = {
  casual: [
    "/avatars/casual-closed.png",
    "/avatars/casual-small.png",
    "/avatars/casual-wide.png",
  ],
  moonlit: [
    "/avatars/moonlit-closed.png",
    "/avatars/moonlit-small.png",
    "/avatars/moonlit-wide.png",
  ],
} as const;

const scenes = [
  { id: "bedroom", name: "Cloud room", symbol: "☁" },
  { id: "observatory", name: "Observatory", symbol: "✦" },
  { id: "garden", name: "Moon garden", symbol: "❀" },
] as const;

type Outfit = keyof typeof outfits;
type Scene = (typeof scenes)[number]["id"];
type SessionStatus = "idle" | "connecting" | "ready" | "error";
type ThemePreference = "system" | "light" | "dark";
type Role = "user" | "lumi";
type ChatMessage = { id: string; role: Role; text: string };

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
  const [themePreference, setThemePreference] = useState<ThemePreference>("system");
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
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const playbackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextPlaybackTimeRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const readyRef = useRef(false);
  const mutedRef = useRef(false);
  const speakingRef = useRef(false);
  const lastMicUiUpdateRef = useRef(0);
  const userPartialIdRef = useRef<string | null>(null);
  const lumiPartialIdRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const savedTheme = localStorage.getItem("lumi-theme");
    if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") {
      const timer = window.setTimeout(() => setThemePreference(savedTheme), 0);
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
    return () => {
      intentionalCloseRef.current = true;
      websocketRef.current?.close();
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      audioContextRef.current?.close();
    };
  }, []);

  const updateTranscript = (role: Role, text: string) => {
    if (!text) return;
    const idRef = role === "user" ? userPartialIdRef : lumiPartialIdRef;

    setMessages((current) => {
      if (idRef.current) {
        return current.map((message) => {
          if (message.id !== idRef.current) return message;
          const nextText = text.startsWith(message.text) ? text : `${message.text}${text}`;
          return { ...message, text: nextText };
        });
      }

      const id = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      idRef.current = id;
      return [...current, { id, role, text }];
    });
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

  const toggleMute = () => {
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    setIsMuted(nextMuted);
    if (nextMuted) {
      setMicLevel(0);
      sendJson({ realtimeInput: { audioStreamEnd: true } });
    }
  };

  const setupMicrophone = (context: AudioContext, stream: MediaStream) => {
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = (event) => {
      const mono = event.inputBuffer.getChannelData(0);
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
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    micSourceRef.current = source;
    micProcessorRef.current = processor;
    silentGainRef.current = silentGain;
  };

  const handleServerMessage = async (event: MessageEvent) => {
    const raw = typeof event.data === "string" ? event.data : await event.data.text();
    const response = JSON.parse(raw);

    if (response.setupComplete) {
      readyRef.current = true;
      setStatus("ready");
      setStatusMessage("Lumi is listening");
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
      if (part.text) updateTranscript("lumi", part.text);
    }

    if (serverContent?.inputTranscription?.text) {
      updateTranscript("user", serverContent.inputTranscription.text);
    }
    if (serverContent?.outputTranscription?.text) {
      updateTranscript("lumi", serverContent.outputTranscription.text);
    }
    if (serverContent?.interrupted) stopPlayback();
    if (serverContent?.turnComplete) {
      userPartialIdRef.current = null;
      lumiPartialIdRef.current = null;
    }
  };

  const stopSession = (showIdle = true) => {
    intentionalCloseRef.current = true;
    readyRef.current = false;
    stopPlayback();
    websocketRef.current?.close();
    websocketRef.current = null;
    micProcessorRef.current?.disconnect();
    micSourceRef.current?.disconnect();
    silentGainRef.current?.disconnect();
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

    setStatus("connecting");
    setStatusMessage("Opening a starlight channel…");
    intentionalCloseRef.current = false;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access requires HTTPS or localhost in a supported browser.");
      }

      const context = new AudioContext();
      audioContextRef.current = context;
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.45;
      analyser.connect(context.destination);
      analyserRef.current = analyser;
      nextPlaybackTimeRef.current = context.currentTime;

      const [tokenResponse, stream] = await Promise.all([
        fetch("/api/token", { method: "POST", headers: { "Content-Type": "application/json" } }),
        navigator.mediaDevices.getUserMedia({
          audio: {
            ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
      ]);

      if (!tokenResponse.ok) {
        const data = await tokenResponse.json().catch(() => ({}));
        throw new Error(data.error || "The voice token could not be created.");
      }

      const { token } = await tokenResponse.json();
      micStreamRef.current = stream;
      try {
        const availableDevices = await navigator.mediaDevices.enumerateDevices();
        setAudioInputs(availableDevices.filter((device) => device.kind === "audioinput"));
      } catch {
        // The active stream can still be used if device labels are unavailable.
      }
      setupMicrophone(context, stream);

      const websocket = new WebSocket(`${WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`);
      websocketRef.current = websocket;
      websocket.onopen = () => {
        websocket.send(
          JSON.stringify({
            setup: {
              model: `models/${MODEL}`,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
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
              systemInstruction: {
                parts: [
                  {
                    text: "You are Lumi, a warm, playful anime roleplay companion. Stay in character, use vivid but concise replies, follow the player's chosen scenario, never claim to be human, and keep the conversation friendly and safe. Speak naturally and leave space for the player to respond.",
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
        readyRef.current = false;
        speakingRef.current = false;
        if (!intentionalCloseRef.current) {
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

  const chooseTheme = (theme: ThemePreference) => {
    localStorage.setItem("lumi-theme", theme);
    setThemePreference(theme);
  };

  const currentFrames = outfits[outfit];
  const micBars = Math.min(5, Math.max(0, Math.ceil(micLevel * 5)));
  const micIsHearingVoice = micLevel >= 0.08;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Lumi Live home">
          <span className="brand-mark" aria-hidden="true">✦</span>
          <span>Lumi <strong>Live</strong></span>
        </div>
        <div className="top-actions">
          <div className="theme-switcher" role="group" aria-label="Color theme">
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
                aria-label={`${label} theme`}
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
        <section className={`stage scene-${scene}`} aria-label={`${scenes.find((item) => item.id === scene)?.name} character stage`}>
          <div className="scene-glow" />
          <div className="sparkle sparkle-one">✦</div>
          <div className="sparkle sparkle-two">✧</div>
          <div className="sparkle sparkle-three">·</div>

          <div className="stage-toolbar">
            <span className="stage-kicker">NOW TOGETHER</span>
            <button className="icon-button" type="button" onClick={() => setScene(scene === "bedroom" ? "observatory" : scene === "observatory" ? "garden" : "bedroom")} aria-label="Change background">
              ✦
            </button>
          </div>

          <div className={`avatar avatar-${outfit}`} aria-label={`Lumi wearing the ${outfit} outfit`}>
            {currentFrames.map((src, index) => (
              <img
                key={src}
                className={`avatar-frame ${index === 0 ? "avatar-frame-base" : "avatar-mouth-frame"} ${index > 0 && mouthFrame === index ? "avatar-mouth-frame-active" : ""}`}
                src={src}
                alt={index === 0 ? "Lumi, an anime girl with light blue hair and purple eyes" : ""}
                aria-hidden={index !== 0}
              />
            ))}
          </div>

          <div className="stage-caption">
            <div>
              <span className="name-row">Lumi <span>✦</span></span>
              <span className="mood-row">{status === "ready" ? (isMuted ? "Waiting quietly" : "Listening to you") : "Your starlight companion"}</span>
            </div>
            <div className={`voice-wave ${mouthFrame > 0 ? "voice-wave-active" : ""}`} aria-hidden="true">
              <i /><i /><i /><i /><i />
            </div>
          </div>

          <div className="call-dock">
            {status === "ready" && (
              <button className={`round-control ${isMuted ? "round-control-muted" : ""}`} type="button" onClick={toggleMute} aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}>
                {isMuted ? "×" : "⌁"}
              </button>
            )}
            <button className={`voice-button voice-button-${status}`} type="button" onClick={startSession} disabled={status === "connecting"}>
              <span className={status === "ready" ? "stop-symbol" : "mic-icon"} aria-hidden="true" />
              <span>{status === "ready" ? "End voice chat" : status === "connecting" ? "Connecting microphone…" : "Start microphone"}</span>
            </button>
          </div>
        </section>

        <aside className="side-panel">
          <div className="conversation-head">
            <div>
              <span className="eyebrow">YOUR STORY</span>
              <h1>Talk with Lumi</h1>
            </div>
            <span className={`connection-badge badge-${status}`}>{status === "ready" ? "Live" : status === "connecting" ? "Joining" : status === "error" ? "Retry" : "Offline"}</span>
          </div>

          <div className={`status-note note-${status}`} role="status">
            <span>{status === "error" ? "!" : status === "ready" ? "●" : "✦"}</span>
            <p>{statusMessage}</p>
          </div>

          <div className={`microphone-panel microphone-panel-${status}`}>
            <div className="microphone-main">
              <button
                className="microphone-action"
                type="button"
                onClick={status === "ready" ? toggleMute : startSession}
                disabled={status === "connecting"}
              >
                <span className="microphone-orb" aria-hidden="true"><span className={status === "ready" && isMuted ? "mic-icon mic-icon-muted" : "mic-icon"} /></span>
                <span className="microphone-copy">
                  <strong>
                    {status === "ready"
                      ? isMuted ? "Unmute microphone" : micIsHearingVoice ? "Voice detected" : "Microphone is listening"
                      : status === "connecting" ? "Requesting microphone…" : status === "error" ? "Reconnect microphone" : "Enable microphone"}
                  </strong>
                  {status === "ready" && !isMuted ? (
                    <span className={`mic-signal mic-signal-${micBars}`} aria-label={micIsHearingVoice ? "Microphone is detecting your voice" : "Microphone is waiting for your voice"}>
                      <i /><i /><i /><i /><i />
                      <small>{micIsHearingVoice ? "I can hear you — pause when you finish" : "Speak normally to test the input"}</small>
                    </span>
                  ) : (
                    <small>{status === "ready" ? "Tap here to unmute" : "Your browser will ask for microphone access"}</small>
                  )}
                </span>
              </button>
              {status === "ready" && <button className="microphone-end" type="button" onClick={() => stopSession()}>End</button>}
            </div>
            {audioInputs.length > 0 && (
              <label className="microphone-device" htmlFor="microphone-device">
                <span>INPUT</span>
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
                {status === "ready" && <small>End the call to change input</small>}
              </label>
            )}
          </div>

          <div className="transcript" aria-live="polite">
            {messages.map((message) => (
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

          <div className="customize-panel">
            <div className="customize-group">
              <span className="customize-label">SCENE</span>
              <div className="scene-options">
                {scenes.map((item) => (
                  <button key={item.id} type="button" className={`scene-option scene-chip-${item.id} ${scene === item.id ? "selected" : ""}`} onClick={() => setScene(item.id)} aria-label={item.name} aria-pressed={scene === item.id}>
                    <span>{item.symbol}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="customize-group outfit-group">
              <span className="customize-label">OUTFIT</span>
              <div className="outfit-options">
                <button type="button" className={outfit === "casual" ? "selected" : ""} onClick={() => setOutfit("casual")} aria-pressed={outfit === "casual"}>Cozy</button>
                <button type="button" className={outfit === "moonlit" ? "selected" : ""} onClick={() => setOutfit("moonlit")} aria-pressed={outfit === "moonlit"}>Moonlit</button>
              </div>
            </div>
          </div>

          <p className="privacy-note"><span>◇</span> Your API key stays on the server. Voice streams directly to Gemini using a short-lived token.</p>
        </aside>
      </section>
    </main>
  );
}
