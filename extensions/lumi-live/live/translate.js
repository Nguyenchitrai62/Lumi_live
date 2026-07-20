import {
  base64ToInt16,
  bytesToBase64,
  canSendLiveAudio,
  floatToPcm16,
  getLiveTranslationChunkStartTime,
  resampleTo16k,
} from "./audio-utils.js";

export const LIVE_TRANSLATION_MODEL = "gemini-3.5-live-translate-preview";
export const LIVE_TRANSLATE_TOOL_NAME = "live_translate";

export const SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES = [
  "af", "ak", "sq", "am", "ar", "hy", "az", "eu", "be", "bn", "bg", "my", "ca",
  "zh-Hans", "zh-Hant", "hr", "cs", "da", "nl", "en", "et", "fil", "fi", "fr",
  "gl", "ka", "de", "el", "gu", "ha", "he", "hi", "hu", "is", "id", "it", "ja",
  "jv", "kn", "kk", "km", "rw", "ko", "lo", "lv", "lt", "mk", "ms", "ml", "mr",
  "mn", "ne", "no", "nb", "fa", "pl", "pt-BR", "pt-PT", "pa", "ro", "ru", "sr",
  "sd", "si", "sk", "sl", "es", "su", "sw", "sv", "ta", "te", "th", "tr", "uk",
  "ur", "uz", "vi", "zu",
];

export const LIVE_TRANSLATE_TOOL = {
  name: LIVE_TRANSLATE_TOOL_NAME,
  description: "Start, stop, or inspect live speech-to-speech translation for the audio of the video currently playing in the active Chrome tab. Use this tool for requests such as translate, interpret, or dub the current video. Do not use it for translating typed text or a static page. The target language must come from the user's request or an explicitly established conversation preference. The tool itself plays the translated voice; never imitate or repeat the translation with the assistant voice.",
  parameters: {
    type: "OBJECT",
    properties: {
      action: {
        type: "STRING",
        enum: ["start", "stop", "status"],
        description: "start begins or changes live translation, stop ends it, and status reports the current state.",
      },
      targetLanguageCode: {
        type: "STRING",
        enum: SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES,
        description: "Required for start. The requested target language as one of the supported BCP-47 codes. Never silently default this field to any language.",
      },
    },
    required: ["action"],
  },
};

export const LIVE_TRANSLATION_GUIDANCE = `When the user asks to translate, interpret, or dub speech from the video that is currently playing, call ${LIVE_TRANSLATE_TOOL_NAME}. For action=start, determine targetLanguageCode from the language requested in the current instruction or from an explicit preference already established in the conversation. Never assume a default target language based on the UI language, locale, examples, or earlier unrelated requests. If no target language is known, ask the user which language they want and do not start the tool yet. Use action=stop when the user asks to stop live translation. Do not call this tool for ordinary text translation. The tool owns translated audio playback, so after a successful start do not speak, imitate, summarize, or repeat the translated dialogue with your assistant voice.`;

const supportedLanguageCodeLookup = new Map(
  SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES.map((code) => [code.toLowerCase(), code]),
);

export function normalizeLiveTranslationLanguageCode(value) {
  const candidate = String(value ?? "").trim().replace(/_/g, "-");
  const normalized = candidate.toLowerCase();
  return supportedLanguageCodeLookup.get(normalized)
    || supportedLanguageCodeLookup.get(normalized.split("-")[0])
    || null;
}

export function getLiveTranslationLanguageLabel(code) {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

export function buildLiveTranslationSetup(targetLanguageCode) {
  return {
    setup: {
      model: `models/${LIVE_TRANSLATION_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode,
          echoTargetLanguage: false,
        },
      },
    },
  };
}

export class LiveTranslationController {
  constructor({ audioContext, createSocketUrl, onStateChange, onError }) {
    this.audioContext = audioContext;
    this.createSocketUrl = createSocketUrl;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.websocket = null;
    this.inputStream = null;
    this.inputSource = null;
    this.inputProcessor = null;
    this.sourceMonitor = null;
    this.sourceMonitorGain = null;
    this.restoreSourcePlayback = null;
    this.ownsInputStream = false;
    this.desired = false;
    this.generation = 0;
    this.reconnectTimer = null;
    this.outputSources = new Set();
    this.nextOutputTime = audioContext.currentTime;
    this.targetLanguageCode = "";
    this.handleInputEnded = () => {
      if (!this.desired) return;
      this.stop();
      this.onError?.(new Error("The video audio source ended, so live translation stopped."));
    };
  }

  getTargetLanguageCode() {
    return this.targetLanguageCode;
  }

  isActive() {
    return this.desired;
  }

  async start({
    inputStream,
    targetLanguageCode,
    ownsInputStream = false,
    sourcePlaybackVolume,
    sourceAudioIsSuppressed = false,
  }) {
    this.stop();
    const audioTrack = inputStream.getAudioTracks()[0];
    if (!audioTrack || audioTrack.readyState === "ended") {
      throw new Error("The active tab is not sharing audio.");
    }
    this.desired = true;
    this.targetLanguageCode = targetLanguageCode;
    this.inputStream = inputStream;
    this.ownsInputStream = ownsInputStream;
    this.generation += 1;
    const generation = this.generation;
    audioTrack.addEventListener("ended", this.handleInputEnded, { once: true });
    try {
      this.onStateChange?.("connecting", targetLanguageCode);
      await this.connect(generation);
      if (!this.desired || this.generation !== generation) {
        throw new DOMException("Live translation was cancelled.", "AbortError");
      }
      await this.startSourceMonitor({
        inputStream,
        sourcePlaybackVolume,
        sourceAudioIsSuppressed,
      }, generation);
      if (!this.desired || this.generation !== generation) {
        throw new DOMException("Live translation was cancelled.", "AbortError");
      }
      this.attachInput(inputStream, generation);
      this.onStateChange?.("active", targetLanguageCode);
    } catch (error) {
      if (this.generation === generation) this.stop();
      throw error;
    }
  }

  async startExternal({ targetLanguageCode }) {
    this.stop();
    this.desired = true;
    this.targetLanguageCode = targetLanguageCode;
    this.generation += 1;
    const generation = this.generation;
    try {
      this.onStateChange?.("connecting", targetLanguageCode);
      await this.connect(generation);
      if (!this.desired || this.generation !== generation) {
        throw new DOMException("Live translation was cancelled.", "AbortError");
      }
      this.onStateChange?.("active", targetLanguageCode);
    } catch (error) {
      if (this.generation === generation) this.stop();
      throw error;
    }
  }

  sendExternalAudio(base64Pcm16) {
    const websocket = this.websocket;
    if (!this.desired || websocket?.readyState !== WebSocket.OPEN) return false;
    if (!canSendLiveAudio(websocket.bufferedAmount)) return false;
    websocket.send(JSON.stringify({
      realtimeInput: {
        audio: {
          data: base64Pcm16,
          mimeType: "audio/pcm;rate=16000",
        },
      },
    }));
    return true;
  }

  stop() {
    this.desired = false;
    this.generation += 1;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const websocket = this.websocket;
    this.websocket = null;
    if (websocket && websocket.readyState < WebSocket.CLOSING) {
      websocket.close(1000, "Live translation stopped");
    }
    this.inputProcessor?.disconnect();
    this.inputSource?.disconnect();
    this.inputProcessor = null;
    this.inputSource = null;
    this.stopSourceMonitor();
    const audioTrack = this.inputStream?.getAudioTracks()[0];
    audioTrack?.removeEventListener("ended", this.handleInputEnded);
    if (this.ownsInputStream) this.inputStream?.getTracks().forEach((track) => track.stop());
    this.inputStream = null;
    this.ownsInputStream = false;
    this.stopOutput();
    this.targetLanguageCode = "";
    this.onStateChange?.("off");
  }

  async startSourceMonitor({ inputStream, sourcePlaybackVolume, sourceAudioIsSuppressed }, generation) {
    if (!Number.isFinite(sourcePlaybackVolume)) return;
    const audioTrack = inputStream.getAudioTracks()[0];
    if (!audioTrack) return;

    let suppressed = sourceAudioIsSuppressed === true;
    let restoreSourcePlayback = null;
    const supported = navigator.mediaDevices?.getSupportedConstraints?.();
    if (!suppressed && supported?.suppressLocalAudioPlayback === true) {
      const previousConstraints = audioTrack.getConstraints();
      try {
        await audioTrack.applyConstraints({
          ...previousConstraints,
          suppressLocalAudioPlayback: true,
        });
        suppressed = true;
        if (previousConstraints.suppressLocalAudioPlayback !== true) {
          restoreSourcePlayback = () => {
            if (audioTrack.readyState === "ended") return;
            void audioTrack.applyConstraints({
              ...audioTrack.getConstraints(),
              suppressLocalAudioPlayback: false,
            }).catch(() => {});
          };
        }
      } catch {
        // Translation can continue even if this Chrome build cannot duck picker audio.
      }
    }

    if (!this.desired || this.generation !== generation) {
      restoreSourcePlayback?.();
      return;
    }
    if (!suppressed) return;

    const source = this.audioContext.createMediaStreamSource(inputStream);
    const gain = this.audioContext.createGain();
    gain.gain.value = Math.min(1, Math.max(0, sourcePlaybackVolume));
    source.connect(gain);
    gain.connect(this.audioContext.destination);
    this.sourceMonitor = source;
    this.sourceMonitorGain = gain;
    this.restoreSourcePlayback = restoreSourcePlayback;
  }

  stopSourceMonitor() {
    this.sourceMonitor?.disconnect();
    this.sourceMonitorGain?.disconnect();
    this.sourceMonitor = null;
    this.sourceMonitorGain = null;
    const restoreSourcePlayback = this.restoreSourcePlayback;
    this.restoreSourcePlayback = null;
    restoreSourcePlayback?.();
  }

  attachInput(stream, generation) {
    const source = this.audioContext.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(this.audioContext, "lumi-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    processor.port.onmessage = (event) => {
      if (!this.desired || this.generation !== generation) return;
      const websocket = this.websocket;
      if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
      if (!canSendLiveAudio(websocket.bufferedAmount)) return;
      const pcm = floatToPcm16(resampleTo16k(event.data, this.audioContext.sampleRate));
      websocket.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: bytesToBase64(pcm),
            mimeType: "audio/pcm;rate=16000",
          },
        },
      }));
    };
    source.connect(processor);
    this.inputSource = source;
    this.inputProcessor = processor;
  }

  async connect(generation) {
    const socketUrl = await this.createSocketUrl(this.targetLanguageCode);
    if (!this.desired || this.generation !== generation) {
      throw new DOMException("Live translation was cancelled.", "AbortError");
    }
    await new Promise((resolve, reject) => {
      const websocket = new WebSocket(socketUrl);
      this.websocket = websocket;
      let setupComplete = false;
      const setupTimeout = setTimeout(() => {
        if (setupComplete || this.websocket !== websocket) return;
        websocket.close(4000, "Live translation setup timed out");
        reject(new Error("Gemini Live Translate did not finish setup within 15 seconds."));
      }, 15000);
      websocket.onopen = () => {
        if (this.websocket === websocket) {
          websocket.send(JSON.stringify(buildLiveTranslationSetup(this.targetLanguageCode)));
        }
      };
      websocket.onmessage = async (event) => {
        if (this.websocket !== websocket) return;
        try {
          const raw = typeof event.data === "string" ? event.data : await event.data.text();
          const response = JSON.parse(raw);
          if (response.error?.message) throw new Error(response.error.message);
          if (response.setupComplete && !setupComplete) {
            setupComplete = true;
            clearTimeout(setupTimeout);
            resolve();
          }
          const content = response.serverContent;
          for (const part of content?.modelTurn?.parts || []) {
            if (part.inlineData?.data) this.playOutput(part.inlineData.data);
          }
          if (content?.interrupted) this.stopOutput();
        } catch (error) {
          if (!setupComplete) reject(error);
          this.reportError(error);
        }
      };
      websocket.onerror = () => {
        if (!setupComplete) reject(new Error("Could not connect to Gemini Live Translate."));
      };
      websocket.onclose = (event) => {
        clearTimeout(setupTimeout);
        if (!setupComplete) {
          reject(new Error(event.reason || "Gemini Live Translate closed during setup."));
          return;
        }
        if (!this.desired || this.generation !== generation || this.websocket !== websocket) return;
        this.websocket = null;
        this.scheduleReconnect(generation, event.reason);
      };
    });
  }

  scheduleReconnect(generation, reason) {
    if (!this.desired || this.generation !== generation) return;
    this.onStateChange?.("reconnecting", reason || this.targetLanguageCode);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(generation)
        .then(() => {
          if (this.desired && this.generation === generation) {
            this.onStateChange?.("active", this.targetLanguageCode);
          }
        })
        .catch((error) => this.reportError(error));
    }, 1200);
  }

  reportError(error) {
    const normalized = error instanceof Error ? error : new Error("Live translation failed.");
    this.stop();
    this.onStateChange?.("error", normalized.message);
    this.onError?.(normalized);
  }

  playOutput(base64) {
    const pcm = base64ToInt16(base64);
    const currentTime = this.audioContext.currentTime;
    const floats = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index] / 32768;
    const buffer = this.audioContext.createBuffer(1, floats.length, 24000);
    buffer.copyToChannel(floats, 0);
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    const startAt = getLiveTranslationChunkStartTime(currentTime, this.nextOutputTime);
    this.nextOutputTime = startAt + buffer.duration;
    this.outputSources.add(source);
    source.onended = () => this.outputSources.delete(source);
    source.start(startAt);
  }

  stopOutput() {
    for (const source of this.outputSources) {
      try { source.stop(); } catch { /* Already stopped. */ }
    }
    this.outputSources.clear();
    this.nextOutputTime = this.audioContext.currentTime;
  }
}
