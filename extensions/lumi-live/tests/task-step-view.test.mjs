import assert from "node:assert/strict";
import test from "node:test";

import {
  formatStepActionLabel,
  resolveStepExpandedState,
  shouldDeferTaskRender,
  shouldFollowTaskUpdates,
} from "../side-panel/task-step-view.js";

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
    formatStepActionLabel({ name: "browser_apply_stage", input: {} }),
    "Apply verified form stage",
  );
  assert.equal(
    formatStepActionLabel({ name: "browser_get_stage_ledger", input: {} }),
    "Inspect stage ledger",
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
