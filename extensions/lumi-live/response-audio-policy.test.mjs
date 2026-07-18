import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeResponseAudioDirective,
  createTurnAudioGate,
  RESPONSE_AUDIO_DIRECTIVE_KEY,
} from "./response-audio-policy.js";

test("suppresses only the current turn and stops queued playback once", () => {
  let stopCount = 0;
  const gate = createTurnAudioGate(() => { stopCount += 1; });
  assert.equal(gate.shouldPlay(), true);
  gate.suppress();
  gate.suppress();
  assert.equal(gate.shouldPlay(), false);
  assert.equal(stopCount, 1);
  gate.reset();
  assert.equal(gate.shouldPlay(), true);
});

test("consumes the private audio directive before returning a tool result to Gemini", () => {
  const consumed = consumeResponseAudioDirective({
    success: true,
    [RESPONSE_AUDIO_DIRECTIVE_KEY]: { suppressForTurn: true },
  });
  assert.equal(consumed.suppressForTurn, true);
  assert.deepEqual(consumed.result, { success: true });
});
