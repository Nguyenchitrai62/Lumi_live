import {
  bytesToBase64,
  floatToPcm16,
  resampleTo16k,
} from "../live/audio-utils.js";
import { MIC_CAPTURE_PROCESSOR } from "../live/session-config.js";

const OFFSCREEN_TARGET = "lumi_live_offscreen";

export function buildSharedTabAudioConstraints(supportedConstraints = {}) {
  const suppressLocalPlayback = supportedConstraints.suppressLocalAudioPlayback === true;
  return {
    constraints: {
      video: {
        displaySurface: "browser",
        frameRate: { ideal: 1, max: 1 },
      },
      audio: suppressLocalPlayback
        ? { suppressLocalAudioPlayback: true }
        : true,
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      systemAudio: "include",
    },
    suppressLocalPlayback,
  };
}

export function createSharedTabAudioController({ onEnded }) {
  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let processorNode = null;
  let playbackGain = null;
  let forwarding = false;
  let sourcePlaybackVolume = 1;

  function sendAudio(samples) {
    if (!forwarding || !audioContext) return;
    const pcm = floatToPcm16(resampleTo16k(samples, audioContext.sampleRate));
    void chrome.runtime.sendMessage({
      target: OFFSCREEN_TARGET,
      command: "external_audio",
      sourceMode: "sharedTab",
      data: bytesToBase64(pcm),
    }).catch(() => {});
  }

  function stop({ notify = false } = {}) {
    const previousStream = stream;
    forwarding = false;
    stream = null;
    if (processorNode) processorNode.port.onmessage = null;
    processorNode?.disconnect();
    sourceNode?.disconnect();
    playbackGain?.disconnect();
    previousStream?.getTracks().forEach((track) => {
      track.removeEventListener("ended", handleTrackEnded);
      track.stop();
    });
    processorNode = null;
    sourceNode = null;
    playbackGain = null;
    sourcePlaybackVolume = 1;
    audioContext?.close().catch(() => {});
    audioContext = null;
    if (notify && previousStream) onEnded?.();
  }

  function handleTrackEnded() {
    stop({ notify: true });
  }

  async function requestAndPrepare() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Chrome does not support tab sharing in this side panel.");
    }
    stop();
    const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
    const { constraints, suppressLocalPlayback } = buildSharedTabAudioConstraints(supported);
    const nextStream = await navigator.mediaDevices.getDisplayMedia(constraints);
    try {
      const audioTrack = nextStream.getAudioTracks()[0];
      if (!audioTrack) {
        throw new Error("The selected tab did not share audio. Choose Chrome Tab and enable Share tab audio.");
      }
      const displaySurface = nextStream.getVideoTracks()[0]?.getSettings?.().displaySurface;
      if (displaySurface && displaySurface !== "browser") {
        throw new Error("Choose a Chrome Tab in the share picker, not a window or entire screen.");
      }

      const context = new AudioContext({ latencyHint: "interactive" });
      await context.audioWorklet.addModule(chrome.runtime.getURL("live/pcm-capture-worklet.js"));
      await context.resume();
      if (context.state !== "running") {
        await context.close().catch(() => {});
        throw new Error("Chrome paused shared-tab audio. Open the picker and try again.");
      }

      stream = nextStream;
      audioContext = context;
      sourceNode = context.createMediaStreamSource(nextStream);
      processorNode = new AudioWorkletNode(context, MIC_CAPTURE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
      });
      processorNode.port.onmessage = (event) => sendAudio(event.data);
      sourceNode.connect(processorNode);

      sourcePlaybackVolume = suppressLocalPlayback ? 0.06 : 1;
      if (suppressLocalPlayback) {
        playbackGain = context.createGain();
        playbackGain.gain.value = sourcePlaybackVolume;
        sourceNode.connect(playbackGain);
        playbackGain.connect(context.destination);
      }
      for (const track of nextStream.getTracks()) {
        track.addEventListener("ended", handleTrackEnded, { once: true });
      }
      return {
        sourcePlaybackVolume,
        title: audioTrack.label || "Shared Chrome tab",
      };
    } catch (error) {
      nextStream.getTracks().forEach((track) => track.stop());
      stop();
      throw error;
    }
  }

  function startForwarding() {
    if (!stream || !audioContext) throw new Error("Shared-tab audio was not prepared.");
    forwarding = true;
  }

  return {
    get active() {
      return Boolean(stream);
    },
    requestAndPrepare,
    startForwarding,
    stop,
  };
}
