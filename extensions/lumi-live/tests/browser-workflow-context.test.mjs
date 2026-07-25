import assert from "node:assert/strict";
import test from "node:test";

import {
  addBrowserWorkflowContext,
  MAX_WORKFLOW_REQUEST_CHARS,
} from "../side-panel/browser-workflow-context.js";
import { buildSessionInstruction } from "../live/session-config.js";

test("reminds the model to complete the original multi-step browser request after every tool", () => {
  const request = "Upload C:\\Users\\trait\\Downloads\\333.pdf, overwrite duplicates, select it, then run Hawee AI.";
  const result = addBrowserWorkflowContext(
    { uploaded: true, files: ["333.pdf"] },
    { toolName: "browser_upload_file", userRequest: request },
  );

  assert.equal(result.uploaded, true);
  assert.equal(result.workflowContinuation.completedTool, "browser_upload_file");
  assert.equal(result.workflowContinuation.originalUserRequest, request);
  assert.match(result.workflowContinuation.resultScope, /intermediate/i);
  assert.match(result.workflowContinuation.continuationRule, /continue every explicitly requested unfinished action/i);
  assert.match(result.workflowContinuation.authorizationRule, /matching website confirmation dialogs/i);
});

test("normalizes and bounds repeated workflow context", () => {
  const result = addBrowserWorkflowContext(
    {},
    { userRequest: `  Upload\n\t${"x".repeat(MAX_WORKFLOW_REQUEST_CHARS * 2)}  ` },
  );
  assert.equal(result.workflowContinuation.originalUserRequest.includes("\n"), false);
  assert.equal(
    result.workflowContinuation.originalUserRequest.length,
    MAX_WORKFLOW_REQUEST_CHARS,
  );
});

test("makes workflow continuation metadata mandatory in the browser system instruction", () => {
  const instruction = buildSessionInstruction();

  assert.match(instruction, /workflowContinuation metadata/i);
  assert.match(instruction, /mandatory checkpoint after each tool call/i);
  assert.match(instruction, /successful upload is never permission to stop/i);
  assert.match(instruction, /Do not replace continuation with a progress summary or a redundant confirmation question/i);
});
