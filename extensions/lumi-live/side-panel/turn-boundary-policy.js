export const STALE_TYPED_TURN_BOUNDARY_GRACE_MS = 2500;

export function shouldIgnoreStaleTypedTurnBoundary({
  typedTurnInFlight,
  responsePayloadSeen,
  hasResponsePayload,
  hasServerBoundary,
  elapsedMs,
  graceMs = STALE_TYPED_TURN_BOUNDARY_GRACE_MS,
} = {}) {
  const elapsed = Number(elapsedMs);
  return typedTurnInFlight === true
    && responsePayloadSeen !== true
    && hasResponsePayload !== true
    && hasServerBoundary === true
    && Number.isFinite(elapsed)
    && elapsed >= 0
    && elapsed <= graceMs;
}
