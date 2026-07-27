import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldRenderStandaloneToolActivity,
  taskOwnsTurn,
} from "../side-panel/task-transcript-policy.js";

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
