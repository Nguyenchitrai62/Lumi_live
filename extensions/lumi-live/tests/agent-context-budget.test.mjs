import assert from "node:assert/strict";
import test from "node:test";

import {
  boundAgentObservationForModel,
  MAX_BROWSER_ACTION_CONTEXT_CHARS,
  MAX_BROWSER_OBSERVATION_CONTEXT_CHARS,
  MAX_DONE_CONTEXT_CHARS,
  MAX_TOOL_ACTION_CONTEXT_CHARS,
} from "../side-panel/agent-context-budget.js";

test("passes small current observations through unchanged", () => {
  const observation = {
    success: true,
    content: "The requested row is visible.",
    indices: [3, 7],
  };
  assert.equal(
    boundAgentObservationForModel(observation, {
      actionKind: "browser_observation",
      actionName: "browser_get_page_state",
    }),
    observation,
  );
});

test("bounds broad browser observations locally without mutating the full result", () => {
  const fullObservation = {
    success: true,
    content: `Target row\n${"page-state ".repeat(7000)}`,
    semanticAnchors: Array.from({ length: 80 }, (_, index) => ({
      index,
      label: `control-${index}-${"detail ".repeat(100)}`,
    })),
    controllerVerification: {
      available: true,
      content: "verification ".repeat(2000),
    },
  };

  const bounded = boundAgentObservationForModel(fullObservation, {
    actionKind: "browser_observation",
    actionName: "browser_get_page_state",
  });

  assert.equal(fullObservation.semanticAnchors.length, 80);
  assert.ok(fullObservation.content.length > MAX_BROWSER_OBSERVATION_CONTEXT_CHARS);
  assert.ok(JSON.stringify(bounded).length <= MAX_BROWSER_OBSERVATION_CONTEXT_CHARS);
  assert.equal(bounded.contextBudget.truncated, true);
  assert.equal(bounded.contextBudget.action, "browser_get_page_state");
  assert.match(bounded.content, /bounded for active-step context/i);
});

test("omits binary payloads and applies the smaller action-result budget", () => {
  const result = {
    success: true,
    previewDataUrl: `data:image/png;base64,${"A".repeat(20000)}`,
    content: "clicked ".repeat(3000),
  };
  const bounded = boundAgentObservationForModel(result, {
    actionKind: "browser_action",
    actionName: "browser_click",
  });

  assert.ok(JSON.stringify(bounded).length <= MAX_BROWSER_ACTION_CONTEXT_CHARS);
  assert.match(bounded.previewDataUrl, /binary previewDataUrl omitted/i);
  assert.equal(bounded.contextBudget.policy, "latest_observation_and_task_anchor");
});

test("enforces every budget for pathologically wide and deeply nested results", () => {
  const leaf = "detail ".repeat(800);
  const pathological = Object.fromEntries(
    Array.from({ length: 100 }, (_, keyIndex) => [
      `key-${keyIndex}`,
      Array.from({ length: 100 }, (_, itemIndex) => ({
        itemIndex,
        first: leaf,
        second: leaf,
        third: leaf,
      })),
    ]),
  );
  for (const [actionKind, maxCharacters] of [
    ["browser_observation", MAX_BROWSER_OBSERVATION_CONTEXT_CHARS],
    ["browser_action", MAX_BROWSER_ACTION_CONTEXT_CHARS],
    ["tool_action", MAX_TOOL_ACTION_CONTEXT_CHARS],
    ["done", MAX_DONE_CONTEXT_CHARS],
  ]) {
    const bounded = boundAgentObservationForModel(pathological, { actionKind });
    assert.ok(
      JSON.stringify(bounded).length <= maxCharacters,
      `${actionKind} exceeded ${maxCharacters} characters`,
    );
    assert.equal(bounded.contextBudget.truncated, true);
  }
});
