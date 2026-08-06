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
import {
  buildSemanticAnchorContext,
  MAX_SEMANTIC_ANCHORS,
} from "./semantic-anchor-context.js";
import { createFlowRecorder } from "./flow-recorder.js";
import {
  executeRecordedFlowStep,
  findRecordedTarget,
} from "./recorded-flow-replay.js";
import {
  EXTENSION_EVENTS,
  PAGE_CONTROLLER_PROTOCOL_VERSION,
} from "../core/extension-config.js";

const CONTENT_REQUEST_SOURCE = `lumi-page-agent-service-v${PAGE_CONTROLLER_PROTOCOL_VERSION}`;
const GLOBAL_KEY = `__LUMI_PAGE_AGENT_CONTROLLER_V${PAGE_CONTROLLER_PROTOCOL_VERSION}__`;
const HIGHLIGHT_STYLE_ID = "lumi-page-agent-highlight-preference";
const CLICK_EFFECT_STYLE_ID = "lumi-page-agent-click-effect-preference";
export const FAST_PAGE_STATE_MAX_CHARACTERS = 160000;
export const FAST_SEMANTIC_CONTEXT_MAX_CHARACTERS = 80000;
export const STANDARD_SEMANTIC_CONTEXT_MAX_CHARACTERS = 24000;

async function publishRecordedFlowReplayProgress(value) {
  const runId = String(value?.runId || "").trim();
  const stepIndex = Number(value?.stepIndex);
  const completedSteps = Number(value?.completedSteps);
  if (!runId || !Number.isInteger(stepIndex) || !Number.isInteger(completedSteps)) return;
  await chrome.runtime.sendMessage({
    type: EXTENSION_EVENTS.flowReplayProgress,
    action: String(value?.action || ""),
    completedSteps: Math.max(0, completedSteps),
    message: String(value?.message || ""),
    runId,
    stepIndex: Math.max(0, stepIndex),
    totalSteps: Math.max(1, Number(value?.totalSteps) || completedSteps),
  }).catch(() => null);
}
const MAX_FAST_BATCH_ACTIONS = 200;
const MAX_FAST_SELECTION_INDICES = 300;
if (!globalThis[GLOBAL_KEY]) {
  const runtime = {
    controller: null,
    stateIndexed: false,
    visualPreferences: { ...DEFAULT_VISUAL_PREFERENCES },
    activeRecordedFlowReplayController: null,
    activeVisualActionController: null,
    fileUploadTarget: null,
  };
  globalThis[GLOBAL_KEY] = runtime;

  const mediaElementAudio = createMediaElementAudioController();
  const flowRecorder = createFlowRecorder({
    emit: (payload) => chrome.runtime.sendMessage({
      type: EXTENSION_EVENTS.flowRecordedStep,
      ...payload,
    }),
  });

  function getController() {
    if (!runtime.controller) {
      runtime.controller = new PageController({
        enableMask: !runtime.visualPreferences.fastMode,
        viewportExpansion: runtime.visualPreferences.fastMode ? -1 : 0,
        keepSemanticTags: runtime.visualPreferences.fastMode,
        highlightOpacity: 0.08,
        highlightLabelOpacity: 0.82,
        includeAttributes: [
          "aria-label",
          "aria-labelledby",
          "aria-describedby",
          "aria-expanded",
          "aria-selected",
          "aria-checked",
          "role",
          "name",
          "placeholder",
          "type",
          "title",
          "alt",
          "for",
          "id",
          "data-testid",
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

  function instantClickElement(element) {
    if (!element?.isConnected) throw new Error("The target element is no longer connected to the page.");
    if (element.disabled || element.getAttribute?.("aria-disabled") === "true") {
      throw new Error("The target element is disabled.");
    }
    const nextRect = element.getBoundingClientRect();
    const eventWindow = element.ownerDocument.defaultView || window;
    const pointerOptions = {
      bubbles: true,
      cancelable: true,
      clientX: nextRect.left + nextRect.width / 2,
      clientY: nextRect.top + nextRect.height / 2,
      pointerType: "mouse",
      button: 0,
    };
    element.focus?.({ preventScroll: true });
    element.dispatchEvent(new eventWindow.PointerEvent("pointerover", pointerOptions));
    element.dispatchEvent(new eventWindow.MouseEvent("mouseover", pointerOptions));
    element.dispatchEvent(new eventWindow.PointerEvent("pointerdown", pointerOptions));
    element.dispatchEvent(new eventWindow.MouseEvent("mousedown", pointerOptions));
    element.dispatchEvent(new eventWindow.PointerEvent("pointerup", pointerOptions));
    element.dispatchEvent(new eventWindow.MouseEvent("mouseup", pointerOptions));
    element.click();
    return {
      success: true,
      message: "Clicked instantly in Fast mode without viewport scrolling.",
      viewportChanged: false,
    };
  }

  function instantSelectOption(element, optionText) {
    if (element?.tagName !== "SELECT") throw new Error("Element is not a select control.");
    const option = Array.from(element.options).find(
      (candidate) => candidate.textContent?.trim() === optionText.trim(),
    );
    if (!option) throw new Error(`Option with text "${optionText}" was not found.`);
    element.value = option.value;
    const eventWindow = element.ownerDocument.defaultView || window;
    element.dispatchEvent(new eventWindow.Event("input", { bubbles: true }));
    element.dispatchEvent(new eventWindow.Event("change", { bubbles: true }));
    return { success: true, message: `Selected "${optionText}" instantly in Fast mode.` };
  }

  function selectedControlState(element) {
    const type = String(element?.type || "").toLowerCase();
    if (type === "checkbox" || type === "radio") return Boolean(element.checked);
    for (const attribute of ["aria-checked", "aria-pressed", "aria-selected"]) {
      const value = element?.getAttribute?.(attribute);
      if (value === "true") return true;
      if (value === "false") return false;
    }
    return null;
  }

  function prepareFastBatchActions(rawActions, confirmed, { selectionOnly = false } = {}) {
    const seenIndices = new Set();
    const enabledNativeRadioGroups = new Map();
    return rawActions.map((action, actionIndex) => {
      const index = requireIndex(action);
      if (seenIndices.has(index)) {
        throw new Error(`Batch action ${actionIndex + 1} repeats element index ${index}. Each control may appear only once per batch.`);
      }
      seenIndices.add(index);
      const element = indexedElement(index);
      if (!element || element.nodeType !== Node.ELEMENT_NODE) {
        throw new Error(`Batch action ${actionIndex + 1} targets an unavailable element.`);
      }
      const type = String(action.type || "");
      if (type === "click") {
        assertConfirmedHighImpactClick(index, confirmed);
        const desiredState = action.desiredState === "on"
          ? true
          : action.desiredState === "off" ? false : null;
        if (selectedControlState(element) === null) {
          throw new Error(`Batch action ${actionIndex + 1} must target a checkbox, radio, switch, pressed, or selected control.`);
        }
        if (desiredState === null) {
          throw new Error(`Batch action ${actionIndex + 1} requires desiredState=on/off so bulk selection is idempotent.`);
        }
        if (String(element.type || "").toLowerCase() === "radio" && desiredState === false) {
          throw new Error(`Batch action ${actionIndex + 1} cannot turn off a native radio directly. Select the intended alternative instead.`);
        }
        if (String(element.type || "").toLowerCase() === "radio" && desiredState === true) {
          const groupOwner = element.form || element.ownerDocument;
          const groupName = String(element.name || "");
          if (groupName) {
            const enabledGroups = enabledNativeRadioGroups.get(groupOwner) || new Set();
            if (enabledGroups.has(groupName)) {
              throw new Error(`Batch action ${actionIndex + 1} conflicts with another native radio in group "${groupName}".`);
            }
            enabledGroups.add(groupName);
            enabledNativeRadioGroups.set(groupOwner, enabledGroups);
          }
        }
        return { type, index, element, desiredState };
      }
      if (selectionOnly) {
        throw new Error(`Bulk selection action ${actionIndex + 1} must be a selectable click control.`);
      }
      if (type === "input") {
        assertSafeInput(index);
        if (action.text === undefined) {
          throw new Error(`Batch action ${actionIndex + 1} requires text.`);
        }
        return { type, index, element, text: String(action.text) };
      }
      if (type === "select") {
        const optionText = String(action.optionText || "").trim();
        if (!optionText) throw new Error(`Batch action ${actionIndex + 1} requires optionText.`);
        if (element.tagName !== "SELECT" || !Array.from(element.options).some(
          (option) => option.textContent?.trim() === optionText,
        )) {
          throw new Error(`Batch action ${actionIndex + 1} could not resolve option "${optionText}".`);
        }
        return { type, index, element, optionText };
      }
      throw new Error(`Batch action ${actionIndex + 1} has unsupported type "${type}".`);
    });
  }

  function batchActionMatchesExpectedState(action) {
    if (!action.element.isConnected) return false;
    if (action.type === "click") {
      return selectedControlState(action.element) === action.desiredState;
    }
    if (action.type === "input") {
      const value = action.element.isContentEditable
        ? action.element.innerText
        : action.element.value;
      return String(value ?? "") === action.text;
    }
    const selectedText = action.element.selectedOptions?.[0]?.textContent?.trim() || "";
    return selectedText === action.optionText;
  }

  async function verifyFastBatchAction(action, signal) {
    const eventWindow = action.element.ownerDocument.defaultView || window;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new DOMException("The page action was cancelled by the user.", "AbortError");
      if (batchActionMatchesExpectedState(action)) return true;
      if (!action.element.isConnected) {
        throw new Error("The page replaced this control while the batch was running.");
      }
      if (attempt === 2) break;
      if (attempt === 0) await Promise.resolve();
      else await new Promise((resolve) => eventWindow.requestAnimationFrame(resolve));
    }
    throw new Error("The control did not reach its requested value after the Fast mode action.");
  }

  async function executeFastBatch(preparedActions, args, signal) {
    const results = [];
    let failedAt = null;
    let finalVerificationFailure = false;
    for (const [actionIndex, action] of preparedActions.entries()) {
      try {
        if (!action.element.isConnected) {
          throw new Error("The page replaced this control while the batch was running.");
        }
        if (action.type === "click") {
          if (selectedControlState(action.element) === action.desiredState) {
            results.push({
              action: actionIndex + 1,
              index: action.index,
              status: "skipped",
              reason: "already_in_desired_state",
              stateVerified: true,
            });
            continue;
          }
          instantClickElement(action.element);
        } else if (action.type === "input") {
          await typeTextGradually(action.element, action.text, 0, signal);
        } else {
          instantSelectOption(action.element, action.optionText);
        }
        await verifyFastBatchAction(action, signal);
        results.push({
          action: actionIndex + 1,
          index: action.index,
          status: "executed",
          stateVerified: true,
        });
      } catch (error) {
        failedAt = actionIndex + 1;
        results.push({
          action: actionIndex + 1,
          index: action.index,
          status: "failed",
          stateVerified: false,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    if (failedAt === null) {
      const invalidFinalIndex = preparedActions.findIndex(
        (action) => !batchActionMatchesExpectedState(action),
      );
      if (invalidFinalIndex >= 0) {
        failedAt = invalidFinalIndex + 1;
        finalVerificationFailure = true;
        const result = results[invalidFinalIndex];
        result.status = "failed";
        result.stateVerified = false;
        result.error = "A later batch action changed this control after its initial verification.";
      }
    }
    const executedActionCount = results.filter((result) => result.status === "executed").length;
    const skippedActionCount = results.filter((result) => result.status === "skipped").length;
    return {
      success: true,
      completed: failedAt === null,
      requestedActionCount: preparedActions.length,
      executedActionCount,
      skippedActionCount,
      verifiedActionCount: results.filter((result) => result.stateVerified).length,
      failedAt,
      results,
      nextPageStateQuery: String(args.verificationQuery || "").trim().slice(0, 500),
      requiresPageVerification: failedAt !== null,
      message: failedAt === null
        ? `Completed and locally verified ${executedActionCount} Fast mode action(s); skipped ${skippedActionCount} already-satisfied action(s).`
        : finalVerificationFailure
          ? `Fast mode executed the batch, but final verification failed at action ${failedAt}.`
          : `Fast mode stopped at action ${failedAt} after ${executedActionCount} verified action(s).`,
    };
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
    const fullPageIndexed = runtime.visualPreferences.fastMode;
    const selectedContent = selectPageStateContent(
      state.content,
      query,
      fullPageIndexed ? FAST_PAGE_STATE_MAX_CHARACTERS : undefined,
    );
    return {
      success: true,
      ...state,
      ...selectedContent,
      fastMode: runtime.visualPreferences.fastMode,
      interactionMode: runtime.visualPreferences.fastMode ? "fast" : "standard",
      fullPageIndexed,
      viewportPolicy: fullPageIndexed ? "full_page_dom" : "visible_viewport",
    };
  }

  async function findSemanticContext(targets = [], intent = "auto") {
    const normalizedTargets = (Array.isArray(targets) ? targets : [targets])
      .map((target) => String(target || "").trim())
      .filter(Boolean)
      .slice(0, MAX_SEMANTIC_ANCHORS);
    if (!normalizedTargets.length) {
      throw new Error("browser_find_semantic_context requires at least one semantic anchor.");
    }

    applyVisualPreferences();
    const pageController = getController();
    const state = await pageController.getBrowserState();
    runtime.stateIndexed = true;
    if (!runtime.visualPreferences.showElementHighlights) {
      await pageController.cleanUpHighlights();
    }
    const semanticContext = buildSemanticAnchorContext({
      controller: pageController,
      targets: normalizedTargets,
      intent,
      maxCharacters: runtime.visualPreferences.fastMode
        ? FAST_SEMANTIC_CONTEXT_MAX_CHARACTERS
        : STANDARD_SEMANTIC_CONTEXT_MAX_CHARACTERS,
      fullPage: runtime.visualPreferences.fastMode,
    });
    const compactAnchors = semanticContext.anchors.map((anchor) => ({
      target: anchor.target,
      matched: anchor.matched,
      ambiguous: anchor.ambiguous,
      matches: anchor.matches.map((match) => ({
        score: match.score,
        method: match.method,
        contextKind: match.contextKind,
        inViewport: match.inViewport,
        actionableIndices: match.actionableIndices,
        recommendedControls: match.recommendedControls.map((control) => ({
          index: control.index,
          kind: control.kind,
          score: control.score,
          disabled: control.disabled,
          selected: control.selected,
          inViewport: control.inViewport,
          actionableWithoutScroll: runtime.visualPreferences.fastMode
            && Number.isInteger(control.index),
        })),
      })),
    }));
    return {
      success: true,
      ...state,
      content: semanticContext.content,
      semanticIntent: semanticContext.intent,
      semanticAnchors: compactAnchors,
      matchedAnchorCount: semanticContext.matchedAnchorCount,
      unmatchedTargets: semanticContext.unmatchedTargets,
      semanticContextTruncated: semanticContext.truncated,
      fastMode: runtime.visualPreferences.fastMode,
      interactionMode: runtime.visualPreferences.fastMode ? "fast" : "standard",
      fullPageIndexed: runtime.visualPreferences.fastMode,
      viewportPolicy: runtime.visualPreferences.fastMode ? "full_page_dom" : "visible_viewport",
      requiresScrollForIndexedActions: false,
    };
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
    const showVisuals = !runtime.visualPreferences.fastMode;
    if (showVisuals) await pageController.showMask();
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
      if (showVisuals && !actionController.signal.aborted) {
        await new Promise((resolve) => setTimeout(
          resolve,
          BROWSER_ACTION_CLEANUP_DELAY_MS,
        ));
      }
      if (showVisuals) await pageController.hideMask();
      await pageController.cleanUpHighlights();
      runtime.stateIndexed = false;
      if (runtime.activeVisualActionController === actionController) {
        runtime.activeVisualActionController = null;
      }
    }
  }

  async function handleControllerTool(tool, args = {}) {
    if (tool === "bridge_controller_ping") {
      return {
        success: true,
        ready: true,
        protocolVersion: PAGE_CONTROLLER_PROTOCOL_VERSION,
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
      const previousFastMode = runtime.visualPreferences.fastMode;
      runtime.visualPreferences = normalizeVisualPreferences(args);
      if (previousFastMode !== runtime.visualPreferences.fastMode && runtime.controller) {
        runtime.activeVisualActionController?.abort();
        runtime.activeVisualActionController = null;
        runtime.controller.dispose();
        runtime.controller = null;
        runtime.stateIndexed = false;
      }
      const pageController = getController();
      applyVisualPreferences();
      if (!runtime.visualPreferences.showElementHighlights) {
        await pageController.cleanUpHighlights();
      }
      return { success: true, visualPreferences: runtime.visualPreferences };
    }

    if (tool === "bridge_flow_record_start") {
      return flowRecorder.start(args.sessionId);
    }

    if (tool === "bridge_flow_record_stop") {
      return flowRecorder.stop();
    }

    if (tool === "bridge_flow_replay_step") {
      const replayStep = args.step || {};
      const replayTarget = replayStep.target || {};
      const replayLog = {
        action: String(replayStep.action || ""),
        name: String(replayTarget.name || replayTarget.label || "").slice(0, 160),
        protocolVersion: PAGE_CONTROLLER_PROTOCOL_VERSION,
        selector: String(replayTarget.selector || "").slice(0, 240),
      };
      runtime.activeRecordedFlowReplayController?.abort();
      const replayController = new AbortController();
      runtime.activeRecordedFlowReplayController = replayController;
      console.debug("[LumiFlowReplay] start", JSON.stringify(replayLog));
      try {
        const result = await executeRecordedFlowStep(replayStep, {
          confirmed: args.confirmed === true,
          signal: replayController.signal,
          timeoutMs: args.timeoutMs,
        });
        // A click can navigate quickly enough to destroy this content-script
        // response channel. Acknowledge the completed top-level step first so
        // LUMI TASK is never left waiting for an action that already happened.
        await publishRecordedFlowReplayProgress(args.replayProgress);
        console.debug("[LumiFlowReplay] success", JSON.stringify(replayLog));
        return {
          ...result,
          replayProtocolVersion: PAGE_CONTROLLER_PROTOCOL_VERSION,
          verifiedDirectReplay: true,
        };
      } catch (error) {
        console.error("[LumiFlowReplay] failed", JSON.stringify({
          ...replayLog,
          error: error instanceof Error ? error.message : "Direct replay failed.",
        }));
        throw error;
      } finally {
        if (runtime.activeRecordedFlowReplayController === replayController) {
          runtime.activeRecordedFlowReplayController = null;
        }
      }
    }

    const pageController = getController();

    if (tool === "bridge_cancel_active_action") {
      const activeActionController = runtime.activeVisualActionController;
      runtime.activeVisualActionController = null;
      activeActionController?.abort();
      const recordedFlowReplayController = runtime.activeRecordedFlowReplayController;
      runtime.activeRecordedFlowReplayController = null;
      recordedFlowReplayController?.abort();
      clearTabTransition();
      await pageController.hideMask().catch(() => {});
      await pageController.cleanUpHighlights().catch(() => {});
      runtime.stateIndexed = false;
      return { success: true, cancelled: true };
    }

    if (tool === "bridge_prepare_file_upload_target") {
      const token = String(args.token || "").trim();
      const fileNames = Array.isArray(args.fileNames) ? args.fileNames : [];
      if (!/^[a-z0-9-]{8,128}$/i.test(token)) {
        throw new Error("The file-upload target token is invalid.");
      }
      clearPreparedFileUploadTarget();
      const hasIndex = Number.isInteger(Number(args.index)) && Number(args.index) >= 0;
      const recordedMatch = hasIndex
        ? null
        : findRecordedTarget(args.recordedTarget, { documentObject: document })
          || findRecordedTarget(args.recordedTriggerTarget, { documentObject: document });
      const relatedElement = hasIndex
        ? indexedElement(requireIndex(args))
        : recordedMatch?.element || null;
      if (!relatedElement) {
        throw new Error("The recorded file-upload target is no longer available.");
      }
      const selection = chooseCompatibleFileInput(
        collectFileInputs(),
        fileNames,
        relatedElement,
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
      const hasIndex = Number.isInteger(Number(args.index)) && Number(args.index) >= 0;
      const recordedMatch = hasIndex
        ? null
        : findRecordedTarget(args.recordedTriggerTarget || args.recordedTarget, {
          documentObject: document,
        });
      const element = hasIndex ? indexedElement(requireIndex(args)) : recordedMatch?.element;
      if (!isFileUploadTrigger(element)) {
        throw new Error(
          "The indexed element is not identifiable as a file-upload control. Observe fresh page state or inspect the visible page, then use the exact final upload control.",
        );
      }
      if (hasIndex) {
        return withVisualAction((activeController) => activeController.clickElement(requireIndex(args)));
      }
      element.click();
      return { success: true, strategy: "recorded_upload_trigger" };
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
      if (runtime.visualPreferences.fastMode) {
        clearTabTransition();
        return { success: true, skipped: true, reason: "fast_mode" };
      }
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

    if (tool === "browser_find_semantic_context") {
      return findSemanticContext(args.targets, args.intent);
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
        const result = runtime.visualPreferences.fastMode
          ? instantClickElement(element)
          : await activeController.clickElement(index);
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
        if (!runtime.visualPreferences.fastMode) {
          const clickResult = await activeController.clickElement(index);
          if (clickResult?.success === false) throw new Error(clickResult.message);
        }
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
      return withVisualAction((activeController) => runtime.visualPreferences.fastMode
        ? instantSelectOption(indexedElement(index), optionText)
        : activeController.selectOption(index, optionText));
    }

    if (tool === "browser_batch_actions") {
      if (!runtime.visualPreferences.fastMode) {
        throw new Error("browser_batch_actions requires Fast mode. Enable it from the side panel or Lumi Settings.");
      }
      const actions = Array.isArray(args.actions) ? args.actions : [];
      if (!actions.length || actions.length > MAX_FAST_BATCH_ACTIONS) {
        throw new Error(`browser_batch_actions requires between 1 and ${MAX_FAST_BATCH_ACTIONS} actions.`);
      }
      const preparedActions = prepareFastBatchActions(actions, args.confirmed === true);
      return withVisualAction((_activeController, signal) =>
        executeFastBatch(preparedActions, args, signal));
    }

    if (tool === "browser_set_selection") {
      if (!runtime.visualPreferences.fastMode) {
        throw new Error("browser_set_selection requires Fast mode. Enable it from the side panel or Lumi Settings.");
      }
      const indices = Array.isArray(args.indices) ? args.indices : [];
      if (!indices.length || indices.length > MAX_FAST_SELECTION_INDICES) {
        throw new Error(`browser_set_selection requires between 1 and ${MAX_FAST_SELECTION_INDICES} indices.`);
      }
      const desiredState = args.desiredState === "on"
        ? "on"
        : args.desiredState === "off" ? "off" : null;
      if (!desiredState) throw new Error("browser_set_selection requires desiredState=on/off.");
      const preparedActions = prepareFastBatchActions(indices.map((index) => ({
        type: "click",
        index,
        desiredState,
      })), args.confirmed === true, { selectionOnly: true });
      return withVisualAction((_activeController, signal) =>
        executeFastBatch(preparedActions, args, signal));
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
        throw new Error("browser_scroll position must be a number from 0 (axis start) to 1 (axis end).");
      }
      const allowedDirections = new Set(["up", "down", "left", "right"]);
      if (!text && position === undefined && !allowedDirections.has(args.direction)) {
        throw new Error("browser_scroll requires text, direction=up/down/left/right, or an absolute position from 0 to 1.");
      }
      const direction = allowedDirections.has(args.direction) ? args.direction : "down";
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
