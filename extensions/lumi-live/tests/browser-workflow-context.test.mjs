import assert from "node:assert/strict";
import test from "node:test";

import { addBrowserWorkflowContext } from "../side-panel/browser-workflow-context.js";
import { buildSessionInstruction } from "../live/session-config.js";

test("adds only a minimal continuation hint after each browser tool", () => {
  const result = addBrowserWorkflowContext(
    { uploaded: true, files: ["333.pdf"] },
    { toolName: "browser_upload_file" },
  );

  assert.equal(result.uploaded, true);
  assert.equal(result.workflowContinuation.completedTool, "browser_upload_file");
  assert.equal(result.workflowContinuation.resultScope, "intermediate");
  assert.match(result.workflowContinuation.continuationRule, /task\.requestAnchor/i);
  assert.match(result.workflowContinuation.continuationRule, /remainingGoals/i);
  assert.equal(
    Object.hasOwn(result.workflowContinuation, "originalUserRequest"),
    false,
  );
});

test("normalizes scalar browser results without repeating chat history", () => {
  const result = addBrowserWorkflowContext("Saved", {
    toolName: "browser_click",
    userRequest: "This ignored compatibility field must not enter the result.",
  });
  assert.equal(result.toolResult, "Saved");
  assert.equal(JSON.stringify(result).includes("ignored compatibility field"), false);
});

test("makes latest-request context discipline mandatory in the browser instruction", () => {
  const instruction = buildSessionInstruction();

  assert.match(instruction, /minimal workflowContinuation metadata/i);
  assert.match(instruction, /newest user-authored request is always authoritative/i);
  assert.match(instruction, /thin, low-priority conversational background/i);
  assert.match(instruction, /without a separate summarization step/i);
  assert.match(instruction, /successful upload is never permission to stop/i);
  assert.match(instruction, /Do not restate the full history/i);
});
