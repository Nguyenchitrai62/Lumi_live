const MODEL = "gemini-3.1-flash-live-preview";
const DIRECT_WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const VOICE_PROFILES = [
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
];

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer);
}

export function createVoicePreviewController({
  apiKeyInput,
  voiceInput,
  previewButton,
  statusElement,
}) {
  let activePreview = null;

  function updateVoiceProfiles() {
    for (const option of voiceInput.options) {
      const optionProfile = VOICE_PROFILES.find(([name]) => name === option.value);
      if (optionProfile) {
        option.textContent = `${optionProfile[0]} · ${optionProfile[1]} · ${optionProfile[2]}`;
      }
    }
  }

  function stop(message = "Voice preview stopped.") {
    const preview = activePreview;
    if (!preview) return false;
    activePreview = null;
    preview.cancelled = true;
    preview.finish?.(new DOMException("Voice preview stopped.", "AbortError"));
    for (const source of preview.sources) {
      try { source.stop(); } catch { /* Source may already be stopped. */ }
    }
    preview.sources.clear();
    preview.websocket?.close();
    void preview.audioContext.close().catch(() => {});
    previewButton.dataset.state = "";
    previewButton.textContent = "▶ Test voice";
    statusElement.dataset.state = "";
    statusElement.textContent = message;
    return true;
  }

  async function toggle() {
    if (stop()) return;

    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      statusElement.dataset.state = "error";
      statusElement.textContent = "Enter a Gemini API key to test this voice.";
      apiKeyInput.focus();
      return;
    }

    const voiceName = voiceInput.value || "Zephyr";
    const audioContext = new AudioContext();
    const preview = {
      audioContext,
      websocket: null,
      sources: new Set(),
      finish: null,
      cancelled: false,
    };
    activePreview = preview;
    await audioContext.resume();
    if (preview.cancelled) return;

    let nextPlaybackTime = audioContext.currentTime;
    let receivedAudio = false;
    let turnComplete = false;

    previewButton.dataset.state = "playing";
    previewButton.textContent = "■ Stop preview";
    statusElement.dataset.state = "";
    statusElement.textContent = `Preparing a short English ${voiceName} preview…`;

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = setTimeout(() => finish(new Error("Voice preview timed out. Try again.")), 18000);
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          if (error) reject(error);
          else resolve();
        };
        preview.finish = finish;

        const websocket = new WebSocket(`${DIRECT_WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`);
        preview.websocket = websocket;
        websocket.onopen = () => {
          websocket.send(JSON.stringify({
            setup: {
              model: `models/${MODEL}`,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
              },
              systemInstruction: {
                parts: [{ text: "You are a voice preview. Read the requested English sentence naturally and do not add any other words." }],
              },
            },
          }));
        };

        websocket.onmessage = async (event) => {
          if (preview.cancelled) return;
          const raw = typeof event.data === "string" ? event.data : await event.data.text();
          const response = JSON.parse(raw);
          if (response.setupComplete) {
            websocket.send(JSON.stringify({
              realtimeInput: { text: "Have a wonderful day!" },
            }));
          }

          const parts = response.serverContent?.modelTurn?.parts ?? [];
          for (const part of parts) {
            if (!part.inlineData?.data || preview.cancelled) continue;
            receivedAudio = true;
            const pcm = base64ToInt16(part.inlineData.data);
            const floats = new Float32Array(pcm.length);
            for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index] / 32768;
            const buffer = audioContext.createBuffer(1, floats.length, 24000);
            buffer.copyToChannel(floats, 0);
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);
            preview.sources.add(source);
            source.addEventListener("ended", () => preview.sources.delete(source), { once: true });
            const startAt = Math.max(audioContext.currentTime + 0.025, nextPlaybackTime);
            nextPlaybackTime = startAt + buffer.duration;
            source.start(startAt);
          }

          if (response.serverContent?.turnComplete) {
            turnComplete = true;
            websocket.close(1000, "Preview complete");
            const remainingMs = Math.max(0, (nextPlaybackTime - audioContext.currentTime) * 1000);
            setTimeout(
              () => finish(receivedAudio ? null : new Error("Gemini returned no preview audio.")),
              remainingMs + 80,
            );
          }
        };
        websocket.onerror = () => finish(new Error("Could not connect to Gemini Live. Check the API key."));
        websocket.onclose = () => {
          if (!turnComplete && !preview.cancelled) {
            finish(new Error("Gemini Live ended before the preview was ready."));
          }
        };
      });
      if (!preview.cancelled) {
        statusElement.dataset.state = "saved";
        statusElement.textContent = `${voiceName} preview finished. Save when this voice feels right.`;
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        statusElement.dataset.state = "error";
        statusElement.textContent = error instanceof Error
          ? error.message
          : "Could not play the voice preview.";
      }
    } finally {
      if (activePreview === preview) {
        activePreview = null;
        for (const source of preview.sources) {
          try { source.stop(); } catch { /* Source may already be stopped. */ }
        }
        preview.websocket?.close();
        await audioContext.close().catch(() => {});
        previewButton.dataset.state = "";
        previewButton.textContent = "▶ Test voice";
      }
    }
  }

  return {
    stop,
    toggle,
    updateVoiceProfiles,
  };
}
