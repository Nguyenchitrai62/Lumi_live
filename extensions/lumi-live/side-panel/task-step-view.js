import {
  TASK_AUTO_FOLLOW_BOTTOM_TOLERANCE_PX,
  TASK_STEP_DISCLOSURE_ANIMATION_DURATION_MS,
} from "../core/ui-config.js";
import { attachAnimatedDisclosure } from "./disclosure-controller.js";

const STATUS_LABELS = {
  running: "Running",
  completed: "Verified",
  failed: "Failed",
  loop_blocked: "Loop blocked",
};
const AUTO_EXPANDED_STEP_STATES = new Set(["running", "failed", "loop_blocked"]);
const ACTION_LABELS = {
  browser_get_active_context: "Read active page",
  browser_capture_visible_tab: "Capture visible page",
  browser_inspect_screenshot: "Inspect screenshot",
  browser_get_page_state: "Observe page",
  browser_find_semantic_context: "Find page target",
  browser_wait_for_page_state: "Wait for page update",
  browser_click: "Click page element",
  browser_input_text: "Enter text",
  browser_upload_file: "Upload file",
  browser_select_option: "Choose option",
  browser_scroll: "Scroll page",
  browser_list_tabs: "Inspect open tabs",
  browser_open_tab: "Open tab",
  browser_switch_tab: "Switch tab",
  done: "Complete task",
};

function formatValue(value, maxLength = 5000) {
  if (value === undefined || value === null || value === "") return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return String(text).slice(0, maxLength);
}

function compactText(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function formatStepActionLabel(action = {}) {
  const name = String(action.name || "");
  if (ACTION_LABELS[name]) {
    if (name === "browser_click" && Number.isInteger(action.input?.index)) {
      return `Click element ${action.input.index}`;
    }
    if (name === "browser_switch_tab" && Number.isInteger(action.input?.tabId)) {
      return `Switch to tab ${action.input.tabId}`;
    }
    return ACTION_LABELS[name];
  }
  const readable = name
    .replace(/^(?:mcp__|browser_)/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return readable
    ? `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`
    : "Run tool";
}

export function resolveStepExpandedState(step, userPreference) {
  if (typeof userPreference === "boolean") return userPreference;
  return AUTO_EXPANDED_STEP_STATES.has(step?.action?.status);
}

export function shouldFollowTaskUpdates({
  distanceFromBottom,
  hasManuallyExpandedStep,
}) {
  return Number(distanceFromBottom) <= TASK_AUTO_FOLLOW_BOTTOM_TOLERANCE_PX
    && hasManuallyExpandedStep !== true;
}

export function shouldDeferTaskRender({
  hasRenderedTask,
  hasManuallyExpandedStep,
  expansionSettling,
}) {
  return hasRenderedTask === true
    && (hasManuallyExpandedStep === true || expansionSettling === true);
}

function taskStatus(events) {
  const done = events.findLast?.((event) => event.type === "task_done")
    || [...events].reverse().find((event) => event.type === "task_done");
  if (!done) return "running";
  return done.success ? "completed" : done.reason === "cancelled" ? "cancelled" : "failed";
}

export function buildTaskStepViewModel(history = []) {
  const taskStarts = history.filter((event) => event.type === "task_started");
  return taskStarts.map((started) => {
    const events = history.filter((event) => event.taskId === started.taskId);
    const steps = events.filter((event) => event.type === "step");
    const done = [...events].reverse().find((event) => event.type === "task_done") || null;
    return {
      taskId: started.taskId,
      request: started.request,
      maxSteps: started.maxSteps,
      status: taskStatus(events),
      usedSteps: steps.filter(
        (step) => step.action.name !== "done" && step.action.status !== "loop_blocked",
      ).length,
      steps,
      notices: events.filter((event) =>
        ["retry", "loop_detected", "error", "completion_required"].includes(event.type)),
      done,
    };
  });
}

function element(tag, className, text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function appendField(container, label, value, className = "") {
  const section = element("section", `agent-step-field ${className}`.trim());
  section.append(
    element("span", "agent-step-field-label", label),
    element("p", "agent-step-field-value", value || "—"),
  );
  container.append(section);
}

function appendCodeField(container, label, value) {
  const section = element("section", "agent-step-field agent-step-code-field");
  section.append(
    element("span", "agent-step-field-label", label),
    element("pre", "agent-step-code", formatValue(value)),
  );
  container.append(section);
}

function renderStep(step, disclosures, {
  expandedPreference,
  onExpansionChange,
} = {}) {
  const details = element("details", "agent-step-card");
  details.dataset.state = step.action.status;
  details.dataset.stepId = step.id;
  const summary = element("summary", "agent-step-summary");
  const marker = element("span", "agent-step-marker", String(step.stepNumber));
  marker.setAttribute("aria-hidden", "true");
  const copy = element("span", "agent-step-summary-copy");
  const actionLabel = formatStepActionLabel(step.action);
  const goal = compactText(step.reflection?.nextGoal) || actionLabel;
  copy.append(
    element(
      "small",
      "",
      step.action.name === "done"
        ? "Completion"
        : `Step ${step.stepNumber} · ${actionLabel}`,
    ),
    element("strong", "", goal),
  );
  copy.title = goal;
  const status = element(
    "span",
    "agent-step-status",
    STATUS_LABELS[step.action.status] || step.action.status,
  );
  status.setAttribute("role", "status");
  const chevron = element("span", "agent-step-chevron");
  chevron.setAttribute("aria-hidden", "true");
  summary.append(marker, copy);
  if (step.retryAttempt > 0) {
    summary.append(element("span", "agent-step-retry", `Retry ${step.retryAttempt + 1}`));
  }
  summary.append(status, chevron);

  const body = element("div", "agent-step-body");
  body.id = `lumi-step-details-${step.id}`;
  summary.setAttribute("aria-controls", body.id);
  summary.setAttribute(
    "aria-label",
    `Step ${step.stepNumber}: ${goal}. ${status.textContent}.`,
  );
  const reflection = element("div", "agent-step-reflection");
  appendField(reflection, "Next goal", step.reflection?.nextGoal, "agent-step-goal");
  appendField(
    reflection,
    "Evaluation",
    step.reflection?.evaluationPreviousGoal,
    "agent-step-evaluation",
  );
  appendField(reflection, "Memory", step.reflection?.memory, "agent-step-memory");
  body.append(reflection);
  appendCodeField(body, `Action · ${step.action.name}`, step.action.input);
  if (step.observation) {
    appendField(body, "Observation", step.observation.summary, "agent-step-observation");
    if (step.observation.verification?.required) {
      const verification = step.observation.verification;
      appendField(
        body,
        verification.status === "observed"
          ? "Verification evidence"
          : "Verification required",
        verification.status === "observed"
          ? verification.evidence
          : "Observe fresh browser state before another action or successful completion.",
        verification.status === "observed"
          ? "agent-step-verification"
          : "agent-step-verification-required",
      );
    }
  }
  if (step.action.error) {
    appendField(body, "Error", step.action.error, "agent-step-error");
  } else if (step.action.output !== null && step.action.output !== undefined) {
    appendCodeField(body, "Output", step.action.output);
  }
  if (Number.isFinite(step.action.durationMs)) {
    const meta = element("p", "agent-step-duration", `${step.action.durationMs} ms`);
    body.append(meta);
  }
  details.append(summary, body);
  disclosures.push(attachAnimatedDisclosure({
    root: details,
    summary,
    body,
    initiallyExpanded: resolveStepExpandedState(step, expandedPreference),
    durationMs: TASK_STEP_DISCLOSURE_ANIMATION_DURATION_MS,
    onExpandedChange: onExpansionChange,
  }));
  return details;
}

function renderNotice(notice) {
  const row = element("div", "agent-task-notice");
  row.dataset.type = notice.type;
  const labels = {
    retry: "Retry",
    loop_detected: "Loop detected",
    error: "Controller",
    completion_required: "Completion required",
  };
  row.append(
    element("strong", "", labels[notice.type] || notice.type),
    element("span", "", notice.message),
  );
  return row;
}

function renderTask(model, disclosures, {
  expansionPreferences,
  onExpansionChange,
} = {}) {
  const root = element("section", "agent-task-view");
  root.dataset.taskId = model.taskId;
  root.dataset.state = model.status;
  root.setAttribute("aria-label", `Lumi task: ${model.request}`);
  const header = element("header", "agent-task-header");
  const copy = element("div", "agent-task-copy");
  copy.append(
    element("small", "", "LUMI TASK"),
    element("strong", "", model.request),
  );
  const progress = element(
    "span",
    "agent-task-progress",
    model.status === "running"
      ? `${model.usedSteps}/${model.maxSteps}`
      : model.status === "completed" ? "Done" : model.status,
  );
  header.append(copy, progress);
  const steps = element("div", "agent-task-steps");
  for (const step of model.steps) {
    steps.append(renderStep(step, disclosures, {
      expandedPreference: expansionPreferences.get(step.id),
      onExpansionChange: (expanded) => onExpansionChange(step.id, expanded),
    }));
  }
  for (const notice of model.notices) steps.append(renderNotice(notice));
  if (model.done) {
    const completion = element("div", "agent-task-completion");
    completion.dataset.success = String(model.done.success);
    completion.append(
      element("strong", "", model.done.success ? "Task completed" : "Task stopped"),
      element("p", "", model.done.result),
    );
    if (model.done.evidence) {
      completion.append(element("small", "", model.done.evidence));
    }
    if (model.done.completedGoals?.length) {
      const goals = element("ul", "agent-task-completed-goals");
      for (const item of model.done.completedGoals) {
        const row = element("li", "");
        row.append(
          element("strong", "", item.goal),
          element("span", "", item.evidence),
        );
        goals.append(row);
      }
      completion.append(goals);
    }
    steps.append(completion);
  }
  root.append(header, steps);
  return root;
}

export function createTaskStepView({
  container,
  scrollToLatest = () => {},
} = {}) {
  let disclosures = [];
  let pendingHistory = null;
  let expansionSettling = false;
  let expansionSettleTimerId = null;
  const roots = new Map();
  const expansionPreferences = new Map();

  const disposeDisclosures = () => {
    for (const disclosure of disclosures) disclosure?.dispose?.();
    disclosures = [];
  };

  const taskStepElements = () =>
    [...roots.values()].flatMap((root) =>
      [...root.querySelectorAll(".agent-step-card[data-step-id]")]);

  const findStepElement = (stepId) =>
    taskStepElements().find((node) => node.dataset.stepId === stepId) || null;

  const hasManuallyExpandedStep = () =>
    [...expansionPreferences.values()].some((expanded) => expanded === true);

  const markUpdatesPending = () => {
    for (const root of roots.values()) {
      root.dataset.updatesPending = "true";
      root.setAttribute("aria-busy", "true");
      root.title = "New task updates are waiting while you inspect this step.";
    }
  };

  const captureViewport = () => {
    if (!container) {
      return {
        followLatest: true,
        anchorStepId: "",
        anchorOffset: 0,
        scrollTop: 0,
        stepBodyScroll: new Map(),
        focusedStepId: "",
      };
    }
    const distanceFromBottom = Math.max(
      0,
      container.scrollHeight - container.scrollTop - container.clientHeight,
    );
    const followLatest = shouldFollowTaskUpdates({
      distanceFromBottom,
      hasManuallyExpandedStep: hasManuallyExpandedStep(),
    });
    const containerRect = container.getBoundingClientRect?.();
    const visibleStep = containerRect
      ? taskStepElements().find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.bottom > containerRect.top + 8
            && rect.top < containerRect.bottom - 8;
        })
      : null;
    return {
      followLatest,
      anchorStepId: visibleStep?.dataset.stepId || "",
      anchorOffset: visibleStep && containerRect
        ? visibleStep.getBoundingClientRect().top - containerRect.top
        : 0,
      scrollTop: container.scrollTop,
      stepBodyScroll: new Map(taskStepElements().map((step) => [
        step.dataset.stepId,
        step.querySelector(".agent-step-body")?.scrollTop || 0,
      ])),
      focusedStepId: document.activeElement
        ?.closest?.(".agent-step-card[data-step-id]")
        ?.dataset.stepId || "",
    };
  };

  const restoreViewport = (snapshot) => {
    if (!container) return;
    for (const [stepId, scrollTop] of snapshot.stepBodyScroll) {
      const body = findStepElement(stepId)?.querySelector(".agent-step-body");
      if (body) body.scrollTop = scrollTop;
    }
    const focusedSummary = snapshot.focusedStepId
      ? findStepElement(snapshot.focusedStepId)?.querySelector(".agent-step-summary")
      : null;
    focusedSummary?.focus?.({ preventScroll: true });
    if (snapshot.followLatest) {
      scrollToLatest();
      return;
    }
    const anchor = snapshot.anchorStepId
      ? findStepElement(snapshot.anchorStepId)
      : null;
    const containerRect = container.getBoundingClientRect?.();
    if (anchor && containerRect) {
      const nextOffset = anchor.getBoundingClientRect().top - containerRect.top;
      container.scrollTop += nextOffset - snapshot.anchorOffset;
      return;
    }
    container.scrollTop = snapshot.scrollTop;
  };

  const render = (history = [], { force = false } = {}) => {
    if (
      !force
      && shouldDeferTaskRender({
        hasRenderedTask: roots.size > 0,
        hasManuallyExpandedStep: hasManuallyExpandedStep(),
        expansionSettling,
      })
    ) {
      pendingHistory = history;
      markUpdatesPending();
      return;
    }
    pendingHistory = null;
    const viewport = captureViewport();
    disposeDisclosures();
    const models = buildTaskStepViewModel(history);
    const activeIds = new Set(models.map((model) => model.taskId));
    const activeStepIds = new Set(models.flatMap((model) =>
      model.steps.map((step) => step.id)));
    for (const stepId of expansionPreferences.keys()) {
      if (!activeStepIds.has(stepId)) expansionPreferences.delete(stepId);
    }
    for (const [taskId, root] of roots) {
      if (activeIds.has(taskId)) continue;
      root.remove();
      roots.delete(taskId);
    }
    for (const model of models) {
      const next = renderTask(model, disclosures, {
        expansionPreferences,
        onExpansionChange: (stepId, expanded) => {
          expansionPreferences.set(stepId, expanded);
          if (expanded) {
            clearTimeout(expansionSettleTimerId);
            expansionSettleTimerId = null;
            expansionSettling = false;
            return;
          }
          if (hasManuallyExpandedStep()) return;
          expansionSettling = true;
          clearTimeout(expansionSettleTimerId);
          expansionSettleTimerId = setTimeout(() => {
            expansionSettleTimerId = null;
            expansionSettling = false;
            if (!pendingHistory) return;
            const queuedHistory = pendingHistory;
            pendingHistory = null;
            render(queuedHistory, { force: true });
          }, TASK_STEP_DISCLOSURE_ANIMATION_DURATION_MS);
        },
      });
      const current = roots.get(model.taskId);
      if (current) current.replaceWith(next);
      else container?.append(next);
      roots.set(model.taskId, next);
    }
    restoreViewport(viewport);
  };

  const clear = () => {
    clearTimeout(expansionSettleTimerId);
    expansionSettleTimerId = null;
    expansionSettling = false;
    pendingHistory = null;
    disposeDisclosures();
    expansionPreferences.clear();
    for (const root of roots.values()) root.remove();
    roots.clear();
  };

  const hydrate = (history = []) => {
    clearTimeout(expansionSettleTimerId);
    expansionSettleTimerId = null;
    expansionSettling = false;
    pendingHistory = null;
    disposeDisclosures();
    expansionPreferences.clear();
    roots.clear();
    for (const root of container?.querySelectorAll(
      ".agent-task-view[data-task-id]",
    ) || []) {
      roots.set(root.dataset.taskId, root);
      for (const step of root.querySelectorAll(
        ".agent-step-card[data-step-id]",
      )) {
        expansionPreferences.set(
          step.dataset.stepId,
          step.open || step.dataset.expanded === "true",
        );
      }
    }
    render(history, { force: true });
  };

  return {
    clear,
    hydrate,
    render,
    get isReviewing() {
      return hasManuallyExpandedStep() || expansionSettling;
    },
  };
}
