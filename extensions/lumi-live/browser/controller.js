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
  buildObservationSnapshot,
  diffObservationSnapshots,
} from "./page-context.js";
import { createPageStateTracker } from "./page-state-identity.js";
import {
  buildSemanticAnchorContext,
  MAX_SEMANTIC_ANCHORS,
  resolveSemanticSelectionScope,
} from "./semantic-anchor-context.js";

const CONTENT_REQUEST_SOURCE = "lumi-page-agent-service";
const GLOBAL_KEY = "__LUMI_PAGE_AGENT_CONTROLLER__";
const HIGHLIGHT_STYLE_ID = "lumi-page-agent-highlight-preference";
const CLICK_EFFECT_STYLE_ID = "lumi-page-agent-click-effect-preference";
const SHARED_PAGE_STATE_MAX_CHARACTERS = 48000;
const MAX_STAGE_ACTIONS = 300;
const MAX_LEGACY_BATCH_ACTIONS = 200;
const MAX_SELECTION_INDICES = 300;
const FAST_STAGE_CHUNK_SIZE = 40;
const NORMAL_STAGE_CHUNK_SIZE = 20;
const MAX_STAGE_LEDGERS = 10;
const STAGE_PROGRESS_STYLE_ID = "lumi-stage-progress-style";
if (!globalThis[GLOBAL_KEY]) {
  const runtime = {
    controller: null,
    stateIndexed: false,
    stateTracker: createPageStateTracker(),
    lastObservationSnapshot: null,
    stageLedgers: new Map(),
    stageLedgerSequence: 0,
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
        viewportExpansion: -1,
        keepSemanticTags: true,
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
    if (args?.stateId) runtime.stateTracker.assertFresh(args.stateId);
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
      message: "Clicked instantly without viewport scrolling.",
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
    return { success: true, message: `Selected "${optionText}" instantly.` };
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

  function ensureStageProgressStyle() {
    if (document.getElementById(STAGE_PROGRESS_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STAGE_PROGRESS_STYLE_ID;
    style.textContent = `
      #lumi-stage-progress {
        position: fixed;
        inset: 18px 18px auto auto;
        z-index: 2147483647;
        width: min(320px, calc(100vw - 36px));
        padding: 12px 14px;
        border: 1px solid rgba(124, 92, 214, .28);
        border-radius: 16px;
        color: #2f2450;
        background: rgba(255, 255, 255, .94);
        box-shadow: 0 16px 42px rgba(52, 37, 92, .2);
        font: 600 13px/1.4 system-ui, sans-serif;
        backdrop-filter: blur(14px);
        pointer-events: none;
      }
      #lumi-stage-progress [data-lumi-stage-label] {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
      }
      #lumi-stage-progress [data-lumi-stage-track] {
        height: 6px;
        overflow: hidden;
        border-radius: 99px;
        background: rgba(124, 92, 214, .12);
      }
      #lumi-stage-progress [data-lumi-stage-bar] {
        height: 100%;
        width: 0;
        border-radius: inherit;
        background: linear-gradient(90deg, #8a6be6, #d99bd7);
        transition: width 160ms ease;
      }
      [data-lumi-stage-active="true"] {
        outline: 3px solid rgba(138, 107, 230, .54) !important;
        outline-offset: 4px !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createStageProgress(totalActions, fastMode) {
    if (fastMode) {
      return Object.freeze({ update() {}, dispose() {} });
    }
    ensureStageProgressStyle();
    document.getElementById("lumi-stage-progress")?.remove();
    const progress = document.createElement("div");
    progress.id = "lumi-stage-progress";
    progress.setAttribute("role", "status");
    progress.innerHTML = `
      <div data-lumi-stage-label>
        <span>Applying verified form changes</span>
        <span data-lumi-stage-count>0/${totalActions}</span>
      </div>
      <div data-lumi-stage-track><div data-lumi-stage-bar></div></div>
    `;
    (document.body || document.documentElement).appendChild(progress);
    let activeElement = null;
    return Object.freeze({
      update(completed, element) {
        activeElement?.removeAttribute?.("data-lumi-stage-active");
        activeElement = element?.isConnected ? element : null;
        activeElement?.setAttribute?.("data-lumi-stage-active", "true");
        const count = progress.querySelector("[data-lumi-stage-count]");
        const bar = progress.querySelector("[data-lumi-stage-bar]");
        if (count) count.textContent = `${completed}/${totalActions}`;
        if (bar) bar.style.width = `${Math.min(100, completed / Math.max(1, totalActions) * 100)}%`;
      },
      dispose() {
        activeElement?.removeAttribute?.("data-lumi-stage-active");
        progress.remove();
      },
    });
  }

  function shouldAnimateStageAction(actionIndex, totalActions, fastMode) {
    if (fastMode) return false;
    if (totalActions <= 12) return true;
    return actionIndex < 3
      || actionIndex === totalActions - 1
      || (actionIndex + 1) % 25 === 0;
  }

  function prepareStageActions(rawActions, confirmed, { selectionOnly = false } = {}) {
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

  async function verifyStageAction(action, signal) {
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
    throw new Error("The control did not reach its requested value after the stage action.");
  }

  async function executePreparedStageAction(
    action,
    activeController,
    signal,
    { animate = false, typingDurationMs = 0 } = {},
  ) {
    if (action.type === "click") {
      if (selectedControlState(action.element) === action.desiredState) {
        return "skipped";
      }
      if (animate) await activeController.clickElement(action.index);
      else instantClickElement(action.element);
    } else if (action.type === "input") {
      if (animate) {
        const clickResult = await activeController.clickElement(action.index);
        if (clickResult?.success === false) throw new Error(clickResult.message);
      }
      await typeTextGradually(
        action.element,
        action.text,
        animate ? typingDurationMs : 0,
        signal,
      );
    } else if (animate) {
      await activeController.selectOption(action.index, action.optionText);
    } else {
      instantSelectOption(action.element, action.optionText);
    }
    await verifyStageAction(action, signal);
    return "executed";
  }

  function storeStageLedger(ledger) {
    const ledgerId = `stage-${Date.now().toString(36)}-${++runtime.stageLedgerSequence}`;
    runtime.stageLedgers.set(ledgerId, Object.freeze(ledger));
    while (runtime.stageLedgers.size > MAX_STAGE_LEDGERS) {
      runtime.stageLedgers.delete(runtime.stageLedgers.keys().next().value);
    }
    return ledgerId;
  }

  function compactStageSamples(results) {
    if (results.length <= 8) return results;
    return [
      ...results.slice(0, 4),
      { status: "omitted", count: results.length - 7 },
      ...results.slice(-3),
    ];
  }

  async function executeStage(preparedActions, args, signal, activeController, scopePreviews = []) {
    const startedAt = performance.now();
    const startState = runtime.stateTracker.assertFresh(args.stateId, {
      required: args.requireStateId === true,
    });
    if (!startState) {
      throw new Error("Observe fresh page state before applying a stage.");
    }
    const results = [];
    let failedAt = null;
    let finalVerificationFailure = false;
    let failure = null;
    let status = "complete";
    const fastExecution = runtime.visualPreferences.fastMode;
    const typingDurationMs = runtime.visualPreferences.typingDurationMs;
    const executionMode = fastExecution ? "fast" : "normal";
    const chunkSize = fastExecution
      ? FAST_STAGE_CHUNK_SIZE
      : NORMAL_STAGE_CHUNK_SIZE;
    const progress = createStageProgress(preparedActions.length, fastExecution);
    for (const [actionIndex, action] of preparedActions.entries()) {
      try {
        if (signal?.aborted) {
          throw new DOMException("The stage was cancelled by the user.", "AbortError");
        }
        runtime.stateTracker.assertDocumentStable(
          startState,
          preparedActions.slice(actionIndex).map((candidate) => candidate.element),
        );
        const actionStatus = await executePreparedStageAction(
          action,
          activeController,
          signal,
          {
            animate: shouldAnimateStageAction(
              actionIndex,
              preparedActions.length,
              fastExecution,
            ),
            typingDurationMs,
          },
        );
        results.push({
          action: actionIndex + 1,
          index: action.index,
          status: actionStatus,
          ...(actionStatus === "skipped"
            ? { reason: "already_in_desired_state" }
            : {}),
          stateVerified: true,
        });
        progress.update(actionIndex + 1, action.element);
        runtime.stateTracker.assertDocumentStable(
          startState,
          preparedActions.slice(actionIndex + 1).map((candidate) => candidate.element),
        );
        if ((actionIndex + 1) % chunkSize === 0 && actionIndex < preparedActions.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch (error) {
        failedAt = actionIndex + 1;
        failure = error;
        status = error?.name === "AbortError"
          ? "cancelled"
          : /page changed|replaced a remaining control|stale page state/i.test(String(error?.message || ""))
            ? "stale"
            : results.length ? "partial" : "failed";
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
    try {
      if (failedAt === null) {
        runtime.stateTracker.assertDocumentStable(startState);
        const invalidFinalIndex = preparedActions.findIndex(
          (action) => !batchActionMatchesExpectedState(action),
        );
        if (invalidFinalIndex >= 0) {
          failedAt = invalidFinalIndex + 1;
          finalVerificationFailure = true;
          status = "partial";
          failure = new Error(
            "A later stage action changed this control after its initial verification.",
          );
          const result = results[invalidFinalIndex];
          result.status = "failed";
          result.stateVerified = false;
          result.error = failure.message;
        }
      }
    } catch (error) {
      failedAt = failedAt ?? Math.max(1, results.length);
      failure = error;
      status = "stale";
    } finally {
      progress.dispose();
    }
    const executedActionCount = results.filter((result) => result.status === "executed").length;
    const skippedActionCount = results.filter((result) => result.status === "skipped").length;
    const verifiedActionCount = results.filter((result) => result.stateVerified).length;
    const completed = status === "complete";
    const ledgerId = storeStageLedger({
      executionMode,
      stateBefore: startState,
      scopePreviews,
      results,
      completed,
      status,
      failedAt,
    });
    const errorMessage = failure instanceof Error ? failure.message : String(failure || "");
    return {
      success: completed,
      completed,
      status,
      executionMode,
      requestedActionCount: preparedActions.length,
      executedActionCount,
      skippedActionCount,
      verifiedActionCount,
      failedAt,
      ledgerId,
      resultSamples: compactStageSamples(results),
      exceptions: results.filter((result) => result.status === "failed").slice(0, 12),
      scopePreviews,
      stateBefore: startState,
      resume: completed ? null : {
        nextActionNumber: failedAt || results.length + 1,
        completedActionCount: results.filter((result) =>
          result.status === "executed" || result.status === "skipped").length,
        remainingActionCount: Math.max(0, preparedActions.length - results.length),
        requiresFreshObservation: true,
      },
      nextPageStateQuery: String(args.verificationQuery || "").trim().slice(0, 500),
      requiresPageVerification: !completed,
      ...(completed ? {} : { error: errorMessage || "The stage did not complete." }),
      diagnostics: {
        durationMs: Math.round(performance.now() - startedAt),
        chunkSize,
        chunkCount: Math.ceil(Math.max(1, results.length) / chunkSize),
      },
      message: completed
        ? `Completed and locally verified ${executedActionCount} ${executionMode} stage action(s); skipped ${skippedActionCount} already-satisfied action(s).`
        : finalVerificationFailure
          ? `The ${executionMode} stage ran, but final verification failed at action ${failedAt}.`
          : `The ${executionMode} stage stopped with status ${status} at action ${failedAt} after ${verifiedActionCount} verified action(s).`,
    };
  }

  function expandSelectionScopes(selectionScopes = []) {
    const actions = [];
    const previews = [];
    for (const [scopeIndex, scope] of selectionScopes.entries()) {
      const resolved = resolveSemanticSelectionScope({
        controller: getController(),
        anchor: scope.anchor,
        includeText: scope.includeText,
        excludeText: scope.excludeText,
        includeDisabled: scope.includeDisabled === true,
        maxControls: MAX_SELECTION_INDICES,
      });
      if (!resolved.matched) {
        throw new Error(`Selection scope ${scopeIndex + 1} did not match "${scope.anchor}".`);
      }
      if (resolved.ambiguous) {
        throw new Error(
          `Selection scope ${scopeIndex + 1} is ambiguous. Refine "${scope.anchor}" or use explicit indices.`,
        );
      }
      if (resolved.truncated) {
        throw new Error(
          `Selection scope ${scopeIndex + 1} matched more than ${MAX_SELECTION_INDICES} controls. Refine the scope before changing anything.`,
        );
      }
      if (!resolved.indices.length) {
        throw new Error(`Selection scope ${scopeIndex + 1} contains no eligible controls.`);
      }
      previews.push({
        anchor: resolved.anchor,
        matchedText: resolved.matchedText,
        contextKind: resolved.contextKind,
        ancestry: resolved.ancestry,
        matchedControlCount: resolved.totalMatchedControls,
        excludedControlCount: resolved.excludedControlCount,
        examples: resolved.controls?.slice(0, 6) || [],
      });
      for (const index of resolved.indices) {
        actions.push({
          type: "click",
          index,
          desiredState: scope.desiredState,
        });
      }
    }
    return { actions, previews };
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

  function recordSharedObservation(pageController, fullContent) {
    const stateIdentity = runtime.stateTracker.observe();
    const snapshot = buildObservationSnapshot({
      controller: pageController,
      content: fullContent,
      state: stateIdentity,
      documentRef: document,
    });
    const pageDelta = diffObservationSnapshots(
      runtime.lastObservationSnapshot,
      snapshot,
    );
    runtime.lastObservationSnapshot = snapshot;
    runtime.stateIndexed = true;
    return {
      stateId: stateIdentity.stateId,
      documentId: stateIdentity.documentId,
      domRevision: stateIdentity.domRevision,
      observationSequence: stateIdentity.observationSequence,
      pageMap: snapshot.pageMap,
      pageDelta,
    };
  }

  async function readPageState(query = "") {
    applyVisualPreferences();
    const pageController = getController();
    const state = await pageController.getBrowserState();
    if (!runtime.visualPreferences.showElementHighlights) {
      await pageController.cleanUpHighlights();
    }
    const selectedContent = selectPageStateContent(
      state.content,
      query,
      SHARED_PAGE_STATE_MAX_CHARACTERS,
    );
    const sharedContext = recordSharedObservation(pageController, state.content);
    return {
      success: true,
      ...state,
      ...selectedContent,
      ...sharedContext,
      fastMode: runtime.visualPreferences.fastMode,
      interactionMode: runtime.visualPreferences.fastMode ? "fast" : "standard",
      contextMode: "shared_full_page",
      fullPageIndexed: true,
      viewportPolicy: "full_page_dom",
      contextDiagnostics: {
        deliveredCharacters: selectedContent.content.length,
        originalCharacters: selectedContent.originalContentLength,
        queryTargeted: Boolean(selectedContent.query),
      },
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
    if (!runtime.visualPreferences.showElementHighlights) {
      await pageController.cleanUpHighlights();
    }
    const semanticContext = buildSemanticAnchorContext({
      controller: pageController,
      targets: normalizedTargets,
      intent,
      maxCharacters: 32000,
      fullPage: true,
    });
    const sharedContext = recordSharedObservation(pageController, state.content);
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
          actionableWithoutScroll: Number.isInteger(control.index),
        })),
      })),
    }));
    return {
      success: true,
      ...state,
      ...sharedContext,
      content: semanticContext.content,
      semanticIntent: semanticContext.intent,
      semanticAnchors: compactAnchors,
      matchedAnchorCount: semanticContext.matchedAnchorCount,
      unmatchedTargets: semanticContext.unmatchedTargets,
      semanticContextTruncated: semanticContext.truncated,
      fastMode: runtime.visualPreferences.fastMode,
      interactionMode: runtime.visualPreferences.fastMode ? "fast" : "standard",
      contextMode: "shared_full_page",
      fullPageIndexed: true,
      viewportPolicy: "full_page_dom",
      requiresScrollForIndexedActions: false,
      contextDiagnostics: {
        deliveredCharacters: semanticContext.content.length,
        originalCharacters: String(state.content || "").length,
        targetCount: normalizedTargets.length,
      },
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
      runtime.stateTracker.invalidate();
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
      const pageController = getController();
      applyVisualPreferences();
      if (!runtime.visualPreferences.showElementHighlights) {
        await pageController.cleanUpHighlights();
      }
      return { success: true, visualPreferences: runtime.visualPreferences };
    }

    const pageController = getController();

    if (tool === "bridge_cancel_active_action") {
      const activeActionController = runtime.activeVisualActionController;
      runtime.activeVisualActionController = null;
      activeActionController?.abort();
      clearTabTransition();
      await pageController.hideMask().catch(() => {});
      await pageController.cleanUpHighlights().catch(() => {});
      runtime.stateIndexed = false;
      runtime.stateTracker.invalidate();
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
      runtime.stateTracker.invalidate();
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

    if (tool === "browser_apply_stage") {
      const explicitActions = Array.isArray(args.actions) ? args.actions : [];
      const selectionScopes = Array.isArray(args.selectionScopes) ? args.selectionScopes : [];
      runtime.stateTracker.assertFresh(args.stateId, { required: true });
      const expanded = expandSelectionScopes(selectionScopes);
      const actions = [...explicitActions, ...expanded.actions];
      if (!actions.length || actions.length > MAX_STAGE_ACTIONS) {
        throw new Error(`browser_apply_stage requires between 1 and ${MAX_STAGE_ACTIONS} resolved actions.`);
      }
      const preparedActions = prepareStageActions(actions, args.confirmed === true);
      return withVisualAction((activeController, signal) =>
        executeStage(
          preparedActions,
          { ...args, requireStateId: true },
          signal,
          activeController,
          expanded.previews,
        ));
    }

    if (tool === "browser_get_stage_ledger") {
      const ledgerId = String(args.ledgerId || "").trim();
      const ledger = runtime.stageLedgers.get(ledgerId);
      if (!ledger) throw new Error("The requested stage ledger is unavailable or expired.");
      const offset = Math.max(0, Math.trunc(Number(args.offset) || 0));
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(args.limit) || 40)));
      return {
        success: true,
        ledgerId,
        status: ledger.status,
        completed: ledger.completed,
        executionMode: ledger.executionMode,
        stateBefore: ledger.stateBefore,
        scopePreviews: ledger.scopePreviews,
        offset,
        limit,
        totalResults: ledger.results.length,
        results: ledger.results.slice(offset, offset + limit),
        hasMore: offset + limit < ledger.results.length,
      };
    }

    if (tool === "browser_batch_actions") {
      const actions = Array.isArray(args.actions) ? args.actions : [];
      if (!actions.length || actions.length > MAX_LEGACY_BATCH_ACTIONS) {
        throw new Error(`browser_batch_actions requires between 1 and ${MAX_LEGACY_BATCH_ACTIONS} actions.`);
      }
      const preparedActions = prepareStageActions(actions, args.confirmed === true);
      return withVisualAction((activeController, signal) =>
        executeStage(preparedActions, args, signal, activeController));
    }

    if (tool === "browser_set_selection") {
      const indices = Array.isArray(args.indices) ? args.indices : [];
      if (!indices.length || indices.length > MAX_SELECTION_INDICES) {
        throw new Error(`browser_set_selection requires between 1 and ${MAX_SELECTION_INDICES} indices.`);
      }
      const desiredState = args.desiredState === "on"
        ? "on"
        : args.desiredState === "off" ? "off" : null;
      if (!desiredState) throw new Error("browser_set_selection requires desiredState=on/off.");
      const preparedActions = prepareStageActions(indices.map((index) => ({
        type: "click",
        index,
        desiredState,
      })), args.confirmed === true, { selectionOnly: true });
      return withVisualAction((activeController, signal) =>
        executeStage(preparedActions, args, signal, activeController));
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
