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
  return {
    prepared: sourceInfo?.mode === "mediaElement" || sourceInfo?.mode === "sharedTab",
    state: translationState,
    targetLanguageCode,
    source: sourceInfo,
  };
}

function stopTranslation() {
  const wasActive = translationController?.isActive() === true;
  translationController?.stop();
  if (!wasActive) publishTranslationState("off");
  return { ...getStatus(), wasActive };
}

async function releaseCapture() {
  stopTranslation();
  translationController = null;
  sourceInfo = null;
  activeApiKey = "";
  if (audioContext && audioContext.state !== "closed") await audioContext.close().catch(() => {});
  audioContext = null;
  return getStatus();
}

async function prepareExternalCapture({
  mode = "mediaElement",
  tabId,
  title,
  url,
  sourcePlaybackVolume = 0.06,
}) {
  if (mode !== "mediaElement" && mode !== "sharedTab") {
    throw new Error("Unsupported external audio source.");
  }
  await releaseCapture();
  await ensureAudioContext();
  sourceInfo = {
    mode,
    tabId,
    title: title || (mode === "sharedTab" ? "Shared Chrome tab" : "Active video tab"),
    url: url || "",
    sourcePlaybackVolume: sourcePlaybackVolume === 0.06 ? 0.06 : 1,
  };
  return getStatus();
}

async function startTranslation({ apiKey, requestedTargetLanguageCode }) {
  const normalizedTarget = normalizeLiveTranslationLanguageCode(requestedTargetLanguageCode);
  if (!normalizedTarget) throw new Error("Choose one of the supported Live Translate target languages.");
  const externalInput = sourceInfo?.mode === "mediaElement" || sourceInfo?.mode === "sharedTab";
  if (!externalInput) {
    throw new Error("Video audio is not prepared. Activate a playing HTML video or audio element and try again.");
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
      sourcePlaybackVolume: sourceInfo?.sourcePlaybackVolume ?? 0.06,
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
        publishTranslationState(state, detail || targetLanguageCode);
      },
      onError: (error) => publishTranslationState("error", error.message),
    });
  }
  await translationController.startExternal({ targetLanguageCode: normalizedTarget });
  return {
    ...getStatus(),
    languageLabel: getLiveTranslationLanguageLabel(normalizedTarget),
    sourcePlaybackVolume: sourceInfo?.sourcePlaybackVolume ?? 0.06,
  };
}

async function handleCommand(message) {
  if (message.command === "prepare_external_capture") return prepareExternalCapture(message);
  if (message.command === "translation_status") return getStatus();
  if (message.command === "external_audio") {
    if (sourceInfo?.mode !== "mediaElement" && sourceInfo?.mode !== "sharedTab") {
      return { accepted: false };
    }
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
  ) {
    const fromCapturedTab = sourceInfo?.mode === "mediaElement"
      && sourceInfo.tabId === sender.tab?.id;
    const fromSidePanel = sourceInfo?.mode === "sharedTab"
      && sender.id === chrome.runtime.id
      && sender.url === chrome.runtime.getURL("side-panel/index.html")
      && message.sourceMode === "sharedTab";
    if (!fromCapturedTab && !fromSidePanel) return false;
  }
  Promise.resolve(handleCommand(message))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  return true;
});
