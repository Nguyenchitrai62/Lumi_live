import { createMediaElementAudioController } from "./media-element-audio-controller.js";
import { PageController } from "@page-agent/page-controller";
import {
  clearTabTransition,
  showGoogleSearchDeparture,
} from "./effects/tab-transition.js";
import {
  scrollPageGradually,
  scrollToTextGradually,
} from "./effects/scroll.js";
import { typeTextGradually } from "./effects/text-input.js";
import {
  assertConfirmedPageAgentClick,
  assertSafePageAgentInput,
} from "./page-agent-safety.js";
import {
  DEFAULT_VISUAL_PREFERENCES,
  normalizeVisualPreferences,
} from "../core/visual-preferences.js";
import {
  BROWSER_ACTION_CLEANUP_DELAY_MS,
  BROWSER_CLICK_RIPPLE_DURATION_MS,
} from "../core/ui-config.js";
import { RESPONSE_AUDIO_DIRECTIVE_KEY } from "../core/response-audio-policy.js";
import {
  captureYouTubeVideoClick,
  didClickOpenYouTubeVideo,
} from "./youtube-video-action.js";

const CONTENT_REQUEST_SOURCE = "lumi-page-agent-service";
const MAX_STATE_CHARACTERS = 16000;
const GLOBAL_KEY = "__LUMI_PAGE_AGENT_CONTROLLER__";
const HIGHLIGHT_STYLE_ID = "lumi-page-agent-highlight-preference";
const CLICK_EFFECT_STYLE_ID = "lumi-page-agent-click-effect-preference";
if (!globalThis[GLOBAL_KEY]) {
  const runtime = {
    controller: null,
    stateIndexed: false,
    visualPreferences: { ...DEFAULT_VISUAL_PREFERENCES },
    activeVisualActionController: null,
  };
  globalThis[GLOBAL_KEY] = runtime;

  const mediaElementAudio = createMediaElementAudioController();

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
    let clickEffectStyle = document.getElementById(CLICK_EFFECT_STYLE_ID);
    if (!clickEffectStyle) {
      clickEffectStyle = document.createElement("style");
      clickEffectStyle.id = CLICK_EFFECT_STYLE_ID;
      (document.head || document.documentElement).appendChild(clickEffectStyle);
    }
    clickEffectStyle.textContent = `[class*="_cursorRipple_"]::after { animation-duration: ${BROWSER_CLICK_RIPPLE_DURATION_MS}ms !important; }`;

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
    assertSafePageAgentInput(element);
  }

  function assertConfirmedHighImpactClick(index, confirmed) {
    const element = indexedElement(index);
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
    assertConfirmedPageAgentClick(element, confirmed);
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
        await new Promise((resolve) => setTimeout(
          resolve,
          BROWSER_ACTION_CLEANUP_DELAY_MS,
        ));
      }
      await pageController.hideMask();
      await pageController.cleanUpHighlights();
      runtime.stateIndexed = false;
      if (runtime.activeVisualActionController === actionController) {
        runtime.activeVisualActionController = null;
      }
    }
  }

  async function handleControllerTool(tool, args = {}) {
    const pageController = getController();

    if (tool === "bridge_controller_ping") {
      return {
        success: true,
        ready: true,
        visualPreferences: runtime.visualPreferences,
        mediaElementAudioPrepared: mediaElementAudio.isPrepared(),
      };
    }

    if (tool === "bridge_prepare_media_element_audio") {
      return mediaElementAudio.prepare();
    }

    if (tool === "bridge_start_media_element_audio") {
      return mediaElementAudio.start();
    }

    if (tool === "bridge_stop_media_element_audio") {
      return mediaElementAudio.stop();
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
      const hasText = args.text !== undefined;
      const text = hasText ? String(args.text).trim() : "";
      if (hasText && !text) throw new Error("browser_scroll text must not be empty.");
      const occurrence = args.occurrence === undefined ? 1 : Number(args.occurrence);
      if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > 20) {
        throw new Error("browser_scroll occurrence must be an integer from 1 to 20.");
      }
      const alignment = args.alignment === undefined ? "center" : String(args.alignment);
      if (alignment !== "start" && alignment !== "center" && alignment !== "end") {
        throw new Error("browser_scroll alignment must be start, center, or end.");
      }
      const position = args.position === undefined ? undefined : Number(args.position);
      if (position !== undefined && (!Number.isFinite(position) || position < 0 || position > 1)) {
        throw new Error("browser_scroll position must be a number from 0 (top) to 1 (bottom).");
      }
      if (!text && position === undefined && args.direction !== "up" && args.direction !== "down") {
        throw new Error("browser_scroll requires text, direction=up/down, or an absolute position from 0 to 1.");
      }
      const direction = args.direction === "up" ? "up" : "down";
      const pages = Math.min(3, Math.max(0.25, Number(args.pages) || 0.8));
      const index = args.index === undefined ? undefined : requireIndex(args);
      if (text) {
        return withVisualAction((_activeController, signal) => scrollToTextGradually({
          text,
          occurrence,
          alignment,
          root: index === undefined ? undefined : indexedElement(index) ?? undefined,
          durationMs: runtime.visualPreferences.scrollDurationMs,
          signal,
        }));
      }
      return withVisualAction((_activeController, signal) => scrollPageGradually({
        direction,
        pages,
        position,
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
