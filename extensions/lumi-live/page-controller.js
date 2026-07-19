import { PageController } from "@page-agent/page-controller";
import {
  clearTabTransition,
  scrollPageGradually,
  showGoogleSearchDeparture,
  typeTextGradually,
} from "./page-visual-effects.js";
import {
  DEFAULT_VISUAL_PREFERENCES,
  normalizeVisualPreferences,
} from "./visual-preferences.js";
import { RESPONSE_AUDIO_DIRECTIVE_KEY } from "./response-audio-policy.js";
import {
  captureYouTubeVideoClick,
  didClickOpenYouTubeVideo,
} from "./youtube-video-action.js";
import {
  bytesToBase64,
  floatToPcm16,
  resampleTo16k,
} from "./live-audio-utils.js";

const CONTENT_REQUEST_SOURCE = "lumi-page-agent-service";
const MAX_STATE_CHARACTERS = 16000;
const GLOBAL_KEY = "__LUMI_PAGE_AGENT_CONTROLLER__";
const HIGHLIGHT_STYLE_ID = "lumi-page-agent-highlight-preference";
const OFFSCREEN_TARGET = "lumi_live_offscreen";
const EXTERNAL_AUDIO_FRAME_SAMPLES = 1600;

if (!globalThis[GLOBAL_KEY]) {
  const runtime = {
    controller: null,
    stateIndexed: false,
    visualPreferences: { ...DEFAULT_VISUAL_PREFERENCES },
    activeVisualActionController: null,
    mediaElementAudioCapture: null,
    mediaElementAudioRoutes: new WeakMap(),
  };
  globalThis[GLOBAL_KEY] = runtime;

  function getController() {
    if (!runtime.controller) {
      runtime.controller = new PageController({
        enableMask: true,
        viewportExpansion: 0,
        highlightOpacity: 0.08,
        highlightLabelOpacity: 0.82,
        includeAttributes: [
          "aria-label",
          "aria-expanded",
          "aria-selected",
          "aria-checked",
          "role",
          "name",
          "placeholder",
          "type",
          "title",
          "href",
          "disabled",
        ],
      });
    }
    return runtime.controller;
  }

  function applyVisualPreferences() {
    let style = document.getElementById(HIGHLIGHT_STYLE_ID);
    if (runtime.visualPreferences.showElementHighlights) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = HIGHLIGHT_STYLE_ID;
      style.textContent = "#playwright-highlight-container { display: none !important; }";
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function requireIndex(args) {
    const index = Number(args?.index);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error("A non-negative element index from the latest page state is required.");
    }
    if (!runtime.stateIndexed) {
      throw new Error("Read browser_get_page_state before using an element index.");
    }
    return index;
  }

  function indexedElement(index) {
    return getController().selectorMap?.get(index)?.ref || null;
  }

  function assertSafeInput(index) {
    const element = indexedElement(index);
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
    const descriptor = [
      element.getAttribute("type"),
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("autocomplete"),
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
    ].filter(Boolean).join(" ").toLowerCase();

    if (/(password|passcode|mật.?khẩu|otp|one.?time|mã.?xác.?thực|credit.?card|card.?number|thẻ.?tín.?dụng|cvv|cvc|api.?key|khóa.?api|secret|bí.?mật|access.?token)/i.test(descriptor)) {
      throw new Error("Lumi blocks typing passwords, OTPs, payment-card data, API keys, and other secrets.");
    }
  }

  function assertConfirmedHighImpactClick(index, confirmed) {
    const element = indexedElement(index);
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
    const label = [
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ].filter(Boolean).join(" ").trim().slice(0, 240);

    if (/(submit|send|gửi|publish|xuất.?bản|post|đăng|pay|thanh.?toán|purchase|buy now|mua.?ngay|place order|đặt.?hàng|delete|xóa|remove account|xóa.?tài.?khoản|confirm order|xác.?nhận.?đơn|authorize|ủy.?quyền|transfer|chuyển.?tiền|unsubscribe|hủy.?đăng.?ký|save password)/i.test(label) && confirmed !== true) {
      throw new Error(
        `This looks like a consequential action (${label || "unlabeled control"}). Ask for explicit confirmation, then retry with confirmed=true.`,
      );
    }
  }

  async function withVisualAction(action) {
    const pageController = getController();
    runtime.activeVisualActionController?.abort();
    const actionController = new AbortController();
    runtime.activeVisualActionController = actionController;
    await pageController.showMask();
    try {
      if (actionController.signal.aborted) {
        throw new DOMException("The page action was cancelled by the user.", "AbortError");
      }
      const result = await action(pageController, actionController.signal);
      if (actionController.signal.aborted) {
        throw new DOMException("The page action was cancelled by the user.", "AbortError");
      }
      return result;
    } finally {
      if (!actionController.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 420));
      }
      await pageController.hideMask();
      await pageController.cleanUpHighlights();
      runtime.stateIndexed = false;
      if (runtime.activeVisualActionController === actionController) {
        runtime.activeVisualActionController = null;
      }
    }
  }

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
      while (inputOffset < mono16k.length && runtime.mediaElementAudioCapture === capture) {
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
    const capture = runtime.mediaElementAudioCapture;
    runtime.mediaElementAudioCapture = null;
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
    runtime.mediaElementAudioCapture = capture;
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
        while (runtime.mediaElementAudioCapture === capture && capture.started) {
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
      if (runtime.mediaElementAudioCapture === capture && capture.started) {
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
      if (runtime.mediaElementAudioCapture !== capture || !capture.started) return;
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
    let route = runtime.mediaElementAudioRoutes.get(capture.element);
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
      runtime.mediaElementAudioRoutes.set(capture.element, route);
    }
    await route.audioContext.resume();
    if (route.audioContext.state !== "running") {
      throw new Error("Chrome suspended direct audio access for this video.");
    }
    const processorNode = route.audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = route.audioContext.createGain();
    silentGain.gain.value = 0;
    processorNode.onaudioprocess = (event) => {
      if (runtime.mediaElementAudioCapture !== capture || !capture.started) return;
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
    const capture = runtime.mediaElementAudioCapture;
    if (!capture) throw new Error("Prepare the active media element before starting audio capture.");
    if (capture.started) return { success: true, started: true, alreadyActive: true };
    capture.started = true;
    capture.onMediaEnded = () => {
      if (runtime.mediaElementAudioCapture !== capture || !capture.started) return;
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

  async function handleControllerTool(tool, args = {}) {
    const pageController = getController();

    if (tool === "bridge_controller_ping") {
      return {
        success: true,
        ready: true,
        visualPreferences: runtime.visualPreferences,
        mediaElementAudioPrepared: Boolean(runtime.mediaElementAudioCapture),
      };
    }

    if (tool === "bridge_prepare_media_element_audio") {
      return prepareMediaElementAudioCapture();
    }

    if (tool === "bridge_start_media_element_audio") {
      return startMediaElementAudioCapture();
    }

    if (tool === "bridge_stop_media_element_audio") {
      return stopMediaElementAudioCapture();
    }

    if (tool === "bridge_set_visual_preferences") {
      runtime.visualPreferences = normalizeVisualPreferences(args);
      applyVisualPreferences();
      if (!runtime.visualPreferences.showElementHighlights) {
        await pageController.cleanUpHighlights();
      }
      return { success: true, visualPreferences: runtime.visualPreferences };
    }

    if (tool === "bridge_cancel_active_action") {
      const activeActionController = runtime.activeVisualActionController;
      runtime.activeVisualActionController = null;
      activeActionController?.abort();
      clearTabTransition();
      await pageController.hideMask().catch(() => {});
      await pageController.cleanUpHighlights().catch(() => {});
      runtime.stateIndexed = false;
      return { success: true, cancelled: true };
    }

    if (tool === "bridge_show_google_search_departure") {
      await showGoogleSearchDeparture(String(args.searchText || "new tab"));
      return { success: true };
    }

    if (tool === "bridge_clear_tab_transition") {
      clearTabTransition();
      return { success: true };
    }

    if (tool === "browser_get_page_state") {
      applyVisualPreferences();
      const state = await pageController.getBrowserState();
      runtime.stateIndexed = true;
      if (!runtime.visualPreferences.showElementHighlights) {
        await pageController.cleanUpHighlights();
      }
      const content = state.content.length > MAX_STATE_CHARACTERS
        ? `${state.content.slice(0, MAX_STATE_CHARACTERS)}\n[Page state truncated]`
        : state.content;
      return { success: true, ...state, content };
    }

    if (tool === "browser_click") {
      const index = requireIndex(args);
      assertConfirmedHighImpactClick(index, args.confirmed);
      const videoClick = captureYouTubeVideoClick(indexedElement(index));
      return withVisualAction(async (activeController) => {
        const result = await activeController.clickElement(index);
        if (result?.success === false || !didClickOpenYouTubeVideo(videoClick)) return result;
        return {
          ...result,
          [RESPONSE_AUDIO_DIRECTIVE_KEY]: {
            suppressForTurn: true,
            reason: "youtube_video_opened",
          },
        };
      });
    }

    if (tool === "browser_input_text") {
      const index = requireIndex(args);
      const text = String(args.text ?? "");
      assertSafeInput(index);
      return withVisualAction(async (activeController, signal) => {
        const element = indexedElement(index);
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
          throw new Error(`Element at index ${index} is no longer available.`);
        }
        const clickResult = await activeController.clickElement(index);
        if (clickResult?.success === false) throw new Error(clickResult.message);
        await typeTextGradually(element, text, runtime.visualPreferences.typingDurationMs, signal);
        return {
          success: true,
          message: `Input text gradually over ${runtime.visualPreferences.typingDurationMs} ms.`,
        };
      });
    }

    if (tool === "browser_select_option") {
      const index = requireIndex(args);
      const optionText = String(args.optionText ?? "").trim();
      if (!optionText) throw new Error("optionText is required.");
      return withVisualAction((activeController) => activeController.selectOption(index, optionText));
    }

    if (tool === "browser_scroll") {
      if (!runtime.stateIndexed) {
        await pageController.getBrowserState();
        runtime.stateIndexed = true;
      }
      const direction = args.direction === "up" ? "up" : "down";
      const pages = Math.min(3, Math.max(0.25, Number(args.pages) || 0.8));
      const index = args.index === undefined ? undefined : requireIndex(args);
      return withVisualAction((_activeController, signal) => scrollPageGradually({
        direction,
        pages,
        indexedElement: index === undefined ? undefined : indexedElement(index),
        durationMs: runtime.visualPreferences.scrollDurationMs,
        signal,
      }));
    }

    throw new Error(`Unsupported PageAgent controller tool: ${tool}`);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.source !== CONTENT_REQUEST_SOURCE) return false;
    handleControllerTool(message.tool, message.args)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "PageAgent controller failed.",
      }));
    return true;
  });
}
