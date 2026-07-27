import assert from "node:assert/strict";
import test from "node:test";

import {
  createTaskOrchestrator,
  fingerprintObservation,
  fingerprintValue,
  stableStringify,
} from "../live/task-orchestrator.js";
import { buildTaskStepViewModel } from "../side-panel/task-step-view.js";
import { DEFAULT_AGENT_MAX_STEPS } from "../core/ui-config.js";

const reflection = {
  evaluationPreviousGoal: "The previous goal was checked against the observation.",
  memory: "Keep the exact target identifier.",
  nextGoal: "Perform one next action.",
};

test("uses the central UI config for the default task step budget", () => {
  const orchestrator = createTaskOrchestrator();
  const taskId = orchestrator.startTask("Use the configured budget.");
  assert.equal(orchestrator.checkpoint(taskId).maxSteps, DEFAULT_AGENT_MAX_STEPS);
});

test("uses historical events as the task source of truth", () => {
  const snapshots = [];
  const orchestrator = createTaskOrchestrator({
    maxSteps: 4,
    now: () => 1000,
    onHistoryChange: (history) => snapshots.push(history),
  });
  const taskId = orchestrator.startTask("Open the result and verify it.", {
    turnSequence: 7,
  });
  const started = orchestrator.beginStep({
    taskId,
    reflection,
    action: { name: "browser_get_page_state", input: { query: "result" } },
  });
  assert.equal(started.accepted, true);
  const finished = orchestrator.finishStep(started.stepId, {
    result: { success: true, content: "Result ready" },
    durationMs: 18.7,
  });
  assert.equal(finished.step.action.status, "completed");
  assert.equal(finished.step.action.durationMs, 19);

  const doneStep = orchestrator.beginStep({
    taskId,
    reflection: { ...reflection, nextGoal: "Finish the task." },
    action: {
      name: "done",
      input: {
        success: true,
        result: "The result was opened.",
        evidence: "Result ready was observed.",
      },
    },
  });
  orchestrator.finishDoneStep(doneStep.stepId, doneStep.accepted && {
    success: true,
    result: "The result was opened.",
    evidence: "Result ready was observed.",
  });

  assert.deepEqual(
    orchestrator.history.map((event) => event.type),
    ["task_started", "step", "step", "task_done"],
  );
  assert.equal(orchestrator.activeTask, null);
  assert.equal(orchestrator.checkpoint(taskId).status, "completed");
  assert.ok(snapshots.length >= 5);
  const view = buildTaskStepViewModel(orchestrator.history);
  assert.equal(view[0].steps.length, 2);
  assert.equal(view[0].status, "completed");
});

test("blocks repeated actions against an unchanged observation fingerprint", () => {
  const orchestrator = createTaskOrchestrator({
    maxSteps: 8,
    identicalStateActionLimit: 2,
  });
  const taskId = orchestrator.startTask("Click the target.");
  const runSameStep = () => {
    const step = orchestrator.beginStep({
      taskId,
      reflection,
      action: { name: "browser_click", input: { index: 4 } },
    });
    if (step.accepted) {
      orchestrator.finishStep(step.stepId, {
        result: { success: true, content: "Unchanged page" },
      });
    }
    return step;
  };

  assert.equal(runSameStep().accepted, true);
  assert.equal(runSameStep().accepted, true);
  assert.equal(runSameStep().accepted, true);
  const blocked = runSameStep();
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, "loop_detected");
  assert.ok(orchestrator.history.some((event) => event.type === "loop_detected"));
  assert.equal(orchestrator.checkpoint(taskId).usedSteps, 3);
});

test("enforces the step budget and records a terminal failure", () => {
  const orchestrator = createTaskOrchestrator({ maxSteps: 2 });
  const taskId = orchestrator.startTask("Try two bounded actions.");
  for (const index of [1, 2]) {
    const step = orchestrator.beginStep({
      taskId,
      reflection,
      action: { name: "browser_scroll", input: { pages: index } },
    });
    assert.equal(step.accepted, true);
    orchestrator.finishStep(step.stepId, { result: { success: true, index } });
  }
  const rejected = orchestrator.beginStep({
    taskId,
    reflection,
    action: { name: "browser_scroll", input: { pages: 3 } },
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "max_steps");
  assert.equal(orchestrator.checkpoint(taskId).status, "failed");
  assert.equal(
    orchestrator.history.at(-1).reason,
    "max_steps",
  );
});

test("marks only consecutive failures of the same action as retries", () => {
  const orchestrator = createTaskOrchestrator({ maxSteps: 6 });
  const taskId = orchestrator.startTask("Recover from one failed click.");
  const failedClick = orchestrator.beginStep({
    taskId,
    reflection,
    action: { name: "browser_click", input: { index: 2 } },
  });
  orchestrator.finishStep(failedClick.stepId, {
    result: { error: "Covered by a dialog" },
    error: "Covered by a dialog",
  });
  const observation = orchestrator.beginStep({
    taskId,
    reflection,
    action: { name: "browser_get_page_state", input: {} },
  });
  assert.equal(observation.retryAttempt, 0);
  orchestrator.finishStep(observation.stepId, {
    result: { success: true, content: "Dialog is open" },
  });
  const laterClick = orchestrator.beginStep({
    taskId,
    reflection,
    action: { name: "browser_click", input: { index: 3 } },
  });
  assert.equal(laterClick.retryAttempt, 0);
});

test("enforces observe-act-verify while accepting automatic post-action evidence", () => {
  const orchestrator = createTaskOrchestrator({ maxSteps: 6 });
  const taskId = orchestrator.startTask("Click Save and verify the result.");
  const prematureAction = orchestrator.beginStep({
    taskId,
    reflection,
    action: {
      name: "browser_click",
      kind: "browser_action",
      input: { index: 7 },
    },
  });
  assert.equal(prematureAction.accepted, false);
  assert.equal(prematureAction.reason, "observation_required");

  const observe = orchestrator.beginStep({
    taskId,
    reflection,
    action: {
      name: "browser_get_page_state",
      kind: "browser_observation",
      input: { query: "Save" },
    },
  });
  orchestrator.finishStep(observe.stepId, {
    result: { success: true, content: "Save [7]" },
  });
  const click = orchestrator.beginStep({
    taskId,
    reflection,
    action: {
      name: "browser_click",
      kind: "browser_action",
      input: { index: 7 },
    },
  });
  assert.equal(click.accepted, true);
  orchestrator.finishStep(click.stepId, {
    result: {
      success: true,
      controllerVerification: {
        available: true,
        conclusive: true,
        source: "automatic_post_action_page_state",
        content: "Saved",
      },
    },
  });
  const done = orchestrator.beginStep({
    taskId,
    reflection,
    action: {
      name: "done",
      kind: "done",
      input: {
        success: true,
        result: "Saved.",
        evidence: "Saved is visible.",
        completedGoals: [{ goal: "Save", evidence: "Saved is visible." }],
      },
    },
  });
  assert.equal(done.accepted, true);
});

test("requires an explicit observation when automatic verification is inconclusive", () => {
  const orchestrator = createTaskOrchestrator({ maxSteps: 6 });
  const taskId = orchestrator.startTask("Upload one file and verify transfer completion.");
  const observe = orchestrator.beginStep({
    taskId,
    reflection,
    action: {
      name: "browser_get_page_state",
      kind: "browser_observation",
      input: { query: "Upload" },
    },
  });
  orchestrator.finishStep(observe.stepId, {
    result: { success: true, content: "Upload [3]" },
  });
  const upload = orchestrator.beginStep({
    taskId,
    reflection,
    action: {
      name: "browser_upload_file",
      kind: "browser_action",
      input: { index: 3, filePaths: ["F:\\demo.pdf"], confirmed: true },
    },
  });
  orchestrator.finishStep(upload.stepId, {
    result: {
      success: true,
      requiresPageVerification: true,
      controllerVerification: {
        available: true,
        conclusive: false,
        content: "demo.pdf selected",
      },
    },
  });
  const blockedDone = orchestrator.beginStep({
    taskId,
    reflection,
    action: {
      name: "done",
      kind: "done",
      input: {
        success: true,
        result: "Uploaded.",
        evidence: "demo.pdf selected",
        completedGoals: [{ goal: "Upload", evidence: "demo.pdf selected" }],
      },
    },
  });
  assert.equal(blockedDone.accepted, false);
  assert.equal(blockedDone.reason, "verification_required");

  const verify = orchestrator.beginStep({
    taskId,
    reflection,
    action: {
      name: "browser_wait_for_page_state",
      kind: "browser_observation",
      input: { query: "Upload complete" },
    },
  });
  orchestrator.finishStep(verify.stepId, {
    result: { success: true, condition: "present", content: "Upload complete" },
  });
  const completed = orchestrator.beginStep({
    taskId,
    reflection,
    action: {
      name: "done",
      kind: "done",
      input: {
        success: true,
        result: "Uploaded.",
        evidence: "Upload complete is visible.",
        completedGoals: [{
          goal: "Upload",
          evidence: "Upload complete is visible.",
        }],
      },
    },
  });
  assert.equal(completed.accepted, true);
});

test("recovers a missing done event twice, then closes the task", () => {
  const orchestrator = createTaskOrchestrator({
    completionRecoveryLimit: 2,
  });
  const taskId = orchestrator.startTask("Use a tool and finish.");
  assert.equal(orchestrator.handleIncompleteTurn(taskId).recover, true);
  assert.equal(orchestrator.handleIncompleteTurn(taskId).recover, true);
  assert.equal(orchestrator.handleIncompleteTurn(taskId).recover, false);
  assert.equal(orchestrator.checkpoint(taskId).status, "failed");
  assert.equal(
    orchestrator.history.filter((event) => event.type === "completion_required").length,
    3,
  );
});

test("allows completion recovery to be disabled from central tuning", () => {
  const orchestrator = createTaskOrchestrator({
    completionRecoveryLimit: 0,
  });
  const taskId = orchestrator.startTask("Do not recover a missing done.");
  assert.equal(orchestrator.handleIncompleteTurn(taskId).recover, false);
  assert.equal(orchestrator.checkpoint(taskId).status, "failed");
});

test("fingerprints stable observations while ignoring volatile timing fields", () => {
  const first = { success: true, durationMs: 12, nested: { b: 2, a: 1 } };
  const second = { nested: { a: 1, b: 2 }, durationMs: 999, success: true };
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(fingerprintValue(first), fingerprintValue(second));
  assert.equal(
    fingerprintObservation({
      workflowContinuation: { originalUserRequest: "request one" },
      controllerVerification: {
        available: true,
        source: "automatic_post_action_page_state",
        url: "https://example.com",
        content: "Saved",
      },
    }),
    fingerprintObservation({
      workflowContinuation: { originalUserRequest: "different metadata" },
      controllerVerification: {
        available: true,
        source: "automatic_post_action_page_state",
        url: "https://example.com",
        content: "Saved",
      },
    }),
  );
});
