import test from "node:test";
import assert from "node:assert/strict";

import {
  STALE_TYPED_TURN_BOUNDARY_GRACE_MS,
  shouldIgnoreStaleTypedTurnBoundary,
} from "../side-panel/turn-boundary-policy.js";

test("ignores a payload-free stale server boundary immediately after a typed turn starts", () => {
  assert.equal(shouldIgnoreStaleTypedTurnBoundary({
    typedTurnInFlight: true,
    responsePayloadSeen: false,
    hasResponsePayload: false,
    hasServerBoundary: true,
    elapsedMs: 15,
  }), true);
});

test("does not hide a boundary that belongs to the current response", () => {
  assert.equal(shouldIgnoreStaleTypedTurnBoundary({
    typedTurnInFlight: true,
    responsePayloadSeen: true,
    hasResponsePayload: false,
    hasServerBoundary: true,
    elapsedMs: 15,
  }), false);
  assert.equal(shouldIgnoreStaleTypedTurnBoundary({
    typedTurnInFlight: true,
    responsePayloadSeen: false,
    hasResponsePayload: true,
    hasServerBoundary: true,
    elapsedMs: 15,
  }), false);
});

test("does not suppress a boundary outside the short typed-turn race window", () => {
  assert.equal(shouldIgnoreStaleTypedTurnBoundary({
    typedTurnInFlight: true,
    responsePayloadSeen: false,
    hasResponsePayload: false,
    hasServerBoundary: true,
    elapsedMs: STALE_TYPED_TURN_BOUNDARY_GRACE_MS + 1,
  }), false);
});
