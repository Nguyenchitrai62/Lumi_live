import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_DONE_ACTION_NAME,
  AGENT_STEP_TOOL_NAME,
  buildAgentActionCatalog,
  buildAgentProtocolInstruction,
  buildAgentStepDeclaration,
  parseAgentStepCall,
} from "../live/agent-protocol.js";

const actions = [
  {
    name: "browser_click",
    description: "Click one indexed control.",
    parameters: {
      type: "OBJECT",
      properties: {
        index: { type: "NUMBER" },
        confirmed: { type: "BOOLEAN" },
      },
      required: ["index"],
    },
  },
  {
    name: "browser_get_page_state",
    description: "Observe semantic DOM state.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING" } },
    },
  },
];

test("exposes one macro tool with reflection, one action, and done", () => {
  const declaration = buildAgentStepDeclaration(actions);
  assert.equal(declaration.name, AGENT_STEP_TOOL_NAME);
  assert.deepEqual(
    declaration.parameters.properties.actionName.enum,
    ["browser_click", "browser_get_page_state", AGENT_DONE_ACTION_NAME],
  );
  assert.deepEqual(declaration.parameters.required, [
    "evaluationPreviousGoal",
    "memory",
    "nextGoal",
    "actionName",
    "actionArgumentsJson",
  ]);
  assert.match(declaration.description, /exactly one structured agent step/i);
});

test("builds a compact action catalog and strict completion contract", () => {
  const catalog = buildAgentActionCatalog(actions);
  assert.match(catalog, /browser_click \{index:number, confirmed\?:boolean\}/);
  assert.match(catalog, /done \{success:boolean, result:string/);
  const instruction = buildAgentProtocolInstruction(actions);
  assert.match(instruction, /reflection-before-action/i);
  assert.match(instruction, /Never substitute a plain-text final answer for done/i);
  assert.match(instruction, /Do not emit parallel step calls/i);
});

test("parses one structured action and validates JSON arguments", () => {
  const step = parseAgentStepCall({
    id: "call-1",
    name: AGENT_STEP_TOOL_NAME,
    args: {
      evaluationPreviousGoal: "No previous action exists.",
      memory: "Target row is 333.pdf.",
      nextGoal: "Select the matching checkbox.",
      actionName: "browser_click",
      actionArgumentsJson: '{"index":17,"confirmed":false}',
    },
  }, actions.map((action) => action.name));
  assert.equal(step.callId, "call-1");
  assert.equal(step.action.name, "browser_click");
  assert.deepEqual(step.action.input, { index: 17, confirmed: false });
  assert.throws(
    () => parseAgentStepCall({
      name: AGENT_STEP_TOOL_NAME,
      args: {
        evaluationPreviousGoal: "Observed.",
        memory: "Known.",
        nextGoal: "Act.",
        actionName: "browser_click",
        actionArgumentsJson: "not-json",
      },
    }, ["browser_click"]),
    /valid JSON object string/i,
  );
});

test("uses a neutral memory fallback instead of blocking an otherwise valid step", () => {
  const step = parseAgentStepCall({
    id: "call-empty-memory",
    name: AGENT_STEP_TOOL_NAME,
    args: {
      evaluationPreviousGoal: "No previous action exists.",
      memory: "",
      nextGoal: "Observe the page.",
      actionName: "browser_get_page_state",
      actionArgumentsJson: "{}",
    },
  }, actions);
  assert.equal(step.reflection.memory, "No durable facts yet.");
});

test("validates and safely coerces action arguments using the selected tool schema", () => {
  const step = parseAgentStepCall({
    id: "call-typed",
    name: AGENT_STEP_TOOL_NAME,
    args: {
      evaluationPreviousGoal: "The target control is visible.",
      memory: "Use index 17 from the latest page state.",
      nextGoal: "Click the target.",
      actionName: "browser_click",
      actionArgumentsJson: '{"index":"17","confirmed":"false"}',
    },
  }, actions);
  assert.deepEqual(step.action.input, { index: 17, confirmed: false });
  assert.equal(step.action.kind, "browser_action");
  assert.throws(
    () => parseAgentStepCall({
      name: AGENT_STEP_TOOL_NAME,
      args: {
        evaluationPreviousGoal: "Observed.",
        memory: "Known.",
        nextGoal: "Click.",
        actionName: "browser_click",
        actionArgumentsJson: '{"index":17,"invented":true}',
      },
    }, actions),
    /invented is not a declared parameter/i,
  );
});

test("requires a typed done payload", () => {
  assert.throws(
    () => parseAgentStepCall({
      name: AGENT_STEP_TOOL_NAME,
      args: {
        evaluationPreviousGoal: "The requested page change is visible.",
        memory: "All checklist items are complete.",
        nextGoal: "Finish.",
        actionName: "done",
        actionArgumentsJson: '{"success":"yes","result":"Finished"}',
      },
    }, actions.map((action) => action.name)),
    /boolean success/i,
  );
  const done = parseAgentStepCall({
    name: AGENT_STEP_TOOL_NAME,
    args: {
      evaluationPreviousGoal: "The requested page change is visible.",
      memory: "All checklist items are complete.",
      nextGoal: "Finish.",
      actionName: "done",
      actionArgumentsJson: '{"success":true,"result":"Finished","evidence":"Visible success state","completedGoals":[{"goal":"Finish the requested change","evidence":"Visible success state"}]}',
    },
  }, actions.map((action) => action.name));
  assert.equal(done.action.input.success, true);
  assert.equal(done.action.input.completedGoals.length, 1);
  assert.throws(
    () => parseAgentStepCall({
      name: AGENT_STEP_TOOL_NAME,
      args: {
        evaluationPreviousGoal: "The page changed.",
        memory: "Potentially complete.",
        nextGoal: "Finish.",
        actionName: "done",
        actionArgumentsJson: '{"success":true,"result":"Finished","evidence":"Visible success state"}',
      },
    }, actions),
    /completedGoals/i,
  );
});
