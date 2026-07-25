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
import {
  chooseCompatibleFileInput,
  FILE_UPLOAD_TARGET_ATTRIBUTE,
} from "./file-upload-target.js";
import { selectPageStateContent } from "./page-state-content.js";

const CONTENT_REQUEST_SOURCE = "lumi-page-agent-service";
const GLOBAL_KEY = "__LUMI_PAGE_AGENT_CONTROLLER__";
const HIGHLIGHT_STYLE_ID = "lumi-page-agent-highlight-preference";
const CLICK_EFFECT_STYLE_ID = "lumi-page-agent-click-effect-preference";
if (!globalThis[GLOBAL_KEY]) {
  const runtime = {
    controller: null,
    stateIndexed: false,
    visualPreferences: { ...DEFAULT_VISUAL_PREFERENCES },
    activeVisualActionController: null,
    fileUploadTarget: null,
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

  function collectFileInputs(root = document, inputs = [], visitedRoots = new Set()) {
    if (!root || visitedRoots.has(root)) return inputs;
    visitedRoots.add(root);
    for (const input of root.querySelectorAll?.('input[type="file"]') || []) {
      if (!inputs.includes(input)) inputs.push(input);
    }
    for (const element of root.querySelectorAll?.("*") || []) {
      if (element.shadowRoot) collectFileInputs(element.shadowRoot, inputs, visitedRoots);
      if (element.tagName !== "IFRAME") continue;
      try {
        collectFileInputs(element.contentDocument, inputs, visitedRoots);
      } catch {
        // Cross-origin frames have their own injected PageAgent controller.
      }
    }
    return inputs;
  }

  const FILE_UPLOAD_TRIGGER_PATTERN = /\b(upload|attach|browse|choose|import|file)\b|tải\s*lên|tai\s*len|đính\s*kèm|dinh\s*kem|chọn\s*(?:tệp|file)|chon\s*(?:tep|file)/i;

  function isFileInput(element) {
    return String(element?.type || element?.getAttribute?.("type") || "").toLowerCase() === "file";
  }

  function isFileUploadTrigger(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (isFileInput(element) || element.querySelector?.('input[type="file"]')) return true;

    const label = element.closest?.("label");
    const labelledControl = label?.htmlFor
      ? element.ownerDocument?.getElementById?.(label.htmlFor)
      : null;
    if (label?.querySelector?.('input[type="file"]') || isFileInput(labelledControl)) return true;

    const interactive = element.closest?.('button, [role="button"], a, label') || element;
    const descriptor = [
      interactive.textContent,
      interactive.getAttribute?.("aria-label"),
      interactive.getAttribute?.("title"),
      interactive.getAttribute?.("name"),
      interactive.getAttribute?.("id"),
      interactive.getAttribute?.("class"),
    ].filter(Boolean).join(" ");
    return FILE_UPLOAD_TRIGGER_PATTERN.test(descriptor);
  }

  function clearPreparedFileUploadTarget(token = "") {
    const target = runtime.fileUploadTarget;
    if (!target) return;
    if (!token || target.getAttribute(FILE_UPLOAD_TARGET_ATTRIBUTE) === token) {
      target.removeAttribute(FILE_UPLOAD_TARGET_ATTRIBUTE);
      runtime.fileUploadTarget = null;
    }
  }

  async function readPageState(query = "") {
    applyVisualPreferences();
    const pageController = getController();
    const state = await pageController.getBrowserState();
    runtime.stateIndexed = true;
    if (!runtime.visualPreferences.showElementHighlights) {
      await pageController.cleanUpHighlights();
    }
    const selectedContent = selectPageStateContent(state.content, query);
    return { success: true, ...state, ...selectedContent };
  }

  function getDeclarativeNewTabIntent(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    const link = element.closest?.("a[href], area[href]");
    if (link?.getAttribute("target")?.toLowerCase() === "_blank" && link.href) {
      return { url: link.href, target: "_blank", source: "link" };
    }
    return null;
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

    if (tool === "bridge_prepare_file_upload_target") {
      const index = requireIndex(args);
      const token = String(args.token || "").trim();
      const fileNames = Array.isArray(args.fileNames) ? args.fileNames : [];
      if (!/^[a-z0-9-]{8,128}$/i.test(token)) {
        throw new Error("The file-upload target token is invalid.");
      }
      clearPreparedFileUploadTarget();
      const selection = chooseCompatibleFileInput(
        collectFileInputs(),
        fileNames,
        indexedElement(index),
      );
      if (!selection.input) {
        return {
          success: true,
          prepared: false,
          candidateCount: selection.candidateCount,
          strategy: selection.strategy,
        };
      }
      selection.input.setAttribute(FILE_UPLOAD_TARGET_ATTRIBUTE, token);
      runtime.fileUploadTarget = selection.input;
      return {
        success: true,
        prepared: true,
        candidateCount: selection.candidateCount,
        strategy: selection.strategy,
        accept: selection.input.getAttribute("accept") || "",
        multiple: Boolean(selection.input.multiple),
      };
    }

    if (tool === "bridge_click_file_upload_target") {
      const index = requireIndex(args);
      const element = indexedElement(index);
      if (!isFileUploadTrigger(element)) {
        throw new Error(
          "The indexed element is not identifiable as a file-upload control. Observe fresh page state or inspect the visible page, then use the exact final upload control.",
        );
      }
      return withVisualAction((activeController) => activeController.clickElement(index));
    }

    if (tool === "bridge_finalize_file_upload_target") {
      const token = String(args.token || "").trim();
      const target = runtime.fileUploadTarget;
      if (!target || target.getAttribute(FILE_UPLOAD_TARGET_ATTRIBUTE) !== token) {
        throw new Error("The prepared file input is no longer available.");
      }
      const fileNames = Array.from(target.files || [], (file) => file.name);
      clearPreparedFileUploadTarget(token);
      if (!fileNames.length) {
        throw new Error("Chrome did not assign any local files to the prepared file input.");
      }
      return {
        success: true,
        fileCount: fileNames.length,
        fileNames,
      };
    }

    if (tool === "bridge_cleanup_file_upload_target") {
      clearPreparedFileUploadTarget(String(args.token || "").trim());
      return { success: true };
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
      return readPageState(args.query);
    }

    if (tool === "browser_wait_for_page_state") {
      const query = String(args.query || "").trim();
      if (!query) throw new Error("browser_wait_for_page_state requires exact visible text.");
      const condition = args.condition === "absent" ? "absent" : "present";
      const timeoutMs = Math.min(8000, Math.max(500, Number(args.timeoutMs) || 5000));
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        const state = await readPageState(query);
        const conditionMet = condition === "present"
          ? state.queryMatched
          : !state.queryMatched;
        if (conditionMet) {
          return {
            ...state,
            condition,
            waitedMs: Date.now() - startedAt,
          };
        }
        runtime.stateIndexed = false;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      runtime.stateIndexed = false;
      throw new Error(
        `Timed out waiting for "${query}" to become ${condition} in the semantic DOM.`,
      );
    }

    if (tool === "browser_click") {
      const index = requireIndex(args);
      assertConfirmedHighImpactClick(index, args.confirmed);
      const element = indexedElement(index);
      const videoClick = captureYouTubeVideoClick(element);
      const newTabIntent = getDeclarativeNewTabIntent(element);
      return withVisualAction(async (activeController) => {
        const result = await activeController.clickElement(index);
        const enrichedResult = newTabIntent && result?.success !== false
          ? { ...result, newTabIntent }
          : result;
        if (result?.success === false || !didClickOpenYouTubeVideo(videoClick)) {
          return enrichedResult;
        }
        return {
          ...enrichedResult,
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
