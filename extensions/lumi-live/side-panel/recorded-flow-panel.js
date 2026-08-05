import {
  buildRecordedFlowAgentPrompt,
  createRecordedFlowsExport,
  RECORDED_STEP_GROUP_ACTION,
  recordedFlowNameKey,
  recordedStepTitle,
} from "../core/recorded-flows.js";
import { EXTENSION_EVENTS } from "../core/extension-config.js";

const MAX_RECORDED_FLOW_IMPORT_BYTES = 5 * 1024 * 1024;

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
  return Array.from(dataTransfer?.files || []).filter(isRecordedFlowJsonFile);
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

export function createRecordedFlowPanel({
  documentObject = document,
  sendRuntime,
  runAgentFlow,
  setStatus,
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
  let initialized = false;
  const promptTimers = new Map();
  const expandedPromptIds = new Set();
  const collapsedPromptIds = new Set();
  const selectedExportFlowIds = new Set();
  const importReviewRows = new Map();
  let importReviewItems = [];
  let importSavedFlows = [];
  let importSourceText = "";
  let flowImportDragDepth = 0;
  let nameTimerId = null;

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
          : step.resultUrl || step.url || step.target.selector || "";
    copy.append(title, detail);

    const controls = documentObject.createElement("div");
    controls.className = "flow-step-controls";
    const promptButton = documentObject.createElement("button");
    promptButton.type = "button";
    promptButton.className = "flow-step-add-prompt";
    promptButton.dataset.flowStepAction = "prompt";
    promptButton.dataset.stepId = step.id;
    promptButton.disabled = busy;
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
    deleteButton.disabled = busy;
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
    prompt.disabled = busy;
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
    item.append(header, promptLabel);
    return item;
  }

  function renderDraft() {
    const focus = currentPromptFocus();
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
    elements.record.disabled = busy;
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
    elements.name.disabled = busy || !hasDraft;
    if (documentObject.activeElement !== elements.name) elements.name.value = draft?.name || "";
    elements.runDraft.disabled = busy || recording || !steps.length;
    restorePromptFocus(focus);
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
      button.disabled = busy || draft?.recording;
      actions.append(button);
    }
    item.append(copy, actions);
    return item;
  }

  function renderLibrary() {
    elements.libraryEmpty.hidden = flows.length > 0;
    elements.libraryList.replaceChildren(...flows.map(createLibraryItem));
    elements.importOpen.disabled = busy;
    elements.importDropZone.disabled = busy;
    elements.importFile.disabled = busy;
    elements.exportOpen.disabled = busy || flows.length === 0;
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

  function suggestImportedFlowName(flowName, currentItemId) {
    const occupiedNames = new Set(importSavedFlows.map((flow) => recordedFlowNameKey(flow.name)));
    for (const item of importReviewItems) {
      if (item.flow.id === currentItemId || item.action === "overwrite") continue;
      const candidateName = item.action === "rename" ? item.name : item.flow.name;
      if (candidateName) occupiedNames.add(recordedFlowNameKey(candidateName));
    }
    let suffix = 1;
    let candidate = `${flowName} (imported)`;
    while (occupiedNames.has(recordedFlowNameKey(candidate))) {
      suffix += 1;
      candidate = `${flowName} (imported ${suffix})`;
    }
    return candidate.slice(0, 120);
  }

  function validateImportReview() {
    const occupiedNames = new Set(importSavedFlows.map((flow) => recordedFlowNameKey(flow.name)));
    const overwrittenFlowIds = new Set();
    for (const item of importReviewItems) {
      item.ready = false;
      item.error = "";
      if (item.action === "overwrite") {
        const existingFlow = importSavedFlows.find(
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
        const name = String(item.name || "").trim();
        const nameKey = recordedFlowNameKey(name);
        if (!name) item.error = "Enter a new flow name.";
        else if (occupiedNames.has(nameKey)) item.error = "This flow name is already in use.";
        else {
          item.name = name;
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
          ? "Select this red flow to overwrite, or choose Rename."
          : "Rename this flow before selecting it for import.";
      }
      if (!item.ready) item.selected = false;
    }
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
    const select = documentObject.createElement("select");
    select.dataset.flowImportResolution = item.flow.id;
    select.setAttribute("aria-label", `Resolve ${item.flow.name}`);
    const unresolved = documentObject.createElement("option");
    unresolved.value = "";
    unresolved.textContent = "Choose how to resolve this name conflict";
    select.append(unresolved);
    for (const existingFlow of item.existingMatches) {
      const option = documentObject.createElement("option");
      option.value = `overwrite:${existingFlow.id}`;
      option.textContent = `Overwrite saved flow · ${formatUpdatedAt(existingFlow.updatedAt)}`;
      select.append(option);
    }
    const renameOption = documentObject.createElement("option");
    renameOption.value = "rename";
    renameOption.textContent = "Import with a different name";
    select.append(renameOption);
    const rename = documentObject.createElement("input");
    rename.type = "text";
    rename.className = "flow-import-rename";
    rename.maxLength = 120;
    rename.dataset.flowImportRename = item.flow.id;
    rename.setAttribute("aria-label", `New name for ${item.flow.name}`);
    const error = documentObject.createElement("small");
    error.className = "flow-import-error";
    resolution.append(select, rename, error);
    row.append(main, resolution);
    importReviewRows.set(item.flow.id, {
      badge,
      checkbox,
      error,
      rename,
      resolution,
      row,
      select,
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
      controls.select.value = item.action === "overwrite"
        ? `overwrite:${item.existingFlowId}`
        : item.action === "rename"
          ? "rename"
          : "";
      controls.select.disabled = busy;
      controls.rename.hidden = item.action !== "rename";
      controls.rename.value = item.name;
      controls.rename.disabled = busy;
      controls.resolution.hidden = !item.hadNameConflict;
      controls.error.hidden = item.ready;
      controls.error.textContent = item.error;
      controls.badge.textContent = willOverwrite
        ? item.selected ? "Will overwrite" : "Overwrite ready"
        : item.ready
          ? item.selected ? "Selected" : "Ready"
          : "Name conflict";
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
      "[data-flow-import-select]:not(:disabled), [data-flow-import-resolution]",
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
        name: item.action === "rename" ? item.name : undefined,
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
    let result = await sendRuntime("flow_record_update", {
      name: elements.name.value.trim(),
    });
    draft = result.draft;
    for (const prompt of elements.stepList.querySelectorAll("[data-flow-step-prompt]")) {
      result = await sendRuntime("flow_record_update", {
        stepId: prompt.dataset.flowStepPrompt,
        prompt: prompt.value,
      });
      draft = result.draft;
    }
  }

  async function runFlow(flow) {
    const prompt = buildRecordedFlowAgentPrompt(flow);
    setPanelOpen(false);
    const started = await runAgentFlow(flow, prompt);
    if (!started) {
      setStatus("Lumi chat must be connected and idle before running a saved flow.");
      setPanelOpen(true);
    }
  }

  function onRuntimeMessage(message) {
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
          draft = result.draft;
        })
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
      if (checkbox.checked && !item.ready && item.existingMatches.length) {
        item.action = "overwrite";
        item.existingFlowId = item.existingMatches[0].id;
        validateImportReview();
      }
      item.selected = checkbox.checked && item.ready;
      updateImportReviewControls();
      return;
    }
    const select = event.target.closest?.("[data-flow-import-resolution]");
    if (!select) return;
    const item = importReviewItems.find(
      (candidate) => candidate.flow.id === select.dataset.flowImportResolution,
    );
    if (!item) return;
    const wasSelected = item.selected;
    if (select.value.startsWith("overwrite:")) {
      item.action = "overwrite";
      item.existingFlowId = select.value.slice("overwrite:".length);
      item.selected = wasSelected;
    } else if (select.value === "rename") {
      item.action = "rename";
      item.existingFlowId = "";
      if (recordedFlowNameKey(item.name) === recordedFlowNameKey(item.flow.name)) {
        item.name = suggestImportedFlowName(item.flow.name, item.flow.id);
      }
      item.selected = false;
    } else {
      item.action = "";
      item.existingFlowId = "";
      item.selected = false;
    }
    updateImportReviewControls();
  });
  elements.importList.addEventListener("input", (event) => {
    const input = event.target.closest?.("[data-flow-import-rename]");
    if (!input) return;
    const item = importReviewItems.find(
      (candidate) => candidate.flow.id === input.dataset.flowImportRename,
    );
    if (!item) return;
    item.name = input.value;
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
          draft = result.draft;
        })
        .catch((error) => setStatus(error.message));
    }, 280);
  });
  elements.stepList.addEventListener("input", (event) => {
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
      draft = result.draft;
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
      void withBusy(() => runFlow(flow), "Could not run the saved flow.");
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
    dispose() {
      if (draft?.recording) void sendRuntime("flow_record_stop").catch(() => {});
      closeExportDialog();
      closeImportDialog();
      documentObject.documentElement.classList.remove("is-flow-import-dragging");
      flowDropEventTarget.removeEventListener("dragenter", handleFlowDragEnter, true);
      flowDropEventTarget.removeEventListener("dragover", handleFlowDragOver, true);
      flowDropEventTarget.removeEventListener("dragleave", handleFlowDragLeave, true);
      flowDropEventTarget.removeEventListener("drop", handleFlowDrop, true);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      clearTimeout(nameTimerId);
      for (const timerId of promptTimers.values()) clearTimeout(timerId);
      promptTimers.clear();
    },
    initialize,
  };
}
