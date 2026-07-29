import { AGENT_DONE_ACTION_NAME } from "./agent-protocol.js";
import {
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_COMPLETION_RECOVERY_LIMIT,
  DEFAULT_IDENTICAL_STATE_ACTION_LIMIT,
} from "../core/ui-config.js";

const VOLATILE_RESULT_KEYS = new Set([
  "duration",
  "durationMs",
  "elapsed",
  "timestamp",
  "startedAt",
  "completedAt",
  "previewDataUrl",
]);
export const MAX_TASK_REQUEST_ANCHOR_CHARS = 1800;

function cleanText(value, maxLength = 2400) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function stableValue(value, depth = 0) {
  if (depth > 8) return "[depth]";
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => stableValue(item, depth + 1));
  if (!value || typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !VOLATILE_RESULT_KEYS.has(key))
      .sort()
      .slice(0, 80)
      .map((key) => [key, stableValue(value[key], depth + 1)]),
  );
}

export function stableStringify(value) {
  try {
    return JSON.stringify(stableValue(value));
  } catch {
    return String(value);
  }
}

export function fingerprintValue(value) {
  const input = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function fingerprintObservation(value) {
  const verification = value?.controllerVerification;
  if (verification?.available) {
    return fingerprintValue({
      source: verification.source,
      url: verification.url,
      title: verification.title,
      query: verification.query,
      queryMatched: verification.queryMatched,
      content: verification.content,
      conclusive: verification.conclusive,
    });
  }
  if (value && typeof value === "object" && (
    value.content !== undefined
    || value.url !== undefined
    || value.queryMatched !== undefined
    || value.condition !== undefined
  )) {
    return fingerprintValue({
      url: value.url,
      title: value.title,
      content: value.content,
      query: value.query,
      queryMatched: value.queryMatched,
      condition: value.condition,
      status: value.status,
      selected: value.selected,
      disabled: value.disabled,
    });
  }
  return fingerprintValue(value);
}

function summarizeResult(result) {
  if (result?.error) return cleanText(result.error, 900);
  for (const key of ["message", "result", "data", "content", "status", "title", "url"]) {
    const text = cleanText(result?.[key], 900);
    if (text) return text;
  }
  return cleanText(stableStringify(result), 900) || "Action completed without a textual result.";
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function taskEvents(history, taskId) {
  return history.filter((event) => event.taskId === taskId);
}

export function createTaskOrchestrator({
  maxSteps = DEFAULT_AGENT_MAX_STEPS,
  identicalStateActionLimit = DEFAULT_IDENTICAL_STATE_ACTION_LIMIT,
  completionRecoveryLimit = DEFAULT_COMPLETION_RECOVERY_LIMIT,
  now = Date.now,
  onHistoryChange = () => {},
} = {}) {
  const configuredMaxSteps = Number(maxSteps);
  const configuredRepeatedActionLimit = Number(identicalStateActionLimit);
  const configuredCompletionRetryLimit = Number(completionRecoveryLimit);
  const defaultMaxSteps = Math.max(
    1,
    Math.trunc(
      Number.isFinite(configuredMaxSteps)
        ? configuredMaxSteps
        : DEFAULT_AGENT_MAX_STEPS,
    ),
  );
  const repeatedActionLimit = Math.max(
    1,
    Math.trunc(
      Number.isFinite(configuredRepeatedActionLimit)
        ? configuredRepeatedActionLimit
        : DEFAULT_IDENTICAL_STATE_ACTION_LIMIT,
    ),
  );
  const completionRetryLimit = Math.max(
    0,
    Math.trunc(
      Number.isFinite(configuredCompletionRetryLimit)
        ? configuredCompletionRetryLimit
        : DEFAULT_COMPLETION_RECOVERY_LIMIT,
    ),
  );
  let history = [];
  let taskSequence = 0;
  let eventSequence = 0;

  const emit = (event, change = "append") => {
    onHistoryChange(history, event, change);
    return event;
  };

  const append = (event) => {
    const next = Object.freeze({
      id: `event-${++eventSequence}`,
      at: nowIso(now),
      ...event,
    });
    history = [...history, next];
    return emit(next);
  };

  const replace = (eventId, update) => {
    let nextEvent = null;
    history = history.map((event) => {
      if (event.id !== eventId) return event;
      nextEvent = Object.freeze({ ...event, ...update });
      return nextEvent;
    });
    if (nextEvent) emit(nextEvent, "replace");
    return nextEvent;
  };

  const latestTaskStart = () =>
    [...history].reverse().find((event) => event.type === "task_started") || null;

  const latestTaskDone = (taskId) =>
    [...history].reverse().find(
      (event) => event.taskId === taskId && event.type === "task_done",
    ) || null;

  const activeTask = () => {
    const started = latestTaskStart();
    if (!started || latestTaskDone(started.taskId)) return null;
    return started;
  };

  const actionSteps = (taskId) =>
    taskEvents(history, taskId).filter(
      (event) => event.type === "step" && event.action.name !== AGENT_DONE_ACTION_NAME,
    );

  const completedSteps = (taskId) =>
    taskEvents(history, taskId).filter(
      (event) => event.type === "step" && event.action.status === "completed",
    );

  const consecutiveFailureCount = (taskId) => {
    let count = 0;
    const steps = taskEvents(history, taskId)
      .filter((event) => event.type === "step")
      .reverse();
    for (const step of steps) {
      if (
        step.action.kind === "browser_observation"
        && step.action.status === "completed"
      ) continue;
      if (step.action.status === "failed") {
        count += 1;
        continue;
      }
      break;
    }
    return count;
  };

  const latestUnverifiedBrowserAction = (taskId) =>
    [...taskEvents(history, taskId)].reverse().find(
      (event) => event.type === "step"
        && event.action.kind === "browser_action"
        && ["completed", "failed"].includes(event.action.status)
        && event.observation?.verification?.status !== "observed",
    ) || null;

  const rejectStepConstraint = (taskId, code, message) => {
    append({
      type: "error",
      taskId,
      code,
      message,
    });
    return {
      accepted: false,
      reason: code,
      checkpoint: checkpoint(taskId),
    };
  };

  const checkpoint = (taskId) => {
    const started = history.find(
      (event) => event.taskId === taskId && event.type === "task_started",
    );
    const done = latestTaskDone(taskId);
    const usedSteps = actionSteps(taskId).filter(
      (event) => event.action.status !== "loop_blocked",
    ).length;
    const remainingSteps = Math.max(
      0,
      (started?.maxSteps || defaultMaxSteps) - usedSteps,
    );
    const consecutiveFailures = consecutiveFailureCount(taskId);
    const warning = consecutiveFailures >= 3 && !done
      ? `${consecutiveFailures} consecutive actions failed. Re-plan from the ordered remaining goals and choose a different supported interaction path.`
      : remainingSteps === 5
      ? "Only 5 action steps remain; converge on the requested outcome."
      : remainingSteps <= 2 && !done
        ? `Critical: only ${remainingSteps} action step${remainingSteps === 1 ? "" : "s"} remain. Finish or call done with a partial result.`
        : "";
    const latestStep = [...taskEvents(history, taskId)].reverse().find(
      (event) => event.type === "step",
    );
    return {
      taskId,
      requestAnchor: cleanText(
        started?.request,
        MAX_TASK_REQUEST_ANCHOR_CHARS,
      ),
      status: done ? (done.success ? "completed" : "failed") : "running",
      usedSteps,
      maxSteps: started?.maxSteps || defaultMaxSteps,
      remainingSteps,
      consecutiveFailures,
      currentGoal: cleanText(latestStep?.reflection?.nextGoal, 500),
      remainingGoalCount: Array.isArray(latestStep?.reflection?.remainingGoals)
        ? latestStep.reflection.remainingGoals.length
        : 0,
      warning,
    };
  };

  const completeTask = ({
    taskId = activeTask()?.taskId,
    success = false,
    result = "",
    evidence = "",
    completedGoals = [],
    reason = "done",
  } = {}) => {
    if (!taskId) return null;
    const existing = latestTaskDone(taskId);
    if (existing) return existing;
    return append({
      type: "task_done",
      taskId,
      success: success === true,
      result: cleanText(result, 3000) || (success ? "Task completed." : "Task did not complete."),
      evidence: cleanText(evidence, 3000),
      completedGoals: Array.isArray(completedGoals)
        ? completedGoals.slice(0, 24).map((goal) => ({
            goal: cleanText(goal?.goal, 1600),
            evidence: cleanText(goal?.evidence, 2400),
          }))
        : [],
      reason,
    });
  };

  const startTask = (request, metadata = {}) => {
    const running = activeTask();
    if (running) {
      completeTask({
        taskId: running.taskId,
        success: false,
        result: "Task was superseded by a newer user request.",
        reason: "superseded",
      });
    }
    const taskId = `task-${++taskSequence}`;
    append({
      type: "task_started",
      taskId,
      request: cleanText(request, 4000) || "Voice browser task",
      maxSteps: Math.max(
        1,
        Math.trunc(Number(metadata.maxSteps) || defaultMaxSteps),
      ),
      turnSequence: Number(metadata.turnSequence) || 0,
    });
    return taskId;
  };

  const ensureTask = (request, metadata = {}) => {
    const running = activeTask();
    if (
      running
      && (!metadata.turnSequence || running.turnSequence === metadata.turnSequence)
    ) return running.taskId;
    return startTask(request, metadata);
  };

  const beginStep = ({ taskId = activeTask()?.taskId, reflection, action } = {}) => {
    if (!taskId) throw new Error("No active Lumi task.");
    const started = history.find(
      (event) => event.taskId === taskId && event.type === "task_started",
    );
    if (!started || latestTaskDone(taskId)) {
      throw new Error("This Lumi task is no longer active.");
    }
    const name = cleanText(action?.name, 180);
    if (!name || !action?.input || typeof action.input !== "object" || Array.isArray(action.input)) {
      throw new Error("A Lumi step requires exactly one named action with one argument object.");
    }
    const actionKind = cleanText(action.kind, 80)
      || (name === AGENT_DONE_ACTION_NAME ? "done" : "tool_action");
    const unverifiedBrowserAction = latestUnverifiedBrowserAction(taskId);
    if (
      name === AGENT_DONE_ACTION_NAME
      && action.input.success === true
      && unverifiedBrowserAction
    ) {
      return rejectStepConstraint(
        taskId,
        "verification_required",
        `Cannot complete the task yet: ${unverifiedBrowserAction.action.name} has no fresh post-action browser observation.`,
      );
    }
    if (
      actionKind === "browser_action"
      && unverifiedBrowserAction
    ) {
      return rejectStepConstraint(
        taskId,
        "verification_required",
        `Observe fresh browser state before another action; ${unverifiedBrowserAction.action.name} is still unverified.`,
      );
    }
    if (
      actionKind === "browser_action"
      && !completedSteps(taskId).some(
        (event) => event.action.kind === "browser_observation",
      )
    ) {
      return rejectStepConstraint(
        taskId,
        "observation_required",
        `Observe the current browser state before running ${name}.`,
      );
    }
    if (
      name === AGENT_DONE_ACTION_NAME
      && action.input.success === true
      && completedSteps(taskId).length === 0
    ) {
      return rejectStepConstraint(
        taskId,
        "premature_done",
        "Cannot report success before at least one task step has completed.",
      );
    }
    const usedSteps = actionSteps(taskId).filter(
      (event) => event.action.status !== "loop_blocked",
    ).length;
    if (name !== AGENT_DONE_ACTION_NAME && usedSteps >= started.maxSteps) {
      append({
        type: "error",
        taskId,
        code: "max_steps",
        message: `Step budget exhausted after ${started.maxSteps} actions.`,
      });
      completeTask({
        taskId,
        success: false,
        result: `Step budget exhausted after ${started.maxSteps} actions.`,
        evidence: "The controller stopped the loop before another action could run.",
        reason: "max_steps",
      });
      return {
        accepted: false,
        reason: "max_steps",
        checkpoint: checkpoint(taskId),
      };
    }

    const previousCompletedStep = [...taskEvents(history, taskId)].reverse().find(
      (event) => event.type === "step" && event.observation?.fingerprint,
    );
    const contextFingerprint = previousCompletedStep?.observation?.fingerprint || "initial";
    const actionFingerprint = fingerprintValue({
      name,
      input: action.input,
      contextFingerprint,
    });
    const repeatedCount = taskEvents(history, taskId).filter(
      (event) => event.type === "step"
        && event.actionFingerprint === actionFingerprint
        && event.action.status !== "loop_blocked",
    ).length;
    const previousSteps = taskEvents(history, taskId)
      .filter((event) => event.type === "step")
      .reverse();
    let sameActionFailures = 0;
    for (const previousStep of previousSteps) {
      if (
        previousStep.action.name !== name
        || previousStep.action.status !== "failed"
      ) break;
      sameActionFailures += 1;
    }
    const stepNumber = usedSteps + 1;

    if (
      name !== AGENT_DONE_ACTION_NAME
      && repeatedCount >= repeatedActionLimit
    ) {
      const blocked = append({
        type: "step",
        taskId,
        stepNumber,
        reflection,
        action: {
          name,
          input: action.input,
          kind: actionKind,
          status: "loop_blocked",
          output: null,
          error: "Repeated action blocked because the page/tool fingerprint did not change.",
          durationMs: 0,
        },
        actionFingerprint,
        contextFingerprint,
        retryAttempt: sameActionFailures,
        observation: {
          summary: "No action ran. Choose a different target, query, wait condition, or supported interaction path.",
          fingerprint: contextFingerprint,
          repeated: true,
        },
      });
      append({
        type: "loop_detected",
        taskId,
        stepId: blocked.id,
        message: "The same action and arguments were repeated against an unchanged observation.",
        fingerprint: actionFingerprint,
      });
      return {
        accepted: false,
        reason: "loop_detected",
        stepId: blocked.id,
        retryAttempt: sameActionFailures,
        checkpoint: checkpoint(taskId),
      };
    }

    if (sameActionFailures > 0) {
      append({
        type: "retry",
        taskId,
        actionName: name,
        attempt: sameActionFailures + 1,
        message: `Retrying ${name} after ${sameActionFailures} failed attempt${sameActionFailures === 1 ? "" : "s"}.`,
      });
    }
    const step = append({
      type: "step",
      taskId,
      stepNumber,
      reflection,
      action: {
        name,
        input: action.input,
        kind: actionKind,
        status: "running",
        output: null,
        error: "",
        durationMs: null,
      },
      actionFingerprint,
      contextFingerprint,
      retryAttempt: sameActionFailures,
      observation: null,
    });
    return {
      accepted: true,
      stepId: step.id,
      stepNumber,
      retryAttempt: sameActionFailures,
      checkpoint: checkpoint(taskId),
    };
  };

  const finishStep = (stepId, { result, error = "", durationMs = 0 } = {}) => {
    const step = history.find((event) => event.id === stepId && event.type === "step");
    if (!step) throw new Error(`Unknown Lumi step: ${stepId}`);
    const failed = Boolean(error || result?.error || result?.success === false);
    const failureDetail = failed
      ? cleanText(
          error
          || result?.error
          || result?.message
          || "The action returned success=false.",
          2400,
        )
      : "";
    const observationValue = failed
      ? { error: failureDetail, result }
      : result;
    const controllerVerification = result?.controllerVerification;
    const verification = step.action.kind === "browser_action"
      ? {
          required: true,
          status: !failed
            && controllerVerification?.available === true
            && controllerVerification?.conclusive !== false
            ? "observed"
            : "required",
          evidence: !failed
            && controllerVerification?.available === true
            && controllerVerification?.conclusive !== false
            ? summarizeResult(controllerVerification)
            : "",
          source: controllerVerification?.source || "",
        }
      : {
          required: false,
          status: "not_required",
          evidence: "",
          source: "",
        };
    const updated = replace(stepId, {
      action: {
        ...step.action,
        status: failed ? "failed" : "completed",
        output: failed ? null : result,
        error: failureDetail,
        durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
      },
      observation: {
        summary: summarizeResult(observationValue),
        fingerprint: fingerprintObservation(observationValue),
        repeated: false,
        verification,
      },
    });
    if (step.action.kind === "browser_observation" && !failed) {
      const priorUnverified = latestUnverifiedBrowserAction(step.taskId);
      if (priorUnverified) {
        replace(priorUnverified.id, {
          observation: {
            ...priorUnverified.observation,
            verification: {
              required: true,
              status: "observed",
              evidence: summarizeResult(result),
              source: step.action.name,
              verifierStepId: step.id,
            },
          },
        });
      }
    }
    return {
      step: updated,
      checkpoint: checkpoint(step.taskId),
    };
  };

  const finishDoneStep = (stepId, doneInput) => {
    const finished = finishStep(stepId, {
      result: {
        success: doneInput.success,
        result: doneInput.result,
        evidence: doneInput.evidence || "",
      },
      durationMs: 0,
    });
    const done = completeTask({
      taskId: finished.step.taskId,
      success: doneInput.success,
      result: doneInput.result,
      evidence: doneInput.evidence || "",
      completedGoals: doneInput.completedGoals || [],
      reason: "done",
    });
    return {
      ...finished,
      done,
      checkpoint: checkpoint(finished.step.taskId),
    };
  };

  const recordProtocolError = (message, {
    taskId = activeTask()?.taskId,
    code = "protocol_error",
  } = {}) => {
    if (!taskId) return null;
    return append({
      type: "error",
      taskId,
      code,
      message: cleanText(message, 2400),
    });
  };

  const handleIncompleteTurn = (taskId = activeTask()?.taskId) => {
    if (!taskId || latestTaskDone(taskId)) {
      return { recover: false, checkpoint: taskId ? checkpoint(taskId) : null };
    }
    const attempts = taskEvents(history, taskId).filter(
      (event) => event.type === "completion_required",
    ).length + 1;
    append({
      type: "completion_required",
      taskId,
      attempt: attempts,
      message: "Gemini ended its turn before emitting the required done action.",
    });
    if (attempts <= completionRetryLimit && checkpoint(taskId).remainingSteps >= 0) {
      return {
        recover: true,
        attempt: attempts,
        checkpoint: checkpoint(taskId),
      };
    }
    completeTask({
      taskId,
      success: false,
      result: "The model ended without the required structured completion event.",
      evidence: `Completion recovery failed after ${attempts} attempts.`,
      reason: "completion_contract_failed",
    });
    return {
      recover: false,
      attempt: attempts,
      checkpoint: checkpoint(taskId),
    };
  };

  const cancelTask = (reason = "Cancelled by the user.") => {
    const running = activeTask();
    if (!running) return null;
    return completeTask({
      taskId: running.taskId,
      success: false,
      result: reason,
      reason: "cancelled",
    });
  };

  const clear = () => {
    history = [];
    taskSequence = 0;
    eventSequence = 0;
    onHistoryChange(history, null, "clear");
  };

  const restore = (storedHistory = []) => {
    const restored = Array.isArray(storedHistory)
      ? storedHistory
        .filter((event) => event && typeof event === "object")
        .map((event) => Object.freeze({ ...event }))
      : [];
    history = restored;
    taskSequence = restored.reduce((highest, event) => {
      const match = String(event.taskId || "").match(/^task-(\d+)$/);
      return Math.max(highest, Number(match?.[1]) || 0);
    }, 0);
    eventSequence = restored.reduce((highest, event) => {
      const match = String(event.id || "").match(/^event-(\d+)$/);
      return Math.max(highest, Number(match?.[1]) || 0);
    }, 0);
    onHistoryChange(history, null, "restore");
    return history;
  };

  return {
    get history() {
      return history;
    },
    get activeTask() {
      return activeTask();
    },
    beginStep,
    cancelTask,
    checkpoint,
    clear,
    restore,
    completeTask,
    ensureTask,
    finishDoneStep,
    finishStep,
    handleIncompleteTurn,
    recordProtocolError,
    startTask,
  };
}
