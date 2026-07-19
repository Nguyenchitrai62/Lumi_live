import { EXTENSION_EVENTS } from "../core/extension-config.js";
import {
  getLiveTranslationLanguageLabel,
  LiveTranslationController,
  normalizeLiveTranslationLanguageCode,
} from "../live/translate.js";

const OFFSCREEN_TARGET = "lumi_live_offscreen";
const WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

let audioContext = null;
let sourceStream = null;
let sourceMonitor = null;
let sourceGain = null;
let sourceInfo = null;
let translationController = null;
let activeApiKey = "";
let translationState = "off";
let targetLanguageCode = "";

function publishTranslationState(state, detail = "") {
  translationState = state;
  if (state === "off") targetLanguageCode = "";
  else {
    const normalizedTarget = normalizeLiveTranslationLanguageCode(detail);
    if (normalizedTarget) targetLanguageCode = normalizedTarget;
  }
  chrome.runtime.sendMessage({
    type: EXTENSION_EVENTS.translationState,
    state,
    detail,
    targetLanguageCode,
    tabId: sourceInfo?.tabId ?? null,
  }).catch(() => {});
}

function setSourceVolume(volume) {
  if (!sourceGain || !audioContext) return;
  sourceGain.gain.cancelScheduledValues(audioContext.currentTime);
  sourceGain.gain.setTargetAtTime(Math.min(1, Math.max(0, volume)), audioContext.currentTime, 0.025);
}

async function ensureAudioContext() {
  if (audioContext && audioContext.state !== "closed") {
    await audioContext.resume();
    return audioContext;
  }
  audioContext = new AudioContext({ latencyHint: "interactive" });
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL("live/pcm-capture-worklet.js"));
  await audioContext.resume();
  return audioContext;
}

function getStatus() {
  const externalPrepared = sourceInfo?.mode === "mediaElement";
  return {
    prepared: externalPrepared
      || Boolean(sourceStream?.getAudioTracks().some((track) => track.readyState === "live")),
    state: translationState,
    targetLanguageCode,
    source: sourceInfo,
  };
}

function stopTranslation() {
  const wasActive = translationController?.isActive() === true;
  translationController?.stop();
  setSourceVolume(1);
  if (!wasActive) publishTranslationState("off");
  return { ...getStatus(), wasActive };
}

async function releaseCapture() {
  stopTranslation();
  translationController = null;
  sourceMonitor?.disconnect();
  sourceGain?.disconnect();
  sourceMonitor = null;
  sourceGain = null;
  sourceStream?.getTracks().forEach((track) => track.stop());
  sourceStream = null;
  sourceInfo = null;
  activeApiKey = "";
  if (audioContext && audioContext.state !== "closed") await audioContext.close().catch(() => {});
  audioContext = null;
  return getStatus();
}

async function prepareCapture({ streamId, tabId, title, url }) {
  await releaseCapture();
  const context = await ensureAudioContext();
  const mandatory = {
    chromeMediaSource: "tab",
    chromeMediaSourceId: streamId,
  };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory },
    video: false,
  });
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("The active tab did not provide an audio track.");
  }

  sourceStream = stream;
  sourceInfo = { mode: "tabCapture", tabId, title: title || "Active video tab", url: url || "" };
  sourceMonitor = context.createMediaStreamSource(stream);
  sourceGain = context.createGain();
  sourceGain.gain.value = 1;
  sourceMonitor.connect(sourceGain);
  sourceGain.connect(context.destination);
  audioTrack.addEventListener("ended", () => {
    if (sourceStream !== stream) return;
    void releaseCapture().then(() => {
      publishTranslationState("error", "The authorized tab audio ended. Click the Lumi icon on the video tab to authorize it again.");
    });
  }, { once: true });
  return getStatus();
}

async function prepareExternalCapture({ tabId, title, url }) {
  await releaseCapture();
  await ensureAudioContext();
  sourceInfo = {
    mode: "mediaElement",
    tabId,
    title: title || "Active video tab",
    url: url || "",
  };
  return getStatus();
}

async function startTranslation({ apiKey, requestedTargetLanguageCode }) {
  const normalizedTarget = normalizeLiveTranslationLanguageCode(requestedTargetLanguageCode);
  if (!normalizedTarget) throw new Error("Choose one of the supported Live Translate target languages.");
  const externalInput = sourceInfo?.mode === "mediaElement";
  const tabCaptureReady = sourceStream?.getAudioTracks().some((track) => track.readyState === "live");
  if (!externalInput && !tabCaptureReady) {
    throw new Error("Tab audio is not authorized. Activate the video tab and click the Lumi toolbar icon once, then ask to translate again.");
  }
  activeApiKey = String(apiKey || "").trim();
  if (!activeApiKey) throw new Error("Start the Lumi voice session before using Live Translate.");
  if (
    translationController?.isActive() === true
    && translationController.getTargetLanguageCode() === normalizedTarget
  ) {
    return {
      ...getStatus(),
      languageLabel: getLiveTranslationLanguageLabel(normalizedTarget),
      sourcePlaybackVolume: 0.06,
      alreadyActive: true,
    };
  }
  targetLanguageCode = normalizedTarget;
  const context = await ensureAudioContext();
  if (!translationController) {
    translationController = new LiveTranslationController({
      audioContext: context,
      createSocketUrl: async () => `${WS_ENDPOINT}?key=${encodeURIComponent(activeApiKey)}`,
      onStateChange: (state, detail) => {
        if (state === "active" || state === "reconnecting") setSourceVolume(0.06);
        else if (state === "off" || state === "error") setSourceVolume(1);
        publishTranslationState(state, detail || targetLanguageCode);
      },
      onError: (error) => publishTranslationState("error", error.message),
    });
  }
  if (externalInput) {
    await translationController.startExternal({ targetLanguageCode: normalizedTarget });
  } else {
    await translationController.start({
      inputStream: sourceStream,
      targetLanguageCode: normalizedTarget,
      ownsInputStream: false,
    });
    setSourceVolume(0.06);
  }
  return {
    ...getStatus(),
    languageLabel: getLiveTranslationLanguageLabel(normalizedTarget),
    sourcePlaybackVolume: 0.06,
  };
}

async function handleCommand(message) {
  if (message.command === "prepare_capture") return prepareCapture(message);
  if (message.command === "prepare_external_capture") return prepareExternalCapture(message);
  if (message.command === "translation_status") return getStatus();
  if (message.command === "external_audio") {
    if (sourceInfo?.mode !== "mediaElement") return { accepted: false };
    return { accepted: translationController?.sendExternalAudio(String(message.data || "")) === true };
  }
  if (message.command === "external_source_ended") {
    const detail = String(message.detail || "Direct video audio capture ended.");
    await releaseCapture();
    publishTranslationState("error", detail);
    return getStatus();
  }
  if (message.command === "start_translation") {
    return startTranslation({
      apiKey: message.apiKey,
      requestedTargetLanguageCode: message.targetLanguageCode,
    });
  }
  if (message.command === "stop_translation") return stopTranslation();
  if (message.command === "release_capture") {
    if (Number.isInteger(message.expectedTabId) && sourceInfo?.tabId !== message.expectedTabId) {
      return getStatus();
    }
    return releaseCapture();
  }
  throw new Error(`Unsupported offscreen command: ${message.command}`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== OFFSCREEN_TARGET) return;
  if (
    (message.command === "external_audio" || message.command === "external_source_ended")
    && sourceInfo?.tabId !== sender.tab?.id
  ) return false;
  Promise.resolve(handleCommand(message))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
});
