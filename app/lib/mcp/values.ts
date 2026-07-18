import { isObject } from "./types";

const MAX_MCP_TOOL_RESPONSE_CHARS = 24000;

export function normalizeMcpToolResult(result: unknown) {
  let normalized: unknown;
  if (!isObject(result)) normalized = { result };
  else if (Object.hasOwn(result, "structuredContent")) {
    normalized = { isError: result.isError === true, data: result.structuredContent };
  } else {
    normalized = {
      isError: result.isError === true,
      content: Array.isArray(result.content) ? result.content : result,
    };
  }

  const serialized = JSON.stringify(normalized);
  if (serialized.length <= MAX_MCP_TOOL_RESPONSE_CHARS) return normalized;
  return {
    isError: isObject(normalized) && normalized.isError === true,
    truncated: true,
    message: "The MCP result exceeded Lumi's safe Live API payload limit and was truncated.",
    content: serialized.slice(0, MAX_MCP_TOOL_RESPONSE_CHARS),
  };
}

export function formatMcpValue(value: unknown, limit = 1200) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (!text) return "No data returned.";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
