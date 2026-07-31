import {
  buildRecordedFlowAgentPrompt,
  RECORDED_STEP_GROUP_ACTION,
  recordedStepTitle,
} from "../core/recorded-flows.js";
import { EXTENSION_EVENTS } from "../core/extension-config.js";

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
  };
  let draft = null;
  let flows = [];
  let busy = false;
  let initialized = false;
  const promptTimers = new Map();
  const expandedPromptIds = new Set();
  const collapsedPromptIds = new Set();
  let nameTimerId = null;

  function setPanelOpen(open) {
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
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      clearTimeout(nameTimerId);
      for (const timerId of promptTimers.values()) clearTimeout(timerId);
      promptTimers.clear();
    },
    initialize,
  };
}
