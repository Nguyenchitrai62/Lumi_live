import { base64ToInt16 } from "./audio";
import { DIRECT_WS_ENDPOINT, MODEL, WS_ENDPOINT } from "./config";
import { getLiveAuth } from "./media";
import type { VoiceName } from "./config";
import type { VoicePreviewPhase } from "./types";

export async function playGeminiVoicePreview(
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
            for (let index = 0; index < pcm.length; index += 1) {
              floats[index] = pcm[index] / 32768;
            }
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
    if (websocket && (
      websocket.readyState === WebSocket.OPEN
      || websocket.readyState === WebSocket.CONNECTING
    )) {
      websocket.close();
    }
    await audioContext.close().catch(() => {});
  }
}
