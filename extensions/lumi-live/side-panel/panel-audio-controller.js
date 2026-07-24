import {
  base64ToInt16,
  bytesToBase64,
  floatToPcm16,
  resampleTo16k,
} from "../live/audio-utils.js";
import { MIC_CAPTURE_PROCESSOR } from "../live/session-config.js";

const PLAYBACK_LEAD_SECONDS = 0.025;
const PLAYBACK_SETTLE_MS = 120;
const MOUTH_TAIL_SECONDS = 0.12;
const BLINK_HALF_IN_MS = 58;
const BLINK_CLOSED_MINIMUM_MS = 105;
const BLINK_CLOSED_JITTER_MS = 55;
const BLINK_HALF_OUT_MS = 72;
const BLINK_INTERVAL_MINIMUM_MS = 2600;
const BLINK_INTERVAL_JITTER_MS = 4200;

export function createPanelAudioController({
  avatarController,
  elements,
  getInputState,
  onFreshUserInput,
  onInputLevel,
  onUserSpeechStart,
  sendJson,
}) {
  let audioContext = null;
  let analyser = null;
  let micStream = null;
  let micSource = null;
  let micProcessor = null;
  let nextPlaybackTime = 0;
  let mouthAnimationId = null;
  let blinkTimeoutId = null;
  let userSpeechActive = false;
  let lastUserSpeechAt = 0;
  let smoothedInputLevel = 0;
  let lastInputLevelUpdateAt = 0;
  const playbackSources = new Set();

  async function prepareOutput() {
    if (!audioContext) {
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = .45;
      analyser.connect(audioContext.destination);
      nextPlaybackTime = audioContext.currentTime;
    }
    if (audioContext.state === "suspended") await audioContext.resume();
  }

  async function setupMicrophone(stream) {
    if (micProcessor) return;
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL("live/pcm-capture-worklet.js"));
    micSource = audioContext.createMediaStreamSource(stream);
    micProcessor = new AudioWorkletNode(audioContext, MIC_CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    micProcessor.port.onmessage = (event) => {
      const mono = event.data;
      let energy = 0;
      for (const sample of mono) energy += sample * sample;
      const rms = Math.sqrt(energy / mono.length);
      const now = performance.now();
      const rawInputLevel = Math.min(1, Math.max(0, (rms - .0035) * 16));
      const smoothing = rawInputLevel > smoothedInputLevel ? .48 : .16;
      smoothedInputLevel += (rawInputLevel - smoothedInputLevel) * smoothing;
      if (now - lastInputLevelUpdateAt >= 60) {
        onInputLevel?.(smoothedInputLevel);
        lastInputLevelUpdateAt = now;
      }
      const inputState = getInputState();
      if (!inputState.canSendAudio) return;
      if (rms >= 0.012) {
        lastUserSpeechAt = now;
        if (!userSpeechActive) {
          userSpeechActive = true;
          onUserSpeechStart?.();
        }
      } else if (userSpeechActive && now - lastUserSpeechAt >= 800) {
        userSpeechActive = false;
      }
      if (inputState.suppressServerOutputUntilNextUserTurn && !inputState.freshUserInputStarted) {
        if (rms < 0.012) return;
        onFreshUserInput();
      }
      const pcm = floatToPcm16(resampleTo16k(mono, audioContext.sampleRate));
      sendJson({
        realtimeInput: {
          audio: { data: bytesToBase64(pcm), mimeType: "audio/pcm;rate=16000" },
        },
      });
    };
    micSource.connect(micProcessor);
  }

  function stopPlayback() {
    for (const source of playbackSources) {
      try { source.stop(); } catch { /* Already stopped. */ }
    }
    playbackSources.clear();
    nextPlaybackTime = audioContext?.currentTime || 0;
    setMouthFrame(0);
    if (avatarController.isStateActive("speaking")) avatarController.syncState();
  }

  function playPcmChunk(base64) {
    if (!audioContext || !analyser) return;
    avatarController.transitionState("speaking");
    const pcm = base64ToInt16(base64);
    const floats = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index] / 32768;
    const buffer = audioContext.createBuffer(1, floats.length, 24000);
    buffer.copyToChannel(floats, 0);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    const startAt = Math.max(
      audioContext.currentTime + PLAYBACK_LEAD_SECONDS,
      nextPlaybackTime,
    );
    nextPlaybackTime = startAt + buffer.duration;
    playbackSources.add(source);
    source.onended = () => {
      playbackSources.delete(source);
      if (!playbackSources.size) {
        setTimeout(() => {
          if (!playbackSources.size && avatarController.isStateActive("speaking")) {
            avatarController.syncState();
          }
        }, PLAYBACK_SETTLE_MS);
      }
    };
    source.start(startAt);
  }

  function setMouthFrame(frame) {
    elements.mouthNeutral.classList.toggle("is-active", frame === 0);
    elements.mouthSmall.classList.toggle("is-active", frame === 1);
    elements.mouthWide.classList.toggle("is-active", frame === 2);
  }

  function setEyeFrame(frame) {
    elements.eyesOpen.classList.toggle("is-active", frame === "open");
    elements.eyesHalf.classList.toggle("is-active", frame === "half");
    elements.eyesClosed.classList.toggle("is-active", frame === "closed");
  }

  function scheduleBlink() {
    clearTimeout(blinkTimeoutId);
    blinkTimeoutId = setTimeout(() => {
      setEyeFrame("half");
      blinkTimeoutId = setTimeout(() => {
        setEyeFrame("closed");
        blinkTimeoutId = setTimeout(() => {
          setEyeFrame("half");
          blinkTimeoutId = setTimeout(() => {
            setEyeFrame("open");
            scheduleBlink();
          }, BLINK_HALF_OUT_MS);
        }, BLINK_CLOSED_MINIMUM_MS + Math.random() * BLINK_CLOSED_JITTER_MS);
      }, BLINK_HALF_IN_MS);
    }, BLINK_INTERVAL_MINIMUM_MS + Math.random() * BLINK_INTERVAL_JITTER_MS);
  }

  function animateMouth() {
    const levels = new Uint8Array(128);
    let smoothed = 0;
    const draw = () => {
      let frame = 0;
      if (analyser && audioContext && (
        playbackSources.size > 0
        || audioContext.currentTime < nextPlaybackTime + MOUTH_TAIL_SECONDS
      )) {
        analyser.getByteTimeDomainData(levels);
        let energy = 0;
        for (const value of levels) {
          const centered = (value - 128) / 128;
          energy += centered * centered;
        }
        smoothed = smoothed * .64 + Math.sqrt(energy / levels.length) * .36;
        frame = smoothed > .09 ? 2 : smoothed > .018 ? 1 : 0;
      } else smoothed *= .7;
      setMouthFrame(frame);
      mouthAnimationId = requestAnimationFrame(draw);
    };
    mouthAnimationId = requestAnimationFrame(draw);
  }

  async function requestMicrophone() {
    await prepareOutput();
    if (micStream) return;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  async function startMicrophone() {
    if (!micStream) throw new Error("Microphone access was not prepared.");
    await setupMicrophone(micStream);
  }

  function stopMicrophone() {
    if (micProcessor) micProcessor.port.onmessage = null;
    micProcessor?.disconnect();
    micSource?.disconnect();
    micStream?.getTracks().forEach((track) => track.stop());
    micStream = null;
    micProcessor = null;
    micSource = null;
    userSpeechActive = false;
    lastUserSpeechAt = 0;
    smoothedInputLevel = 0;
    lastInputLevelUpdateAt = 0;
    onInputLevel?.(0);
  }

  function closeSession() {
    stopPlayback();
    stopMicrophone();
    audioContext?.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }

  function startAnimations() {
    scheduleBlink();
    animateMouth();
  }

  function dispose() {
    closeSession();
    if (mouthAnimationId) cancelAnimationFrame(mouthAnimationId);
    clearTimeout(blinkTimeoutId);
  }

  return {
    closeSession,
    dispose,
    playPcmChunk,
    prepareOutput,
    requestMicrophone,
    startAnimations,
    startMicrophone,
    stopMicrophone,
    stopPlayback,
  };
}
