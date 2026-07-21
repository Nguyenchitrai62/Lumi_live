type FunctionCallLike = { id?: unknown; name?: unknown };
type FunctionResponseLike = { id?: unknown };

export type CancelledFunctionResponse = {
  id: string;
  name: string;
  response: { error: string };
};

function validFunctionCall(functionCall: FunctionCallLike) {
  const id = typeof functionCall?.id === "string" ? functionCall.id.trim() : "";
  const name = typeof functionCall?.name === "string" ? functionCall.name.trim() : "";
  return id && name ? { id, name } : null;
}

export function registerPendingFunctionCalls(
  functionCalls: FunctionCallLike[],
  pendingToolCallIds: Set<string>,
  pendingToolCallNames: Map<string, string>,
  cancelledToolCallIds: ReadonlySet<string> = new Set(),
) {
  const registeredCallIds: string[] = [];
  for (const functionCall of functionCalls) {
    const call = validFunctionCall(functionCall);
    if (!call || cancelledToolCallIds.has(call.id)) continue;
    pendingToolCallIds.add(call.id);
    pendingToolCallNames.set(call.id, call.name);
    registeredCallIds.push(call.id);
  }
  return registeredCallIds;
}

export function buildPendingCancellationResponses(
  pendingToolCallIds: Set<string>,
  pendingToolCallNames: Map<string, string>,
  error = "Cancelled by the user before this tool could finish.",
) {
  const functionResponses: CancelledFunctionResponse[] = [];
  for (const id of pendingToolCallIds) {
    const name = pendingToolCallNames.get(id);
    if (!name) continue;
    functionResponses.push({ id, name, response: { error } });
  }
  return functionResponses;
}

export function settlePendingFunctionCalls(
  functionResponses: FunctionResponseLike[],
  pendingToolCallIds: Set<string>,
  pendingToolCallNames: Map<string, string>,
) {
  for (const functionResponse of functionResponses) {
    const id = typeof functionResponse?.id === "string" ? functionResponse.id : "";
    if (!id) continue;
    pendingToolCallIds.delete(id);
    pendingToolCallNames.delete(id);
  }
}
