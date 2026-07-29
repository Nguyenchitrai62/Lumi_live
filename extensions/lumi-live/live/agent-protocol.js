export const AGENT_STEP_TOOL_NAME = "lumi_agent_step";
export const AGENT_DONE_ACTION_NAME = "done";
export const MAX_AGENT_ACTION_CATALOG_CHARS = 28000;

const BROWSER_OBSERVATION_ACTIONS = new Set([
  "browser_get_active_context",
  "browser_capture_screenshot",
  "browser_inspect_screenshot",
  "browser_get_page_state",
  "browser_find_semantic_context",
  "browser_get_stage_ledger",
  "browser_wait_for_page_state",
  "browser_list_tabs",
]);

export function classifyAgentAction(actionName) {
  const name = String(actionName || "").trim();
  if (name === AGENT_DONE_ACTION_NAME) return "done";
  if (BROWSER_OBSERVATION_ACTIONS.has(name)) return "browser_observation";
  if (name.startsWith("browser_")) return "browser_action";
  return "tool_action";
}

function normalizeActionDeclarations(actionDeclarations = []) {
  const seen = new Set();
  return (Array.isArray(actionDeclarations) ? actionDeclarations : [])
    .filter((declaration) => {
      const name = String(declaration?.name || "").trim();
      if (!name || name === AGENT_STEP_TOOL_NAME || seen.has(name)) return false;
      seen.add(name);
      return true;
    });
}

function schemaTypeLabel(schema) {
  const type = String(schema?.type || "value").trim().toLowerCase();
  if (schema?.enum?.length) {
    return schema.enum.map((value) => JSON.stringify(value)).join("|");
  }
  if (type === "array") return `${schemaTypeLabel(schema.items)}[]`;
  if (type === "object") return compactObjectSchema(schema);
  return type;
}

function compactObjectSchema(schema = {}) {
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(properties).map(([name, value]) =>
    `${name}${required.has(name) ? "" : "?"}:${schemaTypeLabel(value)}`);
  return `{${fields.join(", ")}}`;
}

function compactDescription(description) {
  return String(description || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
}

export function buildAgentActionCatalog(actionDeclarations = []) {
  const declarations = normalizeActionDeclarations(actionDeclarations);
  const lines = declarations.map((declaration) => {
    const schema = compactObjectSchema(declaration.parameters);
    const description = compactDescription(declaration.description);
    return `- ${declaration.name} ${schema}${description ? ` — ${description}` : ""}`;
  });
  lines.push(
    '- done {success:boolean, result:string, evidence:string, completedGoals?:{goal:string,evidence:string}[]} — Finish the whole tool task. success=true requires evidence and at least one completedGoals item.',
  );
  return lines.join("\n").slice(0, MAX_AGENT_ACTION_CATALOG_CHARS);
}

export function buildAgentStepDeclaration(actionDeclarations = []) {
  const actionNames = normalizeActionDeclarations(actionDeclarations)
    .map((declaration) => declaration.name);
  actionNames.push(AGENT_DONE_ACTION_NAME);
  return {
    name: AGENT_STEP_TOOL_NAME,
    description: "Execute exactly one structured agent step. Every browser, Live Translate, or MCP action must be invoked through this function. Reflect briefly, choose one available action, and encode that action's arguments as one JSON object string. Use actionName=done only after the complete user request has been verified or a concrete blocker remains.",
    parameters: {
      type: "OBJECT",
      properties: {
        evaluationPreviousGoal: {
          type: "STRING",
          description: "One concise sentence evaluating the previous action against its intended visible or tool result. On the first step say that no previous action exists.",
        },
        memory: {
          type: "STRING",
          description: 'Only durable facts, exact identifiers, successful discoveries, and blockers needed by later steps. Keep this short. If none exist, use "No durable facts yet." instead of an empty value.',
        },
        nextGoal: {
          type: "STRING",
          description: "The single immediate goal for this action, or finishing the task when actionName is done.",
        },
        actionName: {
          type: "STRING",
          enum: actionNames,
          description: "Exactly one action from the current Lumi action catalog.",
        },
        actionArgumentsJson: {
          type: "STRING",
          description: 'A valid JSON object string containing only the selected action parameters. Use "{}" when it takes no arguments.',
        },
      },
      required: [
        "evaluationPreviousGoal",
        "memory",
        "nextGoal",
        "actionName",
        "actionArgumentsJson",
      ],
    },
  };
}

export function buildAgentProtocolInstruction(actionDeclarations = []) {
  return `CODE-ENFORCED TASK PROTOCOL

For ordinary conversation that needs no tool, answer normally. Once a request needs any browser, Live Translate, or MCP action, use only ${AGENT_STEP_TOOL_NAME}. Never try to call an underlying action directly.

Each ${AGENT_STEP_TOOL_NAME} call is exactly one reflection-before-action step and must contain:
1. evaluationPreviousGoal: evidence-based evaluation of the previous action;
2. memory: short durable facts and exact identifiers only;
3. nextGoal: one immediate goal;
4. exactly one actionName and one JSON object in actionArgumentsJson.

Do not emit parallel step calls. After every action result, evaluate it before choosing the next action. Browser actions normally include controllerVerification from an automatic fresh post-action page read. When it is available and conclusive, use that evidence immediately and do not spend another step on a redundant observation. When it is unavailable or conclusive=false, the next step must be browser_get_page_state, browser_find_semantic_context, or browser_wait_for_page_state before another browser action or successful done. Change tactics when the controller reports a retry or repeated-state fingerprint. Respect remainingSteps warnings. Do not narrate intermediate progress unless the user needs to make a decision.

Completion is a strict contract: every tool task must end with another ${AGENT_STEP_TOOL_NAME} call whose actionName is done. For success use JSON {"success":true,"result":"concise final result","evidence":"observed proof","completedGoals":[{"goal":"one requested outcome","evidence":"fresh observation proving it"}]}. For a concrete blocker or partial result use success=false. Never substitute a plain-text final answer for done. Never call done immediately after an unverified browser action. After done is recorded, give the user one concise final response and take no more actions.

AVAILABLE ACTIONS
${buildAgentActionCatalog(actionDeclarations)}`;
}

function requireShortText(value, field) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`${AGENT_STEP_TOOL_NAME}.${field} is required.`);
  return text.slice(0, 1600);
}

function optionalShortText(value, fallback, maxLength = 1600) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength)
    || fallback;
}

function schemaNumber(value, path, integer = false) {
  const normalized = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
  if (!Number.isFinite(normalized) || (integer && !Number.isInteger(normalized))) {
    throw new Error(`${path} must be ${integer ? "an integer" : "a number"}.`);
  }
  return normalized;
}

function normalizeSchemaValue(schema = {}, value, path) {
  if (value === null) {
    if (schema.nullable === true || String(schema.type || "").toUpperCase() === "NULL") {
      return null;
    }
    throw new Error(`${path} must not be null.`);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const failures = [];
    for (const variant of schema.anyOf) {
      try {
        return normalizeSchemaValue(variant, value, path);
      } catch (error) {
        failures.push(error);
      }
    }
    throw failures[0] || new Error(`${path} does not match an allowed schema.`);
  }

  const type = String(schema.type || "").toUpperCase();
  let normalized = value;
  if (type === "OBJECT") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object.`);
    }
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const name of required) {
      if (value[name] === undefined) throw new Error(`${path}.${name} is required.`);
    }
    const unknown = Object.keys(value).find((name) => !Object.hasOwn(properties, name));
    if (unknown) throw new Error(`${path}.${unknown} is not a declared parameter.`);
    normalized = Object.fromEntries(
      Object.entries(value).map(([name, fieldValue]) => [
        name,
        normalizeSchemaValue(properties[name], fieldValue, `${path}.${name}`),
      ]),
    );
  } else if (type === "ARRAY") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
    const minItems = Number(schema.minItems);
    const maxItems = Number(schema.maxItems);
    if (Number.isFinite(minItems) && value.length < minItems) {
      throw new Error(`${path} requires at least ${minItems} item${minItems === 1 ? "" : "s"}.`);
    }
    if (Number.isFinite(maxItems) && value.length > maxItems) {
      throw new Error(`${path} allows at most ${maxItems} items.`);
    }
    normalized = value.map((item, index) =>
      normalizeSchemaValue(schema.items || {}, item, `${path}[${index}]`));
  } else if (type === "NUMBER") {
    normalized = schemaNumber(value, path);
  } else if (type === "INTEGER") {
    normalized = schemaNumber(value, path, true);
  } else if (type === "BOOLEAN") {
    if (value === "true") normalized = true;
    else if (value === "false") normalized = false;
    else if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  } else if (type === "STRING") {
    if (typeof value !== "string") throw new Error(`${path} must be a string.`);
    const minLength = Number(schema.minLength);
    const maxLength = Number(schema.maxLength);
    if (Number.isFinite(minLength) && value.length < minLength) {
      throw new Error(`${path} must contain at least ${minLength} characters.`);
    }
    if (Number.isFinite(maxLength) && value.length > maxLength) {
      throw new Error(`${path} must contain at most ${maxLength} characters.`);
    }
    if (schema.pattern) {
      let pattern;
      try {
        pattern = new RegExp(schema.pattern);
      } catch {
        pattern = null;
      }
      if (pattern && !pattern.test(value)) throw new Error(`${path} has an invalid format.`);
    }
  }

  if (Array.isArray(schema.enum) && schema.enum.length) {
    const allowed = schema.enum.map(String);
    if (!allowed.includes(String(normalized))) {
      throw new Error(`${path} must be one of: ${allowed.join(", ")}.`);
    }
  }
  if (["NUMBER", "INTEGER"].includes(type)) {
    if (Number.isFinite(schema.minimum) && normalized < schema.minimum) {
      throw new Error(`${path} must be at least ${schema.minimum}.`);
    }
    if (Number.isFinite(schema.maximum) && normalized > schema.maximum) {
      throw new Error(`${path} must be at most ${schema.maximum}.`);
    }
  }
  return normalized;
}

function validateCompletedGoals(value) {
  if (!Array.isArray(value) || !value.length) {
    throw new Error("done success=true requires at least one completedGoals item.");
  }
  return value.slice(0, 24).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`done.completedGoals[${index}] must be an object.`);
    }
    return {
      goal: requireShortText(item.goal, `done.completedGoals[${index}].goal`),
      evidence: requireShortText(
        item.evidence,
        `done.completedGoals[${index}].evidence`,
      ),
    };
  });
}

export function parseAgentStepCall(functionCall, availableActions = []) {
  if (functionCall?.name !== AGENT_STEP_TOOL_NAME) {
    throw new Error(`Tool tasks must call ${AGENT_STEP_TOOL_NAME}; received ${functionCall?.name || "an unnamed tool"}.`);
  }
  const input = functionCall.args && typeof functionCall.args === "object"
    ? functionCall.args
    : {};
  const actionName = String(input.actionName || "").trim();
  const declarations = (Array.isArray(availableActions) ? availableActions : [])
    .map((action) => typeof action === "string" ? { name: action } : action)
    .filter((action) => action?.name);
  const declarationsByName = new Map(
    declarations.map((declaration) => [declaration.name, declaration]),
  );
  const allowed = new Set([...declarationsByName.keys(), AGENT_DONE_ACTION_NAME]);
  if (!allowed.has(actionName)) {
    throw new Error(`Unknown or unavailable Lumi action: ${actionName || "(empty)"}.`);
  }
  let actionArguments;
  try {
    actionArguments = JSON.parse(String(input.actionArgumentsJson || "{}"));
  } catch {
    throw new Error(`${AGENT_STEP_TOOL_NAME}.actionArgumentsJson must be a valid JSON object string.`);
  }
  if (!actionArguments || typeof actionArguments !== "object" || Array.isArray(actionArguments)) {
    throw new Error(`${AGENT_STEP_TOOL_NAME}.actionArgumentsJson must decode to one JSON object.`);
  }
  if (actionName === AGENT_DONE_ACTION_NAME) {
    if (typeof actionArguments.success !== "boolean") {
      throw new Error("done requires a boolean success value.");
    }
    actionArguments.result = requireShortText(actionArguments.result, "done.result");
    actionArguments.evidence = optionalShortText(actionArguments.evidence, "", 2400);
    if (actionArguments.success) {
      if (!actionArguments.evidence) {
        throw new Error("done success=true requires observed evidence.");
      }
      actionArguments.completedGoals = validateCompletedGoals(
        actionArguments.completedGoals,
      );
    } else if (actionArguments.completedGoals !== undefined) {
      actionArguments.completedGoals = Array.isArray(actionArguments.completedGoals)
        ? actionArguments.completedGoals.slice(0, 24)
        : [];
    }
  } else {
    const declaration = declarationsByName.get(actionName);
    if (declaration?.parameters) {
      actionArguments = normalizeSchemaValue(
        declaration.parameters,
        actionArguments,
        actionName,
      );
    }
  }
  return {
    callId: String(functionCall.id || "").trim(),
    reflection: {
      evaluationPreviousGoal: requireShortText(
        input.evaluationPreviousGoal,
        "evaluationPreviousGoal",
      ),
      memory: optionalShortText(input.memory, "No durable facts yet."),
      nextGoal: requireShortText(input.nextGoal, "nextGoal"),
    },
    action: {
      name: actionName,
      input: actionArguments,
      kind: classifyAgentAction(actionName),
    },
  };
}
