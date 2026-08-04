import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskStepViewModel,
  formatStepActionLabel,
  resolveStepExpandedState,
  shouldDeferTaskRender,
  shouldFollowTaskUpdates,
} from "../side-panel/task-step-view.js";

function taskEvent(id, type, extra = {}) {
  return { id, taskId: "task-1", type, ...extra };
}

test("step summaries use readable action labels instead of raw tool identifiers", () => {
  assert.equal(
    formatStepActionLabel({
      name: "browser_click",
      input: { index: 14 },
    }),
    "Click element 14",
  );
  assert.equal(
    formatStepActionLabel({ name: "browser_get_page_state", input: {} }),
    "Observe page",
  );
  assert.equal(
    formatStepActionLabel({ name: "notion_search_pages", input: {} }),
    "Notion search pages",
  );
});

test("running and failed steps auto-expand until the user chooses a state", () => {
  assert.equal(
    resolveStepExpandedState({ action: { status: "running" } }, undefined),
    true,
  );
  assert.equal(
    resolveStepExpandedState({ action: { status: "completed" } }, undefined),
    false,
  );
  assert.equal(
    resolveStepExpandedState({ action: { status: "completed" } }, true),
    true,
  );
  assert.equal(
    resolveStepExpandedState({ action: { status: "running" } }, false),
    false,
  );
});

test("a successful retry presents the earlier failure as recovered in chronological order", () => {
  const history = [
    taskEvent("event-1", "task_started", { request: "Count rows", maxSteps: 8 }),
    taskEvent("event-2", "error", {
      code: "premature_done",
      message: "Cannot report success before at least one task step has completed.",
    }),
    taskEvent("event-3", "step", {
      stepNumber: 1,
      reflection: { nextGoal: "Read data" },
      retryAttempt: 0,
      action: { name: "excel_understand", input: {}, status: "failed", error: "Bad range" },
    }),
    taskEvent("event-4", "retry", { message: "Retrying Excel." }),
    taskEvent("event-5", "step", {
      stepNumber: 2,
      reflection: { nextGoal: "Read data" },
      retryAttempt: 1,
      action: { name: "excel_understand", input: {}, status: "completed", error: "" },
    }),
    taskEvent("event-6", "step", {
      stepNumber: 3,
      reflection: { nextGoal: "Complete" },
      retryAttempt: 0,
      action: { name: "done", input: {}, status: "completed", error: "" },
    }),
    taskEvent("event-7", "task_done", { success: true, result: "36 rows" }),
  ];
  const model = buildTaskStepViewModel(history)[0];
  assert.equal(model.status, "completed");
  assert.equal(model.steps[0].presentationStatus, "recovered");
  assert.equal(resolveStepExpandedState(model.steps[0], undefined), false);
  assert.equal(model.notices[0].presentationType, "recovered");
  assert.deepEqual(
    model.timeline.map((entry) => `${entry.kind}:${entry.item.type}`),
    ["notice:error", "step:step", "notice:retry", "step:step", "step:step"],
  );
});

test("only a terminal task failure remains red and auto-expanded", () => {
  const runningHistory = [
    taskEvent("event-1", "task_started", { request: "Run tool", maxSteps: 4 }),
    taskEvent("event-2", "step", {
      stepNumber: 1,
      reflection: { nextGoal: "Run tool" },
      action: { name: "demo", input: {}, status: "failed", error: "Temporary" },
    }),
  ];
  const running = buildTaskStepViewModel(runningHistory)[0];
  assert.equal(running.steps[0].presentationStatus, "retryable");
  assert.equal(resolveStepExpandedState(running.steps[0], undefined), false);

  const failed = buildTaskStepViewModel([
    ...runningHistory,
    taskEvent("event-3", "task_done", { success: false, result: "Stopped" }),
  ])[0];
  assert.equal(failed.steps[0].presentationStatus, "failed");
  assert.equal(resolveStepExpandedState(failed.steps[0], undefined), true);
});

test("cancelled and superseded tasks are not classified as terminal failures", () => {
  for (const reason of ["cancelled", "superseded"]) {
    const model = buildTaskStepViewModel([
      taskEvent("event-1", "task_started", { request: "Run tool", maxSteps: 4 }),
      taskEvent("event-2", "task_done", { success: false, reason, result: "Stopped" }),
    ])[0];
    assert.equal(model.status, "cancelled");
  }
});

test("live task updates follow the bottom only when the user is not reviewing a step", () => {
  assert.equal(
    shouldFollowTaskUpdates({
      distanceFromBottom: 0,
      hasManuallyExpandedStep: false,
    }),
    true,
  );
  assert.equal(
    shouldFollowTaskUpdates({
      distanceFromBottom: 2,
      hasManuallyExpandedStep: false,
    }),
    false,
  );
  assert.equal(
    shouldFollowTaskUpdates({
      distanceFromBottom: 0,
      hasManuallyExpandedStep: true,
    }),
    false,
  );
  assert.equal(
    shouldFollowTaskUpdates({
      distanceFromBottom: 120,
      hasManuallyExpandedStep: false,
    }),
    false,
  );
});

test("task DOM updates pause while a user expansion is open or settling", () => {
  assert.equal(
    shouldDeferTaskRender({
      hasRenderedTask: true,
      hasManuallyExpandedStep: true,
      expansionSettling: false,
    }),
    true,
  );
  assert.equal(
    shouldDeferTaskRender({
      hasRenderedTask: true,
      hasManuallyExpandedStep: false,
      expansionSettling: true,
    }),
    true,
  );
  assert.equal(
    shouldDeferTaskRender({
      hasRenderedTask: true,
      hasManuallyExpandedStep: false,
      expansionSettling: false,
    }),
    false,
  );
});
