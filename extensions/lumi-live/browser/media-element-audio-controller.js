import {
  bytesToBase64,
  floatToPcm16,
  resampleTo16k,
} from "../live/audio-utils.js";

const OFFSCREEN_TARGET = "lumi_live_offscreen";
const EXTERNAL_AUDIO_FRAME_SAMPLES = 1600;

export function createMediaElementAudioController() {
  let mediaElementAudioCapture = null;
  const mediaElementAudioRoutes = new WeakMap();

  function chooseActiveMediaElement() {
    const candidates = [...document.querySelectorAll("video, audio")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return !element.paused
          && !element.ended
          && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          && (element.tagName === "AUDIO" || (rect.width > 0 && rect.height > 0));
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const leftScore = left.tagName === "AUDIO" ? 1 : leftRect.width * leftRect.height;
        const rightScore = right.tagName === "AUDIO" ? 1 : rightRect.width * rightRect.height;
        return rightScore - leftScore;
      });
    return candidates[0] || null;
  }

  function createExternalPcmWriter(capture) {
    let frame = new Float32Array(EXTERNAL_AUDIO_FRAME_SAMPLES);
    let offset = 0;
    return (samples, sampleRate) => {
      const mono16k = resampleTo16k(samples, sampleRate);
      let inputOffset = 0;
      while (inputOffset < mono16k.length && mediaElementAudioCapture === capture) {
        const sampleCount = Math.min(frame.length - offset, mono16k.length - inputOffset);
        frame.set(mono16k.subarray(inputOffset, inputOffset + sampleCount), offset);
        offset += sampleCount;
        inputOffset += sampleCount;
        if (offset !== frame.length) continue;
        const data = bytesToBase64(floatToPcm16(frame));
        chrome.runtime.sendMessage({
          target: OFFSCREEN_TARGET,
          command: "external_audio",
          data,
        }).catch(() => {});
        frame = new Float32Array(EXTERNAL_AUDIO_FRAME_SAMPLES);
        offset = 0;
      }
    };
  }

  async function stopMediaElementAudioCapture() {
    const capture = mediaElementAudioCapture;
    mediaElementAudioCapture = null;
    if (!capture) return { success: true, stopped: false };
    capture.started = false;
    capture.element?.removeEventListener("ended", capture.onMediaEnded);
    capture.element?.removeEventListener("emptied", capture.onMediaEnded);
    await capture.reader?.cancel().catch(() => {});
    capture.processorNode?.disconnect();
    capture.silentGain?.disconnect();
    if (capture.scriptProcessor) capture.scriptProcessor.onaudioprocess = null;
    if (capture.mode === "mediaElementSource") {
      const route = capture.route;
      if (route?.audioContext.state !== "closed") {
        route.playbackGain.gain.cancelScheduledValues(route.audioContext.currentTime);
        route.playbackGain.gain.setTargetAtTime(1, route.audioContext.currentTime, 0.025);
      }
    } else {
      capture.sourceNode?.disconnect();
      await capture.audioContext?.close().catch(() => {});
      capture.stream?.getTracks().forEach((track) => track.stop());
      if (
        capture.element?.isConnected
        && Math.abs(capture.element.volume - capture.duckedVolume) < 0.002
      ) {
        capture.element.volume = capture.originalVolume;
      }
    }
    return { success: true, stopped: true };
  }

  function assertWebAudioSourceIsReadable(element) {
    const sourceUrl = String(element.currentSrc || element.src || "");
    if (!sourceUrl) return;
    const parsed = new URL(sourceUrl, location.href);
    if (["blob:", "data:"].includes(parsed.protocol)) return;
    if (parsed.origin === location.origin || element.crossOrigin) return;
    throw new Error("This cross-origin player does not expose CORS-readable audio.");
  }

  async function prepareMediaElementAudioCapture() {
    await stopMediaElementAudioCapture();
    const element = chooseActiveMediaElement();
    if (!element) {
      throw new Error("No actively playing HTML video or audio element was found in this tab.");
    }
    const captureStream = element.captureStream || element.mozCaptureStream;
    let stream = null;
    let audioTrack = null;
    if (typeof captureStream === "function") {
      try {
        stream = captureStream.call(element);
        audioTrack = stream.getAudioTracks()[0] || null;
      } catch {
        stream = null;
      }
    }
    if (!audioTrack) {
      stream?.getTracks().forEach((track) => track.stop());
      assertWebAudioSourceIsReadable(element);
    }
    const capture = {
      mode: audioTrack ? "captureStream" : "mediaElementSource",
      element,
      stream,
      audioTrack,
      originalVolume: element.volume,
      duckedVolume: Math.min(element.volume, 0.06),
      started: false,
      reader: null,
      audioContext: null,
      sourceNode: null,
      processorNode: null,
      silentGain: null,
      scriptProcessor: null,
      route: null,
      onMediaEnded: null,
    };
    mediaElementAudioCapture = capture;
    return {
      success: true,
      prepared: true,
      source: element.tagName.toLowerCase(),
      captureMode: capture.mode,
      title: document.title,
      url: location.href,
    };
  }

  async function pumpTrackProcessor(capture, writePcm) {
    const TrackProcessor = globalThis.MediaStreamTrackProcessor;
    if (typeof TrackProcessor !== "function") return false;
    let reader;
    try {
      const processor = new TrackProcessor({ track: capture.audioTrack });
      reader = processor.readable.getReader();
    } catch {
      return false;
    }
    capture.reader = reader;
    void (async () => {
      let failure = null;
      try {
        while (mediaElementAudioCapture === capture && capture.started) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          try {
            const samples = new Float32Array(value.numberOfFrames);
            const channelCount = Math.max(1, value.numberOfChannels || 1);
            for (let channel = 0; channel < channelCount; channel += 1) {
              const plane = new Float32Array(value.numberOfFrames);
              value.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
              for (let index = 0; index < samples.length; index += 1) {
                samples[index] += plane[index] / channelCount;
              }
            }
            writePcm(samples, value.sampleRate);
          } finally {
            value.close();
          }
        }
      } catch (error) {
        failure = error;
      }
      if (mediaElementAudioCapture === capture && capture.started) {
        const detail = failure instanceof Error
          ? failure.message
          : "The playing media element stopped providing audio.";
        await stopMediaElementAudioCapture();
        chrome.runtime.sendMessage({
          target: OFFSCREEN_TARGET,
          command: "external_source_ended",
          detail,
        }).catch(() => {});
      }
    })();
    return true;
  }

  async function pumpScriptProcessor(capture, writePcm) {
    const audioContext = new AudioContext({ latencyHint: "interactive" });
    const sourceNode = audioContext.createMediaStreamSource(capture.stream);
    const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    processorNode.onaudioprocess = (event) => {
      if (mediaElementAudioCapture !== capture || !capture.started) return;
      writePcm(event.inputBuffer.getChannelData(0), event.inputBuffer.sampleRate);
    };
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);
    capture.audioContext = audioContext;
    capture.sourceNode = sourceNode;
    capture.processorNode = processorNode;
    capture.silentGain = silentGain;
    capture.scriptProcessor = processorNode;
    await audioContext.resume();
    if (audioContext.state !== "running") {
      throw new Error("Chrome suspended direct media capture for this page.");
    }
  }

  async function pumpMediaElementSource(capture, writePcm) {
    let route = mediaElementAudioRoutes.get(capture.element);
    if (!route || route.audioContext.state === "closed") {
      const audioContext = new AudioContext({ latencyHint: "interactive" });
      await audioContext.resume();
      if (audioContext.state !== "running") {
        await audioContext.close().catch(() => {});
        throw new Error("Chrome suspended direct audio access for this video.");
      }
      const sourceNode = audioContext.createMediaElementSource(capture.element);
      const playbackGain = audioContext.createGain();
      playbackGain.gain.value = 1;
      sourceNode.connect(playbackGain);
      playbackGain.connect(audioContext.destination);
      route = { audioContext, sourceNode, playbackGain };
      mediaElementAudioRoutes.set(capture.element, route);
    }
    await route.audioContext.resume();
    if (route.audioContext.state !== "running") {
      throw new Error("Chrome suspended direct audio access for this video.");
    }
    const processorNode = route.audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = route.audioContext.createGain();
    silentGain.gain.value = 0;
    processorNode.onaudioprocess = (event) => {
      if (mediaElementAudioCapture !== capture || !capture.started) return;
      writePcm(event.inputBuffer.getChannelData(0), event.inputBuffer.sampleRate);
    };
    route.sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(route.audioContext.destination);
    route.playbackGain.gain.cancelScheduledValues(route.audioContext.currentTime);
    route.playbackGain.gain.setTargetAtTime(0.06, route.audioContext.currentTime, 0.025);
    capture.route = route;
    capture.audioContext = route.audioContext;
    capture.sourceNode = route.sourceNode;
    capture.processorNode = processorNode;
    capture.silentGain = silentGain;
    capture.scriptProcessor = processorNode;
  }

  async function startMediaElementAudioCapture() {
    const capture = mediaElementAudioCapture;
    if (!capture) throw new Error("Prepare the active media element before starting audio capture.");
    if (capture.started) return { success: true, started: true, alreadyActive: true };
    capture.started = true;
    capture.onMediaEnded = () => {
      if (mediaElementAudioCapture !== capture || !capture.started) return;
      void stopMediaElementAudioCapture().then(() => {
        chrome.runtime.sendMessage({
          target: OFFSCREEN_TARGET,
          command: "external_source_ended",
          detail: "The playing media element ended.",
        }).catch(() => {});
      });
    };
    capture.element.addEventListener("ended", capture.onMediaEnded, { once: true });
    capture.element.addEventListener("emptied", capture.onMediaEnded, { once: true });
    const writePcm = createExternalPcmWriter(capture);
    try {
      if (capture.mode === "mediaElementSource") {
        await pumpMediaElementSource(capture, writePcm);
      } else {
        capture.element.volume = capture.duckedVolume;
        const usingTrackProcessor = await pumpTrackProcessor(capture, writePcm);
        if (!usingTrackProcessor) await pumpScriptProcessor(capture, writePcm);
      }
    } catch (error) {
      await stopMediaElementAudioCapture();
      throw error;
    }
    return {
      success: true,
      started: true,
      sourcePlaybackVolume: capture.duckedVolume,
    };
  }

  return {
    isPrepared: () => Boolean(mediaElementAudioCapture),
    prepare: prepareMediaElementAudioCapture,
    start: startMediaElementAudioCapture,
    stop: stopMediaElementAudioCapture,
  };
}
