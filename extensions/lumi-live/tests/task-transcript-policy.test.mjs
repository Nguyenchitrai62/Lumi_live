import test from "node:test";
import assert from "node:assert/strict";
import {
  filterTaskTranscriptHistory,
  shouldRenderStandaloneToolActivity,
  taskOwnsTurn,
} from "../side-panel/task-transcript-policy.js";

test("recorded-flow internal agent tasks stay out of the visible task transcript", () => {
  const history = [
    { type: "task_started", taskId: "flow-internal", turnSequence: 11 },
    { type: "step", taskId: "flow-internal" },
    { type: "task_done", taskId: "flow-internal", success: true },
    { type: "task_started", taskId: "user-task", turnSequence: 12 },
    { type: "step", taskId: "user-task" },
  ];

  assert.deepEqual(
    filterTaskTranscriptHistory(history, new Set(["flow-internal"])),
    history.slice(3),
  );
});

test("a Lumi task owns transcript presentation only for its originating turn", () => {
  const history = [
    { type: "task_started", taskId: "task-1", turnSequence: 7 },
    { type: "step", taskId: "task-1" },
  ];

  assert.equal(taskOwnsTurn(history, 7), true);
  assert.equal(taskOwnsTurn(history, 8), false);
  assert.equal(taskOwnsTurn([], 7), false);
});

test("task-owned tool calls do not render duplicate standalone activity cards", () => {
  assert.equal(
    shouldRenderStandaloneToolActivity({
      accepted: true,
      stepId: "task-1-step-2",
    }),
    false,
  );
  assert.equal(
    shouldRenderStandaloneToolActivity({ accepted: false }),
    true,
  );
  assert.equal(shouldRenderStandaloneToolActivity(null), true);
});
