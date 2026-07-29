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
  } = {},
) {
  return {
    ...normalizeToolResult(result),
    workflowContinuation: {
      completedTool: String(toolName || "").trim(),
      resultScope: "intermediate",
      continuationRule:
        "Use task.requestAnchor plus the current remainingGoals. Continue unfinished authorized outcomes; ask only for a new, ambiguous, expanded, or sensitive consequence.",
    },
  };
}
