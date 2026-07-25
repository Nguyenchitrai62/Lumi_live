import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionInstruction } from "../live/session-config.js";
import { buildBrowserToolFailureResponse } from "../side-panel/browser-tool-recovery.js";

test("marks ordinary browser state failures as requiring recovery", () => {
  const failure = buildBrowserToolFailureResponse(
    new Error("The element is stale and the indexed control is no longer available."),
  );
  assert.equal(failure.recoverable, true);
  assert.equal(failure.recoveryRequired, true);
  assert.match(failure.guidance, /Do not stop yet/i);
  assert.match(failure.guidance, /fresh semantic page state/i);
});

test("keeps true blockers hard but lets the model recover from redundant confirmation checks", () => {
  const permissionFailure = buildBrowserToolFailureResponse(
    new Error("Lumi needs Chrome's debugger permission."),
  );
  const confirmationFailure = buildBrowserToolFailureResponse(
    new Error("Ask the user to authorize the exact paths and destination."),
  );
  assert.equal(permissionFailure.recoverable, false);
  assert.equal(permissionFailure.blockerType, "hard");
  assert.equal(confirmationFailure.recoverable, true);
  assert.equal(confirmationFailure.blockerType, "authorization_check");
  assert.equal(confirmationFailure.authorizationReviewRequired, true);
  assert.match(confirmationFailure.guidance, /retry immediately with confirmed=true/i);
});

test("requires distinct recovery tactics before reporting a browser failure", () => {
  const instruction = buildSessionInstruction();
  assert.match(instruction, /browser-tool error is not a terminal result by default/i);
  assert.match(instruction, /at least three distinct recovery tactics/i);
  assert.match(instruction, /never repeat the identical failed action/i);
  assert.match(instruction, /quote the exact last error/i);
});
