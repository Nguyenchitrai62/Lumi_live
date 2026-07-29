export const MAX_BROWSER_OBSERVATION_CONTEXT_CHARS = 10000;
export const MAX_BROWSER_ACTION_CONTEXT_CHARS = 5500;
export const MAX_TOOL_ACTION_CONTEXT_CHARS = 8000;
export const MAX_DONE_CONTEXT_CHARS = 3500;

const BINARY_VALUE_PATTERN = /^(?:data:[^;,]+;base64,|[A-Za-z0-9+/]{1200,}={0,2}$)/;
const TRUNCATION_NOTICE =
  "... [bounded for active-step context; use a targeted observation if needed]";

function jsonLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function contextBudgetForKind(kind) {
  if (kind === "browser_observation") {
    return MAX_BROWSER_OBSERVATION_CONTEXT_CHARS;
  }
  if (kind === "browser_action") return MAX_BROWSER_ACTION_CONTEXT_CHARS;
  if (kind === "done") return MAX_DONE_CONTEXT_CHARS;
  return MAX_TOOL_ACTION_CONTEXT_CHARS;
}

function buildContextBudgetMetadata(
  actionName,
  originalCharacters,
  retainedCharacters,
  maxCharacters,
) {
  return {
    action: String(actionName || ""),
    originalCharacters,
    retainedCharacters,
    maxCharacters,
    truncated: true,
    policy: "latest_observation_and_task_anchor",
  };
}

function compactString(value, key, limits, state) {
  const text = String(value);
  if (BINARY_VALUE_PATTERN.test(text)) {
    state.truncated = true;
    return `[binary ${key || "value"} omitted from model context]`;
  }
  const keyLimit = key === "content"
    ? limits.contentChars
    : ["error", "message", "result", "evidence"].includes(key)
      ? limits.detailChars
      : limits.stringChars;
  if (text.length <= keyLimit) return text;
  state.truncated = true;
  return `${text.slice(0, Math.max(0, keyLimit - TRUNCATION_NOTICE.length))}${TRUNCATION_NOTICE}`;
}

function compactValue(value, limits, state, depth = 0, key = "") {
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "string") return compactString(value, key, limits, state);
  if (value === undefined) return null;
  if (depth >= limits.depth) {
    state.truncated = true;
    return "[nested context omitted]";
  }
  if (Array.isArray(value)) {
    if (value.length > limits.arrayItems) state.truncated = true;
    return value.slice(0, limits.arrayItems).map(
      (item) => compactValue(item, limits, state, depth + 1, key),
    );
  }
  if (!value || typeof value !== "object") return String(value);
  const entries = Object.entries(value);
  if (entries.length > limits.objectKeys) state.truncated = true;
  return Object.fromEntries(
    entries.slice(0, limits.objectKeys).map(([field, fieldValue]) => [
      field,
      compactValue(fieldValue, limits, state, depth + 1, field),
    ]),
  );
}

export function boundAgentObservationForModel(
  value,
  {
    actionKind = "tool_action",
    actionName = "",
  } = {},
) {
  const maxCharacters = contextBudgetForKind(actionKind);
  const originalCharacters = jsonLength(value);
  if (originalCharacters <= maxCharacters) return value;

  let limits = {
    contentChars: Math.min(8000, Math.floor(maxCharacters * 0.7)),
    detailChars: Math.min(2400, Math.floor(maxCharacters * 0.3)),
    stringChars: Math.min(1600, Math.floor(maxCharacters * 0.22)),
    arrayItems: 28,
    objectKeys: 64,
    depth: 8,
  };
  let candidate = value;
  let state = { truncated: false };
  const payloadBudget = Math.max(1000, maxCharacters - 320);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    state = { truncated: false };
    candidate = compactValue(value, limits, state);
    if (jsonLength(candidate) <= payloadBudget) break;
    limits = {
      ...limits,
      contentChars: Math.max(900, Math.floor(limits.contentChars * 0.68)),
      detailChars: Math.max(600, Math.floor(limits.detailChars * 0.72)),
      stringChars: Math.max(400, Math.floor(limits.stringChars * 0.72)),
      arrayItems: Math.max(4, Math.floor(limits.arrayItems * 0.68)),
      objectKeys: Math.max(16, Math.floor(limits.objectKeys * 0.78)),
    };
  }

  const bounded = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate
    : { value: candidate };
  const output = {
    ...bounded,
    contextBudget: buildContextBudgetMetadata(
      actionName,
      originalCharacters,
      jsonLength(bounded),
      maxCharacters,
    ),
  };
  if (jsonLength(output) <= maxCharacters) return output;

  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const fallbackText = [
    source.error,
    source.message,
    source.content,
    source.result,
    source.evidence,
    source.status,
    source.title,
    source.url,
  ].find((item) => typeof item === "string" && item.trim())
    || `Oversized ${actionKind} result. Available keys: ${Object.keys(source)
      .slice(0, 20)
      .join(", ")}`;
  const strictPayload = {
    ...(typeof source.success === "boolean" ? { success: source.success } : {}),
    content: String(fallbackText).slice(0, Math.max(200, maxCharacters - 700)),
  };
  let strictOutput = {
    ...strictPayload,
    contextBudget: buildContextBudgetMetadata(
      actionName,
      originalCharacters,
      jsonLength(strictPayload),
      maxCharacters,
    ),
  };
  const overflow = jsonLength(strictOutput) - maxCharacters;
  if (overflow > 0) {
    strictPayload.content = strictPayload.content.slice(
      0,
      Math.max(80, strictPayload.content.length - overflow - 16),
    );
    strictOutput = {
      ...strictPayload,
      contextBudget: buildContextBudgetMetadata(
        actionName,
        originalCharacters,
        jsonLength(strictPayload),
        maxCharacters,
      ),
    };
  }
  return strictOutput;
}
