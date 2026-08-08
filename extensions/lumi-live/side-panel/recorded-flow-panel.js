import {
  buildRecordedFlowAgentPrompt,
  buildRecordedFlowHybridReplayPlan,
  createRecordedFlowsExport,
  isAbsoluteRecordedFilePath,
  normalizeRecordedFilePath,
  RECORDED_STEP_GROUP_ACTION,
  recordedFlowNameKey,
  recordedFlowUploadBindingIssues,
  recordedStepTitle,
} from "../core/recorded-flows.js";
import { EXTENSION_EVENTS } from "../core/extension-config.js";

const MAX_RECORDED_FLOW_IMPORT_BYTES = 5 * 1024 * 1024;

export function recordedUploadPathState(value) {
  const path = normalizeRecordedFilePath(value);
  if (!path) return "missing";
  return isAbsoluteRecordedFilePath(path) ? "valid" : "invalid";
}

function formatUpdatedAt(timestamp) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  } catch {
    return "";
  }
}

export function recordedFlowsExportFilename(exportedAt = Date.now()) {
  const timestamp = Number(exportedAt);
  const date = new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now());
  return `lumi-recorded-flows-${date.toISOString().slice(0, 10)}.json`;
}

export function isRecordedFlowJsonFile(file) {
  return Boolean(file) && (
    String(file.name || "").toLowerCase().endsWith(".json")
    || String(file.type || "").toLowerCase().includes("json")
  );
}

export function recordedFlowJsonFilesFromTransfer(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []).filter(isRecordedFlowJsonFile);
  if (files.length) return files;
  return Array.from(dataTransfer?.items || []).flatMap((item) => {
    if (item?.kind !== "file") return [];
    try {
      const file = item.getAsFile?.();
      return isRecordedFlowJsonFile(file) ? [file] : [];
    } catch {
      return [];
    }
  });
}

export function dataTransferContainsRecordedFlowJson(dataTransfer) {
  if (recordedFlowJsonFilesFromTransfer(dataTransfer).length) return true;
  return Array.from(dataTransfer?.items || []).some((item) => {
    if (item.kind !== "file") return false;
    if (String(item.type || "").toLowerCase().includes("json")) return true;
    try {
      if (isRecordedFlowJsonFile(item.getAsFile?.())) return true;
      return String(item.webkitGetAsEntry?.()?.name || "").toLowerCase().endsWith(".json");
    } catch {
      return false;
    }
  });
}

export function downloadRecordedFlowsExport(value, {
  documentObject = document,
  BlobClass = Blob,
  urlObject = URL,
  exportedAt = Date.now(),
} = {}) {
  const payload = createRecordedFlowsExport(value, { exportedAt });
  const blob = new BlobClass([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const href = urlObject.createObjectURL(blob);
  const anchor = documentObject.createElement("a");
  anchor.href = href;
  anchor.download = recordedFlowsExportFilename(exportedAt);
  anchor.hidden = true;
  documentObject.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    urlObject.revokeObjectURL(href);
  }
  return payload;
}

export function applyRecordedStepPromptEditorView({
  button,
  promptLabel,
  prompt,
  expanded,
  focusEditor = false,
  focusButton = false,
  resizePrompt = () => {},
}) {
  if (!button || !promptLabel || !prompt) return false;
  promptLabel.hidden = !expanded;
  promptLabel.setAttribute("aria-hidden", String(!expanded));
  button.setAttribute("aria-expanded", String(expanded));
  button.textContent = expanded
    ? "− Hide prompt"
    : prompt.value.trim()
      ? "Edit prompt"
      : "+ Add prompt";

  if (expanded) resizePrompt(prompt);
  if (focusEditor) {
    prompt.focus();
    prompt.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  } else if (focusButton) {
    button.focus({ preventScroll: false });
  }
  return true;
}

function normalizedStepIndex(flow, value) {
  const maximum = Math.max(0, (flow?.steps?.length || 1) - 1);
  const index = Number(value);
  return Number.isInteger(index) ? Math.min(maximum, Math.max(0, index)) : 0;
}

export function recordedFlowReplayFailureNotice(flow, result = {}) {
  const stepIndex = normalizedStepIndex(flow, result.resumeStepIndex);
  const step = flow?.steps?.[stepIndex];
  const title = String(result.failedStepTitle || "").trim()
    || (step ? recordedStepTitle(step, stepIndex) : "Recorded action");
  const action = String(result.failedAction || step?.action || "unknown").trim();
  const reason = String(result.error || "The recorded action could not be completed.").trim();
  const batchAction = Number.isInteger(result.failedChildIndex)
    ? `, batch action ${result.failedChildIndex + 1}`
    : "";
  return `Flow “${flow?.name || "Untitled flow"}” stopped at step ${stepIndex + 1}${batchAction}: ${title}. Lumi could not perform action “${action}”. Reason: ${reason}`;
}

export function recordedFlowAgentUnavailableNotice(flow, stepIndex = 0, detail = "") {
  const index = normalizedStepIndex(flow, stepIndex);
  const reason = String(detail || "Lumi chat is not connected, is busy, or could not accept the flow request.").trim();
  return `Flow “${flow?.name || "Untitled flow"}” could not start agent processing for step ${index + 1}. ${reason}`;
}

export function recordedFlowAgentStepFailureNotice(flow, stepIndex = 0, completion = {}) {
  const index = normalizedStepIndex(flow, stepIndex);
  const step = flow?.steps?.[index];
  const reason = String(
    completion.result
      || completion.error
      || "The agent did not report a verified successful completion.",
  ).trim();
  return `Flow “${flow?.name || "Untitled flow"}” stopped at step ${index + 1}: ${step ? recordedStepTitle(step, index) : "Agent step"}. Reason: ${reason}`;
}

export function resolveRecordedFlowAgentCompletion(
  history,
  turnSequence,
  fallback = {},
) {
  const events = Array.isArray(history) ? history : [];
  const started = [...events].reverse().find((event) => (
    event?.type === "task_started"
    && event.turnSequence === turnSequence
  ));
  const done = started
    ? [...events].reverse().find((event) => (
      event?.type === "task_done"
      && event.taskId === started.taskId
    ))
    : null;
  if (done && fallback.force !== true) {
    return {
      success: done.success === true,
      result: done.result,
      evidence: done.evidence,
      reason: done.reason,
      taskId: done.taskId,
    };
  }
  return {
    success: false,
    result: fallback.result
      || "The agent turn ended without a verified structured completion.",
    reason: fallback.reason || "missing_structured_completion",
  };
}

export function renameRecordedFlowImportItem(item, name) {
  item.name = String(name ?? "");
  item.action = "rename";
  item.existingFlowId = "";
  item.selected = true;
  return item;
}

export function selectRecordedFlowImportItem(item, selected) {
  const checked = selected === true;
  if (checked && !item.ready && item.existingMatches?.length) {
    item.action = "overwrite";
    item.existingFlowId = item.existingMatches[0].id;
  } else if (!checked && item.action === "overwrite") {
    item.action = "";
    item.existingFlowId = "";
  }
  item.selected = checked;
  return item;
}

export function validateRecordedFlowImportReview(items, savedFlows) {
  const reviewItems = Array.isArray(items) ? items : [];
  const storedFlows = Array.isArray(savedFlows) ? savedFlows : [];
  const occupiedNames = new Set(storedFlows.map((flow) => recordedFlowNameKey(flow.name)));
  const overwrittenFlowIds = new Set();
  for (const item of reviewItems) {
    item.ready = false;
    item.error = "";
    if (item.action === "overwrite") {
      const existingFlow = storedFlows.find(
        (flow) => flow.id === item.existingFlowId,
      );
      if (!existingFlow || overwrittenFlowIds.has(existingFlow.id)) {
        item.error = "Choose a saved flow that is not already being overwritten.";
      } else if (recordedFlowNameKey(existingFlow.name) !== recordedFlowNameKey(item.flow.name)) {
        item.error = "The overwrite target must have the same flow name.";
      } else {
        overwrittenFlowIds.add(existingFlow.id);
        item.ready = true;
      }
    } else if (item.action === "rename") {
      const name = String(item.name || "");
      const trimmedName = name.trim();
      const nameKey = recordedFlowNameKey(trimmedName);
      if (!trimmedName) item.error = "Enter a new flow name.";
      else if (occupiedNames.has(nameKey)) item.error = "This flow name is already in use.";
      else {
        occupiedNames.add(nameKey);
        item.ready = true;
      }
    } else if (item.action === "add") {
      const nameKey = recordedFlowNameKey(item.flow.name);
      if (occupiedNames.has(nameKey)) item.error = "This flow name is already in use.";
      else {
        occupiedNames.add(nameKey);
        item.ready = true;
      }
    } else {
      item.error = item.existingMatches.length
        ? `Enter a unique name, or tick this flow to overwrite “${item.existingMatches[0].name}”.`
        : "Enter a unique name before importing this flow.";
    }
    if (!item.ready) item.selected = false;
  }
  return reviewItems;
}

export function createRecordedFlowPanel({
  documentObject = document,
  sendRuntime,
  runAgentFlow,
  prepareFlowRun = () => Promise.resolve(true),
  onFlowRunStateChange = () => {},
  setStatus,
  reportFlowEvent = () => {},
  confirmAction = () => Promise.resolve(false),
  downloadFlows = (selectedFlows) => downloadRecordedFlowsExport(selectedFlows, {
    documentObject,
  }),
}) {
  const elements = {
    topRecord: documentObject.querySelector("#flowRecordButton"),
    panel: documentObject.querySelector("#flowPanel"),
    close: documentObject.querySelector("#flowPanelClose"),
    record: documentObject.querySelector("#flowPanelRecordButton"),
    name: documentObject.querySelector("#flowNameInput"),
    recordingStatus: documentObject.querySelector("#flowRecordingStatus"),
    stepCount: documentObject.querySelector("#flowStepCount"),
    stepList: documentObject.querySelector("#flowStepList"),
    stepEmpty: documentObject.querySelector("#flowStepEmpty"),
    runDraft: documentObject.querySelector("#flowRunDraftButton"),
    libraryList: documentObject.querySelector("#flowLibraryList"),
    libraryEmpty: documentObject.querySelector("#flowLibraryEmpty"),
    importOpen: documentObject.querySelector("#flowImportOpenButton"),
    importFile: documentObject.querySelector("#flowImportFileInput"),
    importDropZone: documentObject.querySelector("#flowImportDropZone"),
    importFeedback: documentObject.querySelector("#flowImportFeedback"),
    importDialog: documentObject.querySelector("#flowImportReviewDialog"),
    importClose: documentObject.querySelector("#flowImportReviewCloseButton"),
    importCancel: documentObject.querySelector("#flowImportReviewCancelButton"),
    importConfirm: documentObject.querySelector("#flowImportConfirmButton"),
    importList: documentObject.querySelector("#flowImportReviewList"),
    importSelectionCount: documentObject.querySelector("#flowImportSelectionCount"),
    exportOpen: documentObject.querySelector("#flowExportOpenButton"),
    exportDialog: documentObject.querySelector("#flowExportDialog"),
    exportClose: documentObject.querySelector("#flowExportCloseButton"),
    exportCancel: documentObject.querySelector("#flowExportCancelButton"),
    exportConfirm: documentObject.querySelector("#flowExportConfirmButton"),
    exportSelectAll: documentObject.querySelector("#flowExportSelectAll"),
    exportList: documentObject.querySelector("#flowExportList"),
    exportSelectionCount: documentObject.querySelector("#flowExportSelectionCount"),
  };
  let draft = null;
  let flows = [];
  let busy = false;
  let activeFlowRun = null;
  let initialized = false;
  let flowRunSequence = 0;
  const promptTimers = new Map();
  const uploadPathTimers = new Map();
  const expandedPromptIds = new Set();
  const collapsedPromptIds = new Set();
  const selectedExportFlowIds = new Set();
  const importReviewRows = new Map();
  let importReviewItems = [];
  let importSavedFlows = [];
  let importSourceText = "";
  let flowImportDragDepth = 0;
  let nameTimerId = null;

  function controlsAreLocked() {
    return busy || Boolean(activeFlowRun);
  }

  function setPanelOpen(open) {
    if (!open) {
      closeExportDialog();
      closeImportDialog();
      flowImportDragDepth = 0;
      documentObject.documentElement.classList.remove("is-flow-import-dragging");
    }
    elements.panel.hidden = !open;
    elements.topRecord.setAttribute("aria-expanded", String(open));
    if (open) elements.close.focus({ preventScroll: true });
  }

  function currentPromptFocus() {
    const input = documentObject.activeElement?.closest?.("[data-flow-step-prompt]");
    if (!input) return null;
    return {
      stepId: input.dataset.flowStepPrompt,
      start: input.selectionStart,
      end: input.selectionEnd,
    };
  }

  function currentUploadPathFocus() {
    const input = documentObject.activeElement?.closest?.("[data-flow-upload-path]");
    if (!input) return null;
    return {
      end: input.selectionEnd,
      index: input.dataset.flowUploadPathIndex,
      start: input.selectionStart,
      stepId: input.dataset.flowUploadPath,
    };
  }

  function restoreUploadPathFocus(focus) {
    if (!focus?.stepId) return;
    const input = elements.stepList.querySelector(
      `[data-flow-upload-path="${CSS.escape(focus.stepId)}"]`
      + `[data-flow-upload-path-index="${CSS.escape(String(focus.index || "0"))}"]`,
    );
    if (!input) return;
    input.focus({ preventScroll: true });
    if (Number.isInteger(focus.start) && Number.isInteger(focus.end)) {
      input.setSelectionRange(focus.start, focus.end);
    }
  }

  function restorePromptFocus(focus) {
    if (!focus?.stepId) return;
    const input = elements.stepList.querySelector(
      `[data-flow-step-prompt="${CSS.escape(focus.stepId)}"]`,
    );
    if (!input) return;
    input.focus({ preventScroll: true });
    if (Number.isInteger(focus.start) && Number.isInteger(focus.end)) {
      input.setSelectionRange(focus.start, focus.end);
    }
  }

  function resizePrompt(prompt) {
    if (!prompt || prompt.hidden || prompt.closest(".flow-step-prompt")?.hidden) return;
    prompt.style.height = "auto";
    prompt.style.height = `${Math.min(Math.max(prompt.scrollHeight, 60), 150)}px`;
  }

  function setPromptEditorExpanded({
    stepId,
    button,
    promptLabel,
    prompt,
  }, expanded, { focusEditor = false, focusButton = false } = {}) {
    if (!stepId || !button || !promptLabel || !prompt) return;
    if (expanded) {
      expandedPromptIds.add(stepId);
      collapsedPromptIds.delete(stepId);
    } else {
      expandedPromptIds.delete(stepId);
      if (prompt.value.trim()) collapsedPromptIds.add(stepId);
      else collapsedPromptIds.delete(stepId);
    }

    applyRecordedStepPromptEditorView({
      button,
      promptLabel,
      prompt,
      expanded,
      focusEditor,
      focusButton,
      resizePrompt,
    });
  }

  function promptEditorFrom(element) {
    const item = element?.closest?.("[data-step-id]");
    const button = item?.querySelector("[data-flow-step-action='prompt']");
    const prompt = item?.querySelector("[data-flow-step-prompt]");
    const promptLabel = prompt?.closest(".flow-step-prompt");
    if (!item || !button || !prompt || !promptLabel) return null;
    return {
      stepId: item.dataset.stepId,
      button,
      promptLabel,
      prompt,
    };
  }

  function uploadInputsForStep(stepId) {
    return Array.from(elements.stepList.querySelectorAll(
      `[data-flow-upload-path="${CSS.escape(stepId)}"]`,
    )).sort((left, right) => (
      Number(left.dataset.flowUploadPathIndex) - Number(right.dataset.flowUploadPathIndex)
    ));
  }

  function updateUploadEditorState(editor) {
    if (!editor) return;
    const inputs = Array.from(editor.querySelectorAll("[data-flow-upload-path]"));
    const states = inputs.map((input) => {
      const state = recordedUploadPathState(input.value);
      input.dataset.state = state;
      input.setAttribute("aria-invalid", String(state === "invalid"));
      return state;
    });
    const state = states.includes("invalid")
      ? "invalid"
      : states.includes("missing") ? "missing" : "valid";
    editor.dataset.state = state;
    const feedback = editor.querySelector("[data-flow-upload-feedback]");
    if (feedback) {
      feedback.textContent = state === "missing"
        ? "Required: enter an absolute path. This path stays on this device and is not exported."
        : state === "invalid"
          ? "Use an absolute path such as C:\\Users\\you\\document.pdf or \\\\server\\share\\file.pdf."
          : "Absolute path format is valid. Lumi will verify access when the flow runs.";
    }
  }

  function createUploadEditor(step) {
    const editor = documentObject.createElement("section");
    editor.className = "flow-step-upload";
    editor.dataset.flowUploadEditor = step.id;
    const heading = documentObject.createElement("div");
    heading.className = "flow-step-upload-heading";
    const title = documentObject.createElement("strong");
    title.textContent = "Local upload path";
    const privacy = documentObject.createElement("span");
    privacy.textContent = "Stored locally only";
    heading.append(title, privacy);
    editor.append(heading);

    const fileCount = Math.max(1, step.fileVariables?.length || step.files?.length || 1);
    for (let index = 0; index < fileCount; index += 1) {
      const field = documentObject.createElement("label");
      field.className = "flow-step-upload-field";
      const file = step.files?.[index];
      const variable = step.fileVariables?.[index] || `UPLOAD_FILE_${index + 1}`;
      const label = documentObject.createElement("span");
      label.textContent = file?.name
        ? `${file.name} · \${${variable}}`
        : `File ${index + 1} · \${${variable}}`;
      const input = documentObject.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "C:\\absolute\\path\\file.ext";
      input.value = normalizeRecordedFilePath(step.localFilePaths?.[index]);
      input.disabled = controlsAreLocked();
      input.dataset.flowUploadPath = step.id;
      input.dataset.flowUploadPathIndex = String(index);
      input.setAttribute("aria-label", `Absolute local path for ${file?.name || `file ${index + 1}`}`);
      field.append(label, input);
      editor.append(field);
    }
    const feedback = documentObject.createElement("small");
    feedback.className = "flow-step-upload-feedback";
    feedback.dataset.flowUploadFeedback = step.id;
    editor.append(feedback);
    updateUploadEditorState(editor);
    return editor;
  }

  function createStepCard(step, index) {
    const hasPrompt = Boolean(String(step.prompt || "").trim());
    const promptExpanded = expandedPromptIds.has(step.id)
      || hasPrompt && !collapsedPromptIds.has(step.id);
    if (promptExpanded) expandedPromptIds.add(step.id);
    const item = documentObject.createElement("li");
    item.className = "flow-step";
    item.dataset.stepId = step.id;

    const header = documentObject.createElement("header");
    const number = documentObject.createElement("span");
    number.className = "flow-step-number";
    number.textContent = String(index + 1);
    const copy = documentObject.createElement("div");
    copy.className = "flow-step-copy";
    const title = documentObject.createElement("strong");
    title.textContent = recordedStepTitle(step, index);
    const detail = documentObject.createElement("small");
    detail.textContent = step.redacted
      ? "Sensitive input omitted"
      : step.action === RECORDED_STEP_GROUP_ACTION
        ? step.children.map((child, childIndex) => recordedStepTitle(child, childIndex)).join(" · ")
      : step.action === "fill"
        ? String(step.value ?? "").slice(0, 120)
        : step.action === "select_option"
          ? String(step.optionText || step.value || "")
          : step.action === "upload_file"
            ? (step.files || []).map((file) => file.name).join(", ") || "Local file required"
          : step.resultUrl || step.url || step.target.selector || "";
    copy.append(title, detail);

    const controls = documentObject.createElement("div");
    controls.className = "flow-step-controls";
    const promptButton = documentObject.createElement("button");
    promptButton.type = "button";
    promptButton.className = "flow-step-add-prompt";
    promptButton.dataset.flowStepAction = "prompt";
    promptButton.dataset.stepId = step.id;
    promptButton.disabled = controlsAreLocked();
    promptButton.setAttribute("aria-expanded", String(promptExpanded));
    promptButton.setAttribute("aria-controls", `flow-step-prompt-${step.id}`);
    promptButton.textContent = promptExpanded
      ? "− Hide prompt"
      : hasPrompt
        ? "Edit prompt"
        : "+ Add prompt";
    const deleteButton = documentObject.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "flow-step-delete";
    deleteButton.dataset.flowStepAction = "delete";
    deleteButton.dataset.stepId = step.id;
    deleteButton.disabled = controlsAreLocked();
    deleteButton.setAttribute("aria-label", "Delete step");
    deleteButton.title = "Delete step";
    deleteButton.textContent = "×";
    controls.append(promptButton, deleteButton);
    header.append(number, copy, controls);

    const promptLabel = documentObject.createElement("label");
    promptLabel.className = "flow-step-prompt";
    const promptTitle = documentObject.createElement("span");
    promptTitle.textContent = "Prompt instruction";
    const prompt = documentObject.createElement("textarea");
    prompt.rows = 2;
    prompt.id = `flow-step-prompt-${step.id}`;
    prompt.maxLength = 1200;
    prompt.placeholder = step.action === RECORDED_STEP_GROUP_ACTION
      ? "Describe the outcome for all grouped actions…"
      : "Optional: tell the agent how to adapt this step…";
    prompt.value = step.prompt || "";
    prompt.dataset.flowStepPrompt = step.id;
    prompt.disabled = controlsAreLocked();
    promptLabel.append(promptTitle, prompt);
    promptLabel.hidden = !promptExpanded;
    promptLabel.setAttribute("aria-hidden", String(!promptExpanded));
    promptButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setPromptEditorExpanded({
        stepId: step.id,
        button: promptButton,
        promptLabel,
        prompt,
      }, promptLabel.hidden, { focusEditor: promptLabel.hidden });
    });
    item.append(header);
    if (step.action === "upload_file") item.append(createUploadEditor(step));
    item.append(promptLabel);
    return item;
  }

  function renderDraft() {
    const focus = currentPromptFocus();
    const uploadFocus = currentUploadPathFocus();
    const hasDraft = Boolean(draft);
    const steps = draft?.steps || [];
    const recording = draft?.recording === true;
    elements.topRecord.classList.toggle("is-recording", recording);
    elements.topRecord.setAttribute("aria-label", "Open QC recorder");
    elements.topRecord.title = recording ? "QC recorder · recording" : "QC recorder";
    elements.record.classList.toggle("is-recording", recording);
    elements.record.textContent = recording
      ? "Stop recording"
      : hasDraft
        ? "Start a new recording"
        : "Start recording";
    elements.record.disabled = controlsAreLocked();
    elements.recordingStatus.dataset.state = recording ? "recording" : hasDraft ? "ready" : "empty";
    elements.recordingStatus.textContent = recording
      ? "Recording the selected browser tab. New actions are saved automatically."
      : hasDraft
        ? "Flow saved automatically. Review it or start a new recording."
        : "Start recording and interact with the web page normally.";
    elements.stepCount.textContent = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
    elements.stepEmpty.hidden = steps.length > 0;
    elements.stepList.replaceChildren(...steps.map(createStepCard));
    for (const prompt of elements.stepList.querySelectorAll("[data-flow-step-prompt]")) {
      resizePrompt(prompt);
    }
    elements.name.disabled = controlsAreLocked() || !hasDraft;
    if (documentObject.activeElement !== elements.name) elements.name.value = draft?.name || "";
    elements.runDraft.disabled = controlsAreLocked()
      || recording
      || !steps.length
      || recordedFlowUploadBindingIssues(draft).length > 0;
    if (recordedFlowUploadBindingIssues(draft).length) {
      elements.runDraft.title = "Enter a valid absolute path for every upload step before running.";
    } else {
      elements.runDraft.removeAttribute("title");
    }
    restorePromptFocus(focus);
    restoreUploadPathFocus(uploadFocus);
  }

  function createLibraryItem(flow) {
    const item = documentObject.createElement("article");
    item.className = "flow-library-item";
    item.dataset.flowId = flow.id;
    const copy = documentObject.createElement("div");
    const title = documentObject.createElement("strong");
    title.textContent = flow.name;
    const meta = documentObject.createElement("small");
    meta.textContent = `${flow.steps.length} steps · ${formatUpdatedAt(flow.updatedAt)}`;
    copy.append(title, meta);
    const actions = documentObject.createElement("div");
    actions.className = "flow-library-actions";
    for (const [action, label, className] of [
      ["run", "Run", "is-primary"],
      ["edit", "Edit", ""],
      ["delete", "Delete", "is-danger"],
    ]) {
      const button = documentObject.createElement("button");
      button.type = "button";
      button.dataset.flowLibraryAction = action;
      button.dataset.flowId = flow.id;
      button.className = className;
      button.textContent = label;
      const missingUploadPath = action === "run"
        && recordedFlowUploadBindingIssues(flow).length > 0;
      button.disabled = controlsAreLocked() || draft?.recording || missingUploadPath;
      if (missingUploadPath) {
        button.title = "Edit this flow and enter the required absolute upload path first.";
      }
      actions.append(button);
    }
    item.append(copy, actions);
    return item;
  }

  function renderLibrary() {
    elements.libraryEmpty.hidden = flows.length > 0;
    elements.libraryList.replaceChildren(...flows.map(createLibraryItem));
    elements.importOpen.disabled = controlsAreLocked();
    elements.importDropZone.disabled = controlsAreLocked();
    elements.importFile.disabled = controlsAreLocked();
    elements.exportOpen.disabled = controlsAreLocked() || flows.length === 0;
    if (elements.exportDialog.open) renderExportSelection();
    if (elements.importDialog.open) updateImportReviewControls();
  }

  function createExportOption(flow) {
    const label = documentObject.createElement("label");
    label.className = "flow-export-option";
    label.htmlFor = `flow-export-${flow.id}`;
    const checkbox = documentObject.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `flow-export-${flow.id}`;
    checkbox.dataset.flowExportId = flow.id;
    checkbox.checked = selectedExportFlowIds.has(flow.id);
    const copy = documentObject.createElement("span");
    copy.className = "flow-export-option-copy";
    const title = documentObject.createElement("strong");
    title.textContent = flow.name;
    const meta = documentObject.createElement("small");
    meta.textContent = `${flow.steps.length} ${flow.steps.length === 1 ? "step" : "steps"} · ${formatUpdatedAt(flow.updatedAt)}`;
    copy.append(title, meta);
    label.append(checkbox, copy);
    return label;
  }

  function renderExportSelection() {
    const availableIds = new Set(flows.map((flow) => flow.id));
    for (const flowId of selectedExportFlowIds) {
      if (!availableIds.has(flowId)) selectedExportFlowIds.delete(flowId);
    }
    elements.exportList.replaceChildren(...flows.map(createExportOption));
    updateExportSelectionControls();
  }

  function updateExportSelectionControls() {
    const selectedCount = selectedExportFlowIds.size;
    elements.exportSelectAll.checked = flows.length > 0 && selectedCount === flows.length;
    elements.exportSelectAll.indeterminate = selectedCount > 0 && selectedCount < flows.length;
    elements.exportSelectAll.disabled = flows.length === 0;
    elements.exportConfirm.disabled = busy || selectedCount === 0;
    elements.exportSelectionCount.textContent = `${selectedCount} ${selectedCount === 1 ? "flow" : "flows"} selected`;
  }

  function closeExportDialog() {
    if (elements.exportDialog.open) elements.exportDialog.close();
  }

  async function openExportDialog() {
    if (draft) await flushEditorChanges();
    const state = await sendRuntime("flow_record_status");
    draft = state.draft;
    flows = state.flows || [];
    if (!flows.length) throw new Error("There are no saved flows to export.");
    selectedExportFlowIds.clear();
    for (const flow of flows) selectedExportFlowIds.add(flow.id);
    renderExportSelection();
    if (!elements.exportDialog.open) elements.exportDialog.showModal();
    elements.exportSelectAll.focus({ preventScroll: true });
  }

  async function exportSelectedFlows() {
    const selectedFlows = flows.filter((flow) => selectedExportFlowIds.has(flow.id));
    if (!selectedFlows.length) throw new Error("Select at least one saved flow to export.");
    await downloadFlows(selectedFlows);
    closeExportDialog();
    setStatus(`Exported ${selectedFlows.length} saved ${selectedFlows.length === 1 ? "flow" : "flows"}.`);
  }

  function validateImportReview() {
    validateRecordedFlowImportReview(importReviewItems, importSavedFlows);
  }

  function createImportReviewRow(item) {
    const row = documentObject.createElement("article");
    row.className = "flow-import-review-item";
    row.dataset.flowImportReviewId = item.flow.id;
    const main = documentObject.createElement("div");
    main.className = "flow-import-review-main";
    const checkbox = documentObject.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.flowImportSelect = item.flow.id;
    checkbox.setAttribute("aria-label", `Import ${item.flow.name}`);
    const copy = documentObject.createElement("div");
    copy.className = "flow-import-review-copy";
    const title = documentObject.createElement("strong");
    title.textContent = item.flow.name;
    const meta = documentObject.createElement("small");
    meta.textContent = `${item.flow.steps.length} ${item.flow.steps.length === 1 ? "step" : "steps"} · ${formatUpdatedAt(item.flow.updatedAt)}`;
    copy.append(title, meta);
    const badge = documentObject.createElement("span");
    badge.className = "flow-import-review-badge";
    main.append(checkbox, copy, badge);

    const resolution = documentObject.createElement("div");
    resolution.className = "flow-import-resolution";
    const rename = documentObject.createElement("input");
    rename.type = "text";
    rename.className = "flow-import-rename";
    rename.maxLength = 120;
    rename.dataset.flowImportRename = item.flow.id;
    rename.setAttribute("aria-label", `New name for ${item.flow.name}`);
    rename.placeholder = "Enter a unique name, or tick above to overwrite";
    const error = documentObject.createElement("small");
    error.className = "flow-import-error";
    resolution.append(rename, error);
    row.append(main, resolution);
    importReviewRows.set(item.flow.id, {
      badge,
      checkbox,
      error,
      rename,
      resolution,
      row,
    });
    return row;
  }

  function updateImportReviewControls() {
    validateImportReview();
    let selectedCount = 0;
    for (const item of importReviewItems) {
      const controls = importReviewRows.get(item.flow.id);
      if (!controls) continue;
      const willOverwrite = item.ready && item.action === "overwrite";
      controls.row.classList.toggle("is-conflict", !item.ready || willOverwrite);
      controls.row.classList.toggle("is-ready", item.ready && !willOverwrite);
      controls.checkbox.checked = item.selected;
      controls.checkbox.disabled = busy || (!item.ready && !item.existingMatches.length);
      controls.rename.hidden = !item.hadNameConflict;
      if (controls.rename.value !== item.name) controls.rename.value = item.name;
      controls.rename.disabled = busy;
      controls.resolution.hidden = !item.hadNameConflict;
      controls.error.hidden = item.ready;
      controls.error.textContent = item.error;
      controls.badge.textContent = willOverwrite
        ? "Will overwrite"
        : item.ready
          ? item.action === "rename"
            ? item.selected ? "Renamed · selected" : "Renamed · ready"
            : item.selected ? "Selected" : "Ready"
          : item.existingMatches.length ? "Name conflict · tick to overwrite" : "Name conflict";
      if (item.selected && item.ready) selectedCount += 1;
    }
    elements.importSelectionCount.textContent = `${selectedCount} ${selectedCount === 1 ? "flow" : "flows"} selected`;
    elements.importConfirm.disabled = busy || selectedCount === 0;
  }

  function renderImportReview() {
    validateImportReview();
    importReviewRows.clear();
    elements.importList.replaceChildren(...importReviewItems.map(createImportReviewRow));
    updateImportReviewControls();
  }

  function closeImportDialog() {
    if (elements.importDialog.open) elements.importDialog.close();
    importReviewItems = [];
    importSavedFlows = [];
    importSourceText = "";
    importReviewRows.clear();
  }

  function setImportFeedback(message = "", state = "ready") {
    elements.importFeedback.hidden = !message;
    elements.importFeedback.dataset.state = state;
    elements.importFeedback.textContent = message;
  }

  async function reviewImportFile(file) {
    setImportFeedback("Reading and validating the flow export…", "loading");
    try {
      await prepareImportReview(file);
      setImportFeedback();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Could not review this flow export.";
      setImportFeedback(message, "error");
      throw error;
    }
  }

  async function prepareImportReview(file) {
    if (!file) return;
    if (file.size > MAX_RECORDED_FLOW_IMPORT_BYTES) {
      throw new Error("The selected flow export is larger than 5 MB.");
    }
    const sourceText = await file.text();
    const preview = await sendRuntime("flow_record_import_preview", {
      exportData: sourceText,
    });
    importSourceText = sourceText;
    importSavedFlows = preview.savedFlows || [];
    flows = importSavedFlows;
    const importedFlows = preview.importedFlows || [];
    const importedNameCounts = new Map();
    for (const flow of importedFlows) {
      const nameKey = recordedFlowNameKey(flow.name);
      importedNameCounts.set(nameKey, (importedNameCounts.get(nameKey) || 0) + 1);
    }
    importReviewItems = importedFlows.map((flow) => {
      const nameKey = recordedFlowNameKey(flow.name);
      const existingMatches = importSavedFlows.filter(
        (savedFlow) => recordedFlowNameKey(savedFlow.name) === nameKey,
      );
      const hadNameConflict = existingMatches.length > 0
        || (importedNameCounts.get(nameKey) || 0) > 1;
      return {
        action: hadNameConflict ? "" : "add",
        error: "",
        existingFlowId: "",
        existingMatches,
        flow,
        hadNameConflict,
        name: flow.name,
        ready: !hadNameConflict,
        selected: !hadNameConflict,
      };
    });
    setPanelOpen(true);
    renderImportReview();
    if (!elements.importDialog.open) elements.importDialog.showModal();
    const firstControl = elements.importList.querySelector(
      "[data-flow-import-rename], [data-flow-import-select]:not(:disabled)",
    );
    firstControl?.focus({ preventScroll: true });
  }

  async function commitImportReview() {
    const resolutions = importReviewItems
      .filter((item) => item.selected && item.ready)
      .map((item) => ({
        action: item.action,
        existingFlowId: item.existingFlowId,
        flowId: item.flow.id,
        name: item.action === "rename" ? String(item.name || "").trim() : undefined,
      }));
    if (!resolutions.length) throw new Error("Select at least one reviewed flow to import.");
    const result = await sendRuntime("flow_record_import", {
      exportData: importSourceText,
      resolutions,
    });
    flows = result.flows || [];
    draft = result.draft;
    closeImportDialog();
    const importedCount = Number(result.importedCount) || 0;
    const addedCount = Number(result.addedCount) || 0;
    const updatedCount = Number(result.updatedCount) || 0;
    setStatus(
      `Imported ${importedCount} saved ${importedCount === 1 ? "flow" : "flows"}: ${addedCount} added, ${updatedCount} overwritten.`,
    );
  }

  function render() {
    renderDraft();
    renderLibrary();
  }

  async function withBusy(work, fallbackMessage) {
    if (busy) return null;
    busy = true;
    try {
      return await work();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : fallbackMessage);
      return null;
    } finally {
      busy = false;
      render();
    }
  }

  async function refresh() {
    const state = await sendRuntime("flow_record_status");
    draft = state.draft;
    flows = state.flows || [];
    render();
  }

  function acceptFlowState(result) {
    if (result && Object.hasOwn(result, "draft")) draft = result.draft || null;
    if (Array.isArray(result?.flows)) flows = result.flows;
    return result;
  }

  async function toggleRecording() {
    if (draft?.recording) {
      const result = await sendRuntime("flow_record_stop");
      draft = result.draft;
      setStatus(`Recording stopped. ${draft?.steps?.length || 0} steps saved automatically.`);
      render();
      return;
    }
    if (draft) await flushEditorChanges();
    if (draft) await sendRuntime("flow_record_clear");
    const result = await sendRuntime("flow_record_start");
    draft = result.draft;
    expandedPromptIds.clear();
    collapsedPromptIds.clear();
    setPanelOpen(true);
    setStatus("Recording browser actions. Interact with the page normally.");
    render();
  }

  async function closePanel() {
    if (draft) await flushEditorChanges();
    if (draft?.recording) {
      const result = await sendRuntime("flow_record_stop");
      draft = result.draft;
    }
    if (draft && !draft.steps?.length) {
      await sendRuntime("flow_record_clear");
      draft = null;
    }
    setPanelOpen(false);
  }

  async function flushEditorChanges() {
    if (!draft) return;
    clearTimeout(nameTimerId);
    nameTimerId = null;
    for (const timerId of promptTimers.values()) clearTimeout(timerId);
    promptTimers.clear();
    for (const timerId of uploadPathTimers.values()) clearTimeout(timerId);
    uploadPathTimers.clear();
    let result = await sendRuntime("flow_record_update", {
      name: elements.name.value.trim(),
    });
    acceptFlowState(result);
    for (const prompt of elements.stepList.querySelectorAll("[data-flow-step-prompt]")) {
      result = await sendRuntime("flow_record_update", {
        stepId: prompt.dataset.flowStepPrompt,
        prompt: prompt.value,
      });
      acceptFlowState(result);
    }
    for (const editor of elements.stepList.querySelectorAll("[data-flow-upload-editor]")) {
      result = await sendRuntime("flow_record_update", {
        localFilePaths: Array.from(editor.querySelectorAll("[data-flow-upload-path]"))
          .map((input) => input.value),
        stepId: editor.dataset.flowUploadEditor,
      });
      acceptFlowState(result);
    }
  }

  async function freshSavedFlowForRun(flow) {
    if (draft?.flowId === flow.id) await flushEditorChanges();
    const state = acceptFlowState(await sendRuntime("flow_record_status"));
    const freshFlow = state.flows?.find((candidate) => candidate.id === flow.id);
    if (!freshFlow) throw new Error(`Saved flow “${flow.name}” is no longer available.`);
    return freshFlow;
  }

  function publishFlowEvent(kind, message, flow, run = null, details = {}) {
    try {
      reportFlowEvent({
        flow,
        kind,
        message,
        runId: run?.id || "",
        stepIndex: Number.isInteger(details.stepIndex)
          ? details.stepIndex
          : run?.currentStepIndex || 0,
        completedSteps: Number.isInteger(details.completedSteps)
          ? details.completedSteps
          : run?.completedSteps || 0,
        totalSteps: run?.flow?.steps?.length || flow?.steps?.length || 0,
        phase: details.phase || "",
        stepState: details.stepState || "",
      });
    } catch {
      // Status text below remains the minimum visible fallback.
    }
  }

  async function startAgentFlow(
    run,
    prompt,
    stepIndex,
    unavailableDetail = "",
    onComplete = () => {},
  ) {
    const { flow } = run;
    let started = false;
    let failureDetail = unavailableDetail;
    try {
      started = await runAgentFlow(flow, prompt, { onComplete });
    } catch (error) {
      failureDetail = error instanceof Error ? error.message : unavailableDetail;
    }
    if (started) {
      setStatus(`Agent processing “${flow.name}” at prompted step ${stepIndex + 1}.`);
      publishFlowEvent(
        "progress",
        `Step ${stepIndex + 1} of ${flow.steps.length} · Agent prompt`,
        flow,
        run,
        { phase: "agent", stepIndex, stepState: "running" },
      );
      return true;
    }
    const notice = recordedFlowAgentUnavailableNotice(flow, stepIndex, failureDetail);
    setStatus(notice);
    publishFlowEvent("error", notice, flow, run, {
      phase: "agent",
      stepIndex,
      stepState: "failed",
    });
    setPanelOpen(false);
    return false;
  }

  function finishFlowRun(run) {
    if (activeFlowRun !== run) return;
    activeFlowRun = null;
    try {
      onFlowRunStateChange(false, run.flow);
    } catch {
      // Flow controls still unlock even if the host UI callback fails.
    }
    render();
  }

  async function cancelActiveRun() {
    const run = activeFlowRun;
    if (!run) return false;
    activeFlowRun = null;
    const notice = `Stopped flow “${run.flow.name}” at step ${run.currentStepIndex + 1}.`;
    setStatus(notice);
    publishFlowEvent("cancelled", notice, run.flow, run, {
      completedSteps: run.completedSteps,
      phase: "cancelled",
      stepIndex: run.currentStepIndex,
      stepState: "cancelled",
    });
    try {
      onFlowRunStateChange(false, run.flow);
    } catch {
      // Cancellation still proceeds when the host UI callback fails.
    }
    render();
    await sendRuntime("cancel_active_browser_action").catch(() => null);
    return true;
  }

  function stopFlowRun(run, stepIndex, completion) {
    if (activeFlowRun !== run) return;
    const notice = recordedFlowAgentStepFailureNotice(run.flow, stepIndex, completion);
    setStatus(notice);
    publishFlowEvent("error", notice, run.flow, run, {
      phase: "agent",
      stepIndex,
      stepState: "failed",
    });
    setPanelOpen(false);
    finishFlowRun(run);
  }

  function segmentAtStep(plan, stepIndex) {
    return plan.segments.find((segment) => (
      stepIndex >= segment.startStepIndex
      && stepIndex < segment.endStepIndex
    )) || null;
  }

  async function stopUnexpectedFlowRun(run, stepIndex, error) {
    const index = normalizedStepIndex(run.flow, stepIndex);
    const detail = error instanceof Error ? error.message : "Hybrid replay could not continue.";
    if (segmentAtStep(run.plan, index)?.type === "direct") {
      stopDirectFlowRun(run, index, {
        error: detail,
        resumeStepIndex: index,
      });
      return false;
    }
    stopFlowRun(run, index, { error: detail });
    return false;
  }

  function createDirectSegmentFlow(flow, startStepIndex, endStepIndex) {
    return {
      ...flow,
      startUrl: startStepIndex === 0 ? flow.startUrl : "",
      startTitle: startStepIndex === 0 ? flow.startTitle : "",
      steps: flow.steps.slice(startStepIndex, endStepIndex),
    };
  }

  function continueAfterAgent(run, stepIndex, completion) {
    if (activeFlowRun !== run) return;
    if (completion?.success !== true) {
      stopFlowRun(run, stepIndex, completion);
      return;
    }
    run.completedSteps = Math.max(run.completedSteps, stepIndex + 1);
    publishFlowEvent(
      "progress",
      `Completed prompted step ${stepIndex + 1}.`,
      run.flow,
      run,
      {
        completedSteps: stepIndex + 1,
        phase: "agent",
        stepIndex,
        stepState: "completed",
      },
    );
    setStatus(`Agent completed prompted step ${stepIndex + 1}; continuing direct replay…`);
    void continueFlowRun(run, stepIndex + 1).catch((error) => {
      void stopUnexpectedFlowRun(run, stepIndex + 1, error);
    });
  }

  async function startSingleAgentStep(run, stepIndex) {
    const prompt = buildRecordedFlowAgentPrompt(run.flow, {
      startStepIndex: stepIndex,
      endStepIndex: stepIndex,
    });
    const started = await startAgentFlow(
      run,
      prompt,
      stepIndex,
      "The prompted step requires Lumi chat, but the agent request could not start.",
      (completion) => continueAfterAgent(run, stepIndex, completion),
    );
    if (!started) finishFlowRun(run);
    return started;
  }

  function stopDirectFlowRun(run, stepIndex, result = {}) {
    if (activeFlowRun !== run) return;
    const notice = recordedFlowReplayFailureNotice(run.flow, {
      ...result,
      resumeStepIndex: stepIndex,
    });
    setStatus(notice);
    publishFlowEvent("error", notice, run.flow, run, {
      completedSteps: run.completedSteps,
      phase: "direct",
      stepIndex,
      stepState: "failed",
    });
    setPanelOpen(false);
    finishFlowRun(run);
  }

  async function continueFlowRun(run, nextStepIndex) {
    if (activeFlowRun !== run) return false;
    if (nextStepIndex >= run.flow.steps.length) {
      run.completedSteps = run.flow.steps.length;
      const completionNotice = `Completed flow “${run.flow.name}” (${run.flow.steps.length} steps).`;
      setStatus(completionNotice);
      publishFlowEvent("success", completionNotice, run.flow, run, {
        completedSteps: run.flow.steps.length,
        phase: "complete",
        stepIndex: Math.max(0, run.flow.steps.length - 1),
        stepState: "completed-all",
      });
      finishFlowRun(run);
      return true;
    }
    run.currentStepIndex = nextStepIndex;
    run.completedSteps = Math.max(run.completedSteps, nextStepIndex);

    const segment = segmentAtStep(run.plan, nextStepIndex);
    if (!segment) {
      throw new Error(`No replay segment exists for step ${nextStepIndex + 1}.`);
    }
    if (segment.type === "agent") {
      setStatus(`Step ${nextStepIndex + 1} has a prompt; the agent will process only this step…`);
      publishFlowEvent(
        "progress",
        `Step ${nextStepIndex + 1} of ${run.flow.steps.length} · Agent prompt`,
        run.flow,
        run,
        { phase: "agent", stepIndex: nextStepIndex, stepState: "running" },
      );
      return startSingleAgentStep(run, nextStepIndex);
    }

    const directFlow = createDirectSegmentFlow(
      run.flow,
      nextStepIndex,
      segment.endStepIndex,
    );
    const directRange = nextStepIndex + 1 === segment.endStepIndex
      ? `step ${nextStepIndex + 1}`
      : `steps ${nextStepIndex + 1}–${segment.endStepIndex}`;
    setStatus(`Running ${directRange} of “${run.flow.name}” directly from saved locators…`);
    publishFlowEvent(
      "progress",
      `${directRange[0].toUpperCase()}${directRange.slice(1)} · Direct replay`,
      run.flow,
      run,
      { phase: "direct", stepIndex: nextStepIndex, stepState: "running" },
    );
    let directResult;
    try {
      directResult = await sendRuntime("flow_record_run_direct", {
        flow: directFlow,
        replayContext: {
          runId: run.id,
          startStepIndex: nextStepIndex,
          totalSteps: run.flow.steps.length,
          uploadAuthorization: run.uploadAuthorization,
        },
      });
    } catch (error) {
      directResult = {
        success: false,
        completedSteps: 0,
        completedFlowSteps: 0,
        error: error instanceof Error ? error.message : "Direct replay could not start.",
        resumeStepIndex: 0,
      };
    }
    if (!directResult || typeof directResult !== "object") {
      directResult = {
        success: false,
        completedSteps: 0,
        completedFlowSteps: 0,
        error: "Direct replay returned no verifiable result.",
        resumeStepIndex: 0,
      };
    }
    if (activeFlowRun !== run) return false;
    const completedDirectSteps = Math.max(
      0,
      Number(directResult.completedFlowSteps ?? directResult.completedSteps) || 0,
    );
    const completedDirectEnd = Math.min(
      segment.endStepIndex,
      nextStepIndex + completedDirectSteps,
    );
    run.completedSteps = Math.max(run.completedSteps, completedDirectEnd);
    for (let completedStepIndex = nextStepIndex;
      completedStepIndex < completedDirectEnd;
      completedStepIndex += 1) {
      if (run.reportedDirectStepIndexes.has(completedStepIndex)) continue;
      run.reportedDirectStepIndexes.add(completedStepIndex);
      publishFlowEvent(
        "progress",
        `Completed step ${completedStepIndex + 1} of ${run.flow.steps.length} directly.`,
        run.flow,
        run,
        {
          completedSteps: completedStepIndex + 1,
          phase: "direct",
          stepIndex: completedStepIndex,
          stepState: "completed",
        },
      );
    }
    if (directResult.success && directResult.completed) {
      return continueFlowRun(run, segment.endStepIndex);
    }

    const relativeFailureIndex = normalizedStepIndex(
      directFlow,
      directResult.resumeStepIndex,
    );
    const failedStepIndex = nextStepIndex + relativeFailureIndex;
    const translatedResult = {
      ...directResult,
      resumeStepIndex: failedStepIndex,
    };
    stopDirectFlowRun(run, failedStepIndex, translatedResult);
    return false;
  }

  function recordedUploadSteps(flow) {
    return (flow?.steps || []).flatMap((step, stepIndex) => {
      const children = step.action === RECORDED_STEP_GROUP_ACTION ? step.children || [] : [step];
      return children.flatMap((child) => {
        if (child.action !== "upload_file") return [];
        let destinationOrigin = "";
        try {
          destinationOrigin = new URL(child.url || step.url || flow.startUrl).origin;
        } catch {
          // Validation in the background rejects an upload without an exact web origin.
        }
        return [{
          destinationOrigins: destinationOrigin ? [destinationOrigin] : [],
          filePaths: Array.from(child.localFilePaths || [], (path) => String(path).trim()),
          stepId: child.id,
          stepIndex,
        }];
      });
    });
  }

  function recordedUploadDestinationOrigins(flow) {
    const origins = new Set();
    const add = (value) => {
      try {
        const url = new URL(String(value || ""));
        if (["http:", "https:"].includes(url.protocol)) origins.add(url.origin);
      } catch {
        // The confirmation falls back to the current flow page when no URL was recorded.
      }
    };
    add(flow?.startUrl);
    for (const step of flow?.steps || []) {
      add(step.url);
      add(step.resultUrl);
    }
    return [...origins];
  }

  async function authorizeRecordedUploads(flow) {
    const uploads = recordedUploadSteps(flow);
    if (!uploads.length) return null;
    const destinationOrigins = recordedUploadDestinationOrigins(flow);
    const pathLines = uploads.flatMap((upload) => upload.filePaths.map(
      (filePath) => `Step ${upload.stepIndex + 1}: ${filePath}`,
    ));
    const destinationText = destinationOrigins.length
      ? destinationOrigins.join(", ")
      : "the current browser page used by this flow";
    const confirmed = await confirmAction({
      confirmLabel: "Run and upload files",
      message: [
        "Running this flow will transmit these local files:",
        ...pathLines,
        `Destination page(s): ${destinationText}`,
        "Only continue if every path and destination is expected.",
      ].join("\n"),
      title: "Authorize recorded file upload?",
    });
    if (!confirmed) return false;
    return {
      confirmedAt: Date.now(),
      destinationOrigins,
      entries: uploads.map((upload) => ({
        destinationOrigins: upload.destinationOrigins,
        filePaths: upload.filePaths,
        stepId: upload.stepId,
      })),
      flowId: String(flow.id || ""),
    };
  }

  async function runFlow(flow) {
    if (activeFlowRun) {
      setStatus(`Flow “${activeFlowRun.flow.name}” is still running.`);
      return false;
    }
    const plan = buildRecordedFlowHybridReplayPlan(flow);
    if (!plan.flow || !plan.segments.length) {
      setStatus(plan.reason || "This recorded flow has no steps to run.");
      return false;
    }
    const uploadIssues = recordedFlowUploadBindingIssues(plan.flow);
    if (uploadIssues.length) {
      const issue = uploadIssues[0];
      setStatus(
        `Step ${issue.stepIndex + 1} needs a valid absolute local file path before this flow can run.`,
      );
      setPanelOpen(true);
      const input = elements.stepList.querySelector(
        `[data-flow-upload-path="${CSS.escape(issue.stepId)}"]`,
      );
      input?.focus({ preventScroll: false });
      return false;
    }
    const uploadAuthorization = await authorizeRecordedUploads(plan.flow);
    if (uploadAuthorization === false) {
      setStatus("Recorded flow cancelled before any local file was uploaded.");
      setPanelOpen(true);
      return false;
    }
    setStatus(`Opening a new chat for “${plan.flow.name}”…`);
    let chatPrepared = false;
    try {
      chatPrepared = await prepareFlowRun(plan.flow) === true;
    } catch (error) {
      setStatus(error instanceof Error
        ? error.message
        : "Lumi could not open a new chat for this flow.");
    }
    if (!chatPrepared) {
      setPanelOpen(true);
      return false;
    }
    const run = {
      completedSteps: 0,
      currentStepIndex: 0,
      flow: plan.flow,
      id: `recorded-flow-run-${Date.now()}-${++flowRunSequence}`,
      plan,
      reportedDirectStepIndexes: new Set(),
      uploadAuthorization,
    };
    activeFlowRun = run;
    try {
      onFlowRunStateChange(true, run.flow);
    } catch {
      // The replay remains valid even if the host cannot lock chat navigation.
    }
    setPanelOpen(false);
    const promptedStepCount = plan.segments
      .filter((segment) => segment.type === "agent")
      .reduce((total, segment) => total + segment.endStepIndex - segment.startStepIndex, 0);
    const directStepCount = run.flow.steps.length - promptedStepCount;
    publishFlowEvent(
      "start",
      `Run saved flow “${run.flow.name}” (${run.flow.steps.length} steps · ${directStepCount} direct · ${promptedStepCount} prompt)`,
      run.flow,
      run,
      {
        completedSteps: 0,
        phase: "start",
        stepIndex: 0,
        stepState: "pending",
      },
    );
    try {
      return await continueFlowRun(run, 0);
    } catch (error) {
      return await stopUnexpectedFlowRun(run, run.currentStepIndex, error);
    }
  }

  function onRuntimeMessage(message) {
    if (message?.type === EXTENSION_EVENTS.flowReplayProgress) {
      const run = activeFlowRun;
      if (!run || message.runId !== run.id) return false;
      const incomingCompletedSteps = Number(message.completedSteps) || 0;
      const incomingStepIndex = normalizedStepIndex(run.flow, message.stepIndex);
      if (run.reportedDirectStepIndexes.has(incomingStepIndex)) return false;
      run.reportedDirectStepIndexes.add(incomingStepIndex);
      const completedSteps = Math.min(
        run.flow.steps.length,
        Math.max(run.completedSteps, incomingCompletedSteps),
      );
      run.completedSteps = completedSteps;
      run.currentStepIndex = Math.min(
        run.flow.steps.length - 1,
        Math.max(run.currentStepIndex, incomingStepIndex),
      );
      const progressMessage = String(message.message || "").trim()
        || `Completed ${completedSteps} of ${run.flow.steps.length} steps.`;
      setStatus(progressMessage);
      publishFlowEvent("progress", progressMessage, run.flow, run, {
        completedSteps,
        phase: "direct",
        stepIndex: incomingStepIndex,
        stepState: "completed",
      });
      return false;
    }
    if (message?.type !== EXTENSION_EVENTS.flowRecordingChanged) return false;
    const incoming = message.draft || null;
    const sameDraft = draft
      && incoming
      && draft.sessionId === incoming.sessionId
      && draft.flowId === incoming.flowId;
    if (sameDraft) {
      incoming.name = elements.name.value || incoming.name;
      for (const prompt of elements.stepList.querySelectorAll("[data-flow-step-prompt]")) {
        const step = incoming.steps.find(
          (candidate) => candidate.id === prompt.dataset.flowStepPrompt,
        );
        if (step) step.prompt = prompt.value;
      }
      for (const editor of elements.stepList.querySelectorAll("[data-flow-upload-editor]")) {
        const step = incoming.steps.find(
          (candidate) => candidate.id === editor.dataset.flowUploadEditor,
        );
        if (step) {
          step.localFilePaths = Array.from(editor.querySelectorAll("[data-flow-upload-path]"))
            .map((input) => input.value);
        }
      }
    }
    draft = incoming;
    if (Array.isArray(message.flows)) flows = message.flows;
    render();
    return false;
  }

  function schedulePromptUpdate(stepId, prompt) {
    clearTimeout(promptTimers.get(stepId));
    promptTimers.set(stepId, setTimeout(() => {
      promptTimers.delete(stepId);
      void sendRuntime("flow_record_update", { stepId, prompt })
        .then((result) => {
          acceptFlowState(result);
        })
        .catch((error) => setStatus(error.message));
    }, 280));
  }

  function scheduleUploadPathUpdate(stepId) {
    clearTimeout(uploadPathTimers.get(stepId));
    uploadPathTimers.set(stepId, setTimeout(() => {
      uploadPathTimers.delete(stepId);
      const localFilePaths = uploadInputsForStep(stepId).map((input) => {
        const path = normalizeRecordedFilePath(input.value);
        if (input.value !== path) input.value = path;
        return path;
      });
      void sendRuntime("flow_record_update", { stepId, localFilePaths })
        .then((result) => acceptFlowState(result))
        .catch((error) => setStatus(error.message));
    }, 280));
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    await refresh();
  }

  elements.topRecord.addEventListener("click", () => {
    setPanelOpen(true);
    void withBusy(refresh, "Could not load the QC recorder.");
  });
  elements.close.addEventListener("click", () => void withBusy(
    closePanel,
    "Could not close the QC recorder.",
  ));
  elements.record.addEventListener("click", () => void withBusy(
    toggleRecording,
    "Could not change flow recording state.",
  ));
  elements.exportOpen.addEventListener("click", () => void withBusy(
    openExportDialog,
    "Could not prepare the saved flow export.",
  ));
  for (const importTrigger of [elements.importOpen, elements.importDropZone]) {
    importTrigger.addEventListener("click", () => {
      if (busy) return;
      elements.importFile.value = "";
      elements.importFile.click();
    });
  }
  elements.importFile.addEventListener("change", () => {
    const [file] = elements.importFile.files || [];
    if (!file) return;
    void withBusy(
      async () => {
        try {
          await reviewImportFile(file);
        } finally {
          elements.importFile.value = "";
        }
      },
      "Could not review the selected saved flows.",
    );
  });
  elements.importClose.addEventListener("click", closeImportDialog);
  elements.importCancel.addEventListener("click", closeImportDialog);
  elements.importConfirm.addEventListener("click", () => void withBusy(
    commitImportReview,
    "Could not import the selected saved flows.",
  ));
  elements.importDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeImportDialog();
  });
  elements.importDialog.addEventListener("click", (event) => {
    if (event.target === elements.importDialog) closeImportDialog();
  });
  elements.importList.addEventListener("change", (event) => {
    const checkbox = event.target.closest?.("[data-flow-import-select]");
    if (checkbox) {
      const item = importReviewItems.find(
        (candidate) => candidate.flow.id === checkbox.dataset.flowImportSelect,
      );
      if (!item) return;
      selectRecordedFlowImportItem(item, checkbox.checked);
      updateImportReviewControls();
      return;
    }
  });
  elements.importList.addEventListener("input", (event) => {
    const input = event.target.closest?.("[data-flow-import-rename]");
    if (!input) return;
    const item = importReviewItems.find(
      (candidate) => candidate.flow.id === input.dataset.flowImportRename,
    );
    if (!item) return;
    renameRecordedFlowImportItem(item, input.value);
    updateImportReviewControls();
  });
  const flowDropEventTarget = documentObject.defaultView || documentObject;
  function stopFlowDropPropagation(event) {
    event.stopImmediatePropagation?.();
    event.stopPropagation();
  }
  function handleFlowDragEnter(event) {
    if (elements.panel.hidden || !dataTransferContainsRecordedFlowJson(event.dataTransfer)) return;
    event.preventDefault();
    stopFlowDropPropagation(event);
    flowImportDragDepth += 1;
    documentObject.documentElement.classList.remove("is-attachment-dragging");
    documentObject.documentElement.classList.add("is-flow-import-dragging");
  }
  function handleFlowDragOver(event) {
    if (elements.panel.hidden || !dataTransferContainsRecordedFlowJson(event.dataTransfer)) return;
    event.preventDefault();
    stopFlowDropPropagation(event);
    event.dataTransfer.dropEffect = "copy";
    documentObject.documentElement.classList.remove("is-attachment-dragging");
    documentObject.documentElement.classList.add("is-flow-import-dragging");
  }
  function handleFlowDragLeave(event) {
    if (!documentObject.documentElement.classList.contains("is-flow-import-dragging")) return;
    stopFlowDropPropagation(event);
    if (event.relatedTarget === null) flowImportDragDepth = 0;
    else flowImportDragDepth = Math.max(0, flowImportDragDepth - 1);
    if (!flowImportDragDepth) {
      documentObject.documentElement.classList.remove("is-flow-import-dragging");
    }
  }
  function handleFlowDrop(event) {
    if (elements.panel.hidden) return;
    const jsonFiles = recordedFlowJsonFilesFromTransfer(event.dataTransfer);
    if (!jsonFiles.length) return;
    event.preventDefault();
    stopFlowDropPropagation(event);
    flowImportDragDepth = 0;
    documentObject.documentElement.classList.remove(
      "is-attachment-dragging",
      "is-flow-import-dragging",
    );
    if (jsonFiles.length > 1) {
      const message = "Drop one Lumi recorded flows JSON file at a time.";
      setImportFeedback(message, "error");
      setStatus(message);
      return;
    }
    void withBusy(
      () => reviewImportFile(jsonFiles[0]),
      "Could not review the dropped saved flows file.",
    );
  }
  flowDropEventTarget.addEventListener("dragenter", handleFlowDragEnter, true);
  flowDropEventTarget.addEventListener("dragover", handleFlowDragOver, true);
  flowDropEventTarget.addEventListener("dragleave", handleFlowDragLeave, true);
  flowDropEventTarget.addEventListener("drop", handleFlowDrop, true);
  elements.exportClose.addEventListener("click", closeExportDialog);
  elements.exportCancel.addEventListener("click", closeExportDialog);
  elements.exportSelectAll.addEventListener("change", () => {
    selectedExportFlowIds.clear();
    if (elements.exportSelectAll.checked) {
      for (const flow of flows) selectedExportFlowIds.add(flow.id);
    }
    renderExportSelection();
  });
  elements.exportList.addEventListener("change", (event) => {
    const checkbox = event.target.closest?.("[data-flow-export-id]");
    if (!checkbox) return;
    if (checkbox.checked) selectedExportFlowIds.add(checkbox.dataset.flowExportId);
    else selectedExportFlowIds.delete(checkbox.dataset.flowExportId);
    updateExportSelectionControls();
  });
  elements.exportConfirm.addEventListener("click", () => void withBusy(
    exportSelectedFlows,
    "Could not export the selected saved flows.",
  ));
  elements.exportDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeExportDialog();
  });
  elements.exportDialog.addEventListener("click", (event) => {
    if (event.target === elements.exportDialog) closeExportDialog();
  });
  elements.runDraft.addEventListener("click", () => {
    if (draft) void withBusy(
      async () => {
        await flushEditorChanges();
        return runFlow({
        id: draft.flowId || undefined,
        name: elements.name.value.trim() || draft.name,
        startUrl: draft.startUrl,
        startTitle: draft.startTitle,
        steps: draft.steps,
        createdAt: draft.startedAt,
        updatedAt: draft.updatedAt,
        });
      },
      "Could not run the recorded flow.",
    );
  });
  elements.name.addEventListener("input", () => {
    clearTimeout(nameTimerId);
    nameTimerId = setTimeout(() => {
      void sendRuntime("flow_record_update", { name: elements.name.value })
        .then((result) => {
          acceptFlowState(result);
        })
        .catch((error) => setStatus(error.message));
    }, 280);
  });
  elements.stepList.addEventListener("input", (event) => {
    const uploadPath = event.target.closest?.("[data-flow-upload-path]");
    if (uploadPath) {
      const normalizedPath = normalizeRecordedFilePath(uploadPath.value);
      if (uploadPath.value !== normalizedPath) uploadPath.value = normalizedPath;
      const editor = uploadPath.closest("[data-flow-upload-editor]");
      updateUploadEditorState(editor);
      const step = draft?.steps?.find(
        (candidate) => candidate.id === uploadPath.dataset.flowUploadPath,
      );
      if (step) {
        step.localFilePaths = Array.from(editor.querySelectorAll("[data-flow-upload-path]"))
          .map((input) => input.value);
      }
      elements.runDraft.disabled = controlsAreLocked()
        || draft?.recording
        || !draft?.steps?.length
        || recordedFlowUploadBindingIssues(draft).length > 0;
      scheduleUploadPathUpdate(uploadPath.dataset.flowUploadPath);
      return;
    }
    const prompt = event.target.closest?.("[data-flow-step-prompt]");
    if (!prompt) return;
    expandedPromptIds.add(prompt.dataset.flowStepPrompt);
    collapsedPromptIds.delete(prompt.dataset.flowStepPrompt);
    resizePrompt(prompt);
    schedulePromptUpdate(prompt.dataset.flowStepPrompt, prompt.value);
  });
  elements.stepList.addEventListener("focusout", (event) => {
    const prompt = event.target.closest?.("[data-flow-step-prompt]");
    if (!prompt || prompt.value.trim()) return;
    setTimeout(() => {
      if (prompt.value.trim() || documentObject.activeElement === prompt) return;
      const editor = promptEditorFrom(prompt);
      if (editor) setPromptEditorExpanded(editor, false);
    }, 0);
  });
  elements.stepList.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-flow-step-action]");
    if (!button) return;
    const action = button.dataset.flowStepAction;
    if (action !== "delete") return;
    void withBusy(async () => {
      const stepIndex = draft?.steps?.findIndex(
        (step) => step.id === button.dataset.stepId,
      ) ?? -1;
      const step = stepIndex >= 0 ? draft.steps[stepIndex] : null;
      const confirmed = await confirmAction({
        title: "Delete recorded step?",
        message: step
          ? `${recordedStepTitle(step, stepIndex)} will be removed from this autosaved flow.`
          : "This step will be removed from the autosaved flow.",
        confirmLabel: "Delete step",
      });
      if (!confirmed) return;
      const result = await sendRuntime("flow_record_update", {
        stepId: button.dataset.stepId,
        remove: action === "delete",
      });
      acceptFlowState(result);
      expandedPromptIds.delete(button.dataset.stepId);
      collapsedPromptIds.delete(button.dataset.stepId);
    }, "Could not update the recorded step.");
  });
  elements.libraryList.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-flow-library-action]");
    if (!button) return;
    const flow = flows.find((candidate) => candidate.id === button.dataset.flowId);
    if (!flow) return;
    const action = button.dataset.flowLibraryAction;
    if (action === "run") {
      void withBusy(async () => runFlow(await freshSavedFlowForRun(flow)), "Could not run the saved flow.");
      return;
    }
    if (action === "edit") {
      void withBusy(async () => {
        const result = await sendRuntime("flow_record_open", { flowId: flow.id });
        draft = result.draft;
        expandedPromptIds.clear();
        collapsedPromptIds.clear();
      }, "Could not open the saved flow.");
      return;
    }
    void withBusy(async () => {
      const confirmed = await confirmAction({
        title: "Delete saved flow?",
        message: `“${flow.name}” and all of its recorded steps will be removed.`,
        confirmLabel: "Delete flow",
      });
      if (!confirmed) return;
      const result = await sendRuntime("flow_record_delete", { flowId: flow.id });
      flows = result.flows || [];
      draft = result.draft;
    }, "Could not delete the saved flow.");
  });
  documentObject.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || elements.panel.hidden || busy) return;
    if (elements.exportDialog.open || elements.importDialog.open) return;
    const prompt = documentObject.activeElement?.closest?.("[data-flow-step-prompt]");
    const editor = promptEditorFrom(prompt);
    if (editor) {
      event.preventDefault();
      setPromptEditorExpanded(editor, false, { focusButton: true });
      return;
    }
    event.preventDefault();
    void withBusy(closePanel, "Could not close the QC recorder.");
  });

  return {
    cancelActiveRun,
    dispose() {
      if (draft?.recording) void sendRuntime("flow_record_stop").catch(() => {});
      if (activeFlowRun) {
        void sendRuntime("cancel_active_browser_action").catch(() => null);
        try {
          onFlowRunStateChange(false, activeFlowRun.flow);
        } catch {
          // The host is already being disposed.
        }
        activeFlowRun = null;
      }
      closeExportDialog();
      closeImportDialog();
      documentObject.documentElement.classList.remove("is-flow-import-dragging");
      flowDropEventTarget.removeEventListener("dragenter", handleFlowDragEnter, true);
      flowDropEventTarget.removeEventListener("dragover", handleFlowDragOver, true);
      flowDropEventTarget.removeEventListener("dragleave", handleFlowDragLeave, true);
      flowDropEventTarget.removeEventListener("drop", handleFlowDrop, true);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      clearTimeout(nameTimerId);
      for (const timerId of uploadPathTimers.values()) clearTimeout(timerId);
      uploadPathTimers.clear();
      for (const timerId of promptTimers.values()) clearTimeout(timerId);
      promptTimers.clear();
    },
    initialize,
  };
}
