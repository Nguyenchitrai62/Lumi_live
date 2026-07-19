import {
  base64ToInt16,
  bytesToBase64,
  canSendLiveAudio,
  floatToPcm16,
  getLiveTranslationChunkStartTime,
  resampleTo16k,
} from "./audio";
import { buildLiveTranslationSetup } from "./translation-config";

export type LiveTranslationState = "off" | "connecting" | "active" | "reconnecting" | "error";

type LiveTranslationControllerOptions = {
  audioContext: AudioContext;
  createSocketUrl: (targetLanguageCode: string, signal?: AbortSignal) => Promise<string>;
  onStateChange?: (state: LiveTranslationState, detail?: string) => void;
  onInputTranscript?: (text: string) => void;
  onOutputTranscript?: (text: string) => void;
  onError?: (error: Error) => void;
};

type StartLiveTranslationOptions = {
  inputStream: MediaStream;
  targetLanguageCode: string;
  ownsInputStream?: boolean;
  sourcePlaybackVolume?: number;
  sourceAudioIsSuppressed?: boolean;
  signal?: AbortSignal;
};

type ChromeAudioTrackConstraints = MediaTrackConstraints & {
  suppressLocalAudioPlayback?: boolean;
};

type ChromeAudioTrackSupportedConstraints = MediaTrackSupportedConstraints & {
  suppressLocalAudioPlayback?: boolean;
};

export class LiveTranslationController {
  private readonly audioContext: AudioContext;
  private readonly createSocketUrl: LiveTranslationControllerOptions["createSocketUrl"];
  private readonly onStateChange?: LiveTranslationControllerOptions["onStateChange"];
  private readonly onInputTranscript?: LiveTranslationControllerOptions["onInputTranscript"];
  private readonly onOutputTranscript?: LiveTranslationControllerOptions["onOutputTranscript"];
  private readonly onError?: LiveTranslationControllerOptions["onError"];
  private websocket: WebSocket | null = null;
  private inputStream: MediaStream | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputProcessor: AudioWorkletNode | null = null;
  private sourceMonitor: MediaStreamAudioSourceNode | null = null;
  private sourceMonitorGain: GainNode | null = null;
  private restoreSourcePlayback: (() => void) | null = null;
  private ownsInputStream = false;
  private desired = false;
  private generation = 0;
  private reconnectTimer: number | null = null;
  private outputSources = new Set<AudioBufferSourceNode>();
  private nextOutputTime = 0;
  private targetLanguageCode = "";

  constructor(options: LiveTranslationControllerOptions) {
    this.audioContext = options.audioContext;
    this.createSocketUrl = options.createSocketUrl;
    this.onStateChange = options.onStateChange;
    this.onInputTranscript = options.onInputTranscript;
    this.onOutputTranscript = options.onOutputTranscript;
    this.onError = options.onError;
    this.nextOutputTime = this.audioContext.currentTime;
  }

  getTargetLanguageCode() {
    return this.targetLanguageCode;
  }

  isActive() {
    return this.desired;
  }

  async start(options: StartLiveTranslationOptions) {
    this.stop();
    const audioTrack = options.inputStream.getAudioTracks()[0];
    if (!audioTrack || audioTrack.readyState === "ended") {
      throw new Error("The selected video source is not sharing audio.");
    }

    this.desired = true;
    this.targetLanguageCode = options.targetLanguageCode;
    this.inputStream = options.inputStream;
    this.ownsInputStream = options.ownsInputStream === true;
    this.generation += 1;
    const generation = this.generation;
    const abort = () => {
      if (this.generation === generation) this.stop();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    audioTrack.addEventListener("ended", this.handleInputEnded, { once: true });

    try {
      this.onStateChange?.("connecting", options.targetLanguageCode);
      await this.connect(generation, options.signal);
      if (!this.desired || this.generation !== generation) {
        throw new DOMException("Live translation was cancelled.", "AbortError");
      }
      await this.startSourceMonitor(options, generation);
      if (!this.desired || this.generation !== generation) {
        throw new DOMException("Live translation was cancelled.", "AbortError");
      }
      this.attachInput(options.inputStream, generation);
      this.onStateChange?.("active", options.targetLanguageCode);
    } catch (error) {
      if (this.generation === generation) this.stop();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  stop() {
    this.desired = false;
    this.generation += 1;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
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

  private async startSourceMonitor(options: StartLiveTranslationOptions, generation: number) {
    if (!Number.isFinite(options.sourcePlaybackVolume)) return;
    const audioTrack = options.inputStream.getAudioTracks()[0];
    if (!audioTrack) return;

    let sourceAudioIsSuppressed = options.sourceAudioIsSuppressed === true;
    let restoreSourcePlayback: (() => void) | null = null;
    const supported = navigator.mediaDevices?.getSupportedConstraints?.() as ChromeAudioTrackSupportedConstraints | undefined;
    if (!sourceAudioIsSuppressed && supported?.suppressLocalAudioPlayback === true) {
      const previousConstraints = audioTrack.getConstraints() as ChromeAudioTrackConstraints;
      try {
        await audioTrack.applyConstraints({
          ...previousConstraints,
          suppressLocalAudioPlayback: true,
        } as ChromeAudioTrackConstraints);
        sourceAudioIsSuppressed = true;
        if (previousConstraints.suppressLocalAudioPlayback !== true) {
          restoreSourcePlayback = () => {
            if (audioTrack.readyState === "ended") return;
            const currentConstraints = audioTrack.getConstraints() as ChromeAudioTrackConstraints;
            void audioTrack.applyConstraints({
              ...currentConstraints,
              suppressLocalAudioPlayback: false,
            } as ChromeAudioTrackConstraints).catch(() => {});
          };
        }
      } catch {
        // Translation can continue even if this Chrome build cannot duck shared-tab audio.
      }
    }

    if (!this.desired || this.generation !== generation) {
      restoreSourcePlayback?.();
      return;
    }
    if (!sourceAudioIsSuppressed) return;

    const source = this.audioContext.createMediaStreamSource(options.inputStream);
    const gain = this.audioContext.createGain();
    gain.gain.value = Math.min(1, Math.max(0, options.sourcePlaybackVolume ?? 0));
    source.connect(gain);
    gain.connect(this.audioContext.destination);
    this.sourceMonitor = source;
    this.sourceMonitorGain = gain;
    this.restoreSourcePlayback = restoreSourcePlayback;
  }

  private stopSourceMonitor() {
    this.sourceMonitor?.disconnect();
    this.sourceMonitorGain?.disconnect();
    this.sourceMonitor = null;
    this.sourceMonitorGain = null;
    const restoreSourcePlayback = this.restoreSourcePlayback;
    this.restoreSourcePlayback = null;
    restoreSourcePlayback?.();
  }

  private readonly handleInputEnded = () => {
    if (!this.desired) return;
    this.stop();
    const error = new Error("The video audio source ended, so live translation stopped.");
    this.onError?.(error);
  };

  private attachInput(stream: MediaStream, generation: number) {
    const source = this.audioContext.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(this.audioContext, "lumi-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
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

  private async connect(generation: number, signal?: AbortSignal) {
    const socketUrl = await this.createSocketUrl(this.targetLanguageCode, signal);
    if (!this.desired || this.generation !== generation || signal?.aborted) {
      throw new DOMException("Live translation was cancelled.", "AbortError");
    }

    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(socketUrl);
      this.websocket = websocket;
      let setupComplete = false;
      const setupTimeout = window.setTimeout(() => {
        if (setupComplete || this.websocket !== websocket) return;
        websocket.close(4000, "Live translation setup timed out");
        reject(new Error("Gemini Live Translate did not finish setup within 15 seconds."));
      }, 15000);

      websocket.onopen = () => {
        if (this.websocket !== websocket) return;
        websocket.send(JSON.stringify(buildLiveTranslationSetup(this.targetLanguageCode)));
      };
      websocket.onmessage = (event) => {
        void this.handleMessage(event, websocket, () => {
          if (setupComplete) return;
          setupComplete = true;
          window.clearTimeout(setupTimeout);
          resolve();
        }).catch((error) => {
          if (!setupComplete) reject(error);
          this.reportError(error);
        });
      };
      websocket.onerror = () => {
        if (!setupComplete) reject(new Error("Could not connect to Gemini Live Translate."));
      };
      websocket.onclose = (event) => {
        window.clearTimeout(setupTimeout);
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

  private async handleMessage(event: MessageEvent, websocket: WebSocket, markSetupComplete: () => void) {
    if (this.websocket !== websocket) return;
    const raw = typeof event.data === "string" ? event.data : await event.data.text();
    const response = JSON.parse(raw);
    if (response.error?.message) throw new Error(response.error.message);
    if (response.setupComplete) markSetupComplete();
    const content = response.serverContent;
    if (content?.inputTranscription?.text) this.onInputTranscript?.(content.inputTranscription.text);
    if (content?.outputTranscription?.text) this.onOutputTranscript?.(content.outputTranscription.text);
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) this.playOutput(part.inlineData.data);
    }
    if (content?.interrupted) this.stopOutput();
  }

  private scheduleReconnect(generation: number, reason?: string) {
    if (!this.desired || this.generation !== generation) return;
    this.onStateChange?.("reconnecting", reason || this.targetLanguageCode);
    this.reconnectTimer = window.setTimeout(() => {
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

  private reportError(error: unknown) {
    const normalized = error instanceof Error ? error : new Error("Live translation failed.");
    this.stop();
    this.onStateChange?.("error", normalized.message);
    this.onError?.(normalized);
  }

  private playOutput(base64: string) {
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

  private stopOutput() {
    for (const source of this.outputSources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.outputSources.clear();
    this.nextOutputTime = this.audioContext.currentTime;
  }
}
