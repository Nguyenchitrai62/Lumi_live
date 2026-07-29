import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserToolRunner } from "../side-panel/browser-tool-runner.js";

test("returns partial stage metadata to Gemini and presents it as an error state", async () => {
  const transitions = [];
  let running = false;
  const partial = {
    success: false,
    status: "partial",
    error: "The fourth control was replaced.",
    ledgerId: "stage-one",
    resume: {
      nextActionNumber: 4,
      requiresFreshObservation: true,
    },
  };
  const runBrowserTool = createBrowserToolRunner({
    isUiAction: () => true,
    avatarController: {
      transitionState(state) {
        transitions.push(state);
      },
    },
    successStateDurationMs: 10,
    errorStateDurationMs: 10,
    inspectScreenshot: async () => ({}),
    sendBrowserTool: async () => partial,
    showCapturedScreenshot() {},
    collectVerification: async () => ({
      available: true,
      conclusive: false,
      stateId: "fresh-state",
    }),
    setRunning(value) {
      running = value;
    },
    setStatus() {},
    refreshTarget: async () => {},
  });

  const result = await runBrowserTool("browser_apply_stage", {});

  assert.equal(result.status, "partial");
  assert.equal(result.ledgerId, "stage-one");
  assert.equal(result.controllerVerification.stateId, "fresh-state");
  assert.deepEqual(transitions, ["ui_control", "error"]);
  assert.equal(running, false);
});
