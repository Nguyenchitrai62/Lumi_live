import assert from "node:assert/strict";
import test from "node:test";

import {
  floatToPcm16,
  mergeTranscriptText,
  resampleTo16k,
} from "./live-audio-utils.js";

test("merges cumulative and overlapping transcript chunks", () => {
  assert.equal(mergeTranscriptText("Hello", "Hello there"), "Hello there");
  assert.equal(mergeTranscriptText("Open the set", "settings page"), "Open the settings page");
  assert.equal(mergeTranscriptText("Ready", "."), "Ready.");
});

test("resamples microphone input to 16 kHz without changing 16 kHz buffers", () => {
  const source = new Float32Array([0, 0.25, 0.5, 0.75]);
  assert.equal(resampleTo16k(source, 16000), source);
  assert.deepEqual(
    [...resampleTo16k(source, 32000)],
    [0.125, 0.625],
  );
});

test("clamps floating point audio when converting to PCM16", () => {
  const bytes = floatToPcm16(new Float32Array([-2, -1, 0, 1, 2]));
  const pcm = new Int16Array(bytes.buffer);
  assert.deepEqual([...pcm], [-32768, -32768, 0, 32767, 32767]);
});
