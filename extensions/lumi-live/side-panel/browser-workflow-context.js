export const MAX_WORKFLOW_REQUEST_CHARS = 1200;

function normalizeToolResult(result) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result };
  }
  return { toolResult: result ?? null };
}

export function addBrowserWorkflowContext(
  result,
  {
    toolName = "",
    userRequest = "",
  } = {},
) {
  const request = String(userRequest || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WORKFLOW_REQUEST_CHARS);
  return {
    ...normalizeToolResult(result),
    workflowContinuation: {
      completedTool: String(toolName || "").trim(),
      originalUserRequest: request,
      resultScope: "This tool result is one intermediate observation or action, not proof that the whole request is complete.",
      continuationRule: "Compare the original user request with observed results, then immediately continue every explicitly requested unfinished action. Do not stop, summarize, or ask for confirmation merely because one intermediate step succeeded.",
      authorizationRule: "The original request continues to authorize the exact actions, targets, and scope it explicitly named, including later steps and matching website confirmation dialogs. Ask only for a new, ambiguous, materially expanded, or newly sensitive consequence.",
    },
  };
}
