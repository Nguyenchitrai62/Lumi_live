import assert from "node:assert/strict";
import test from "node:test";

import {
  canSendLiveAudio,
  floatToPcm16,
  getLiveTranslationChunkStartTime,
  LIVE_TRANSLATION_JITTER_BUFFER_SECONDS,
  MAX_LIVE_AUDIO_SOCKET_BACKLOG_BYTES,
  mergeTranscriptText,
  resampleTo16k,
} from "../live/audio-utils.js";

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
  assert.equal(resampleTo16k(new Float32Array(4800), 48000).length, 1600);
  assert.equal(resampleTo16k(new Float32Array(4410), 44100).length, 1600);
});

test("clamps floating point audio when converting to PCM16", () => {
  const bytes = floatToPcm16(new Float32Array([-2, -1, 0, 1, 2]));
  const pcm = new Int16Array(bytes.buffer);
  assert.deepEqual([...pcm], [-32768, -32768, 0, 32767, 32767]);
});

test("bounds realtime socket backlog before stale audio accumulates", () => {
  assert.equal(canSendLiveAudio(0), true);
  assert.equal(canSendLiveAudio(MAX_LIVE_AUDIO_SOCKET_BACKLOG_BYTES), true);
  assert.equal(canSendLiveAudio(MAX_LIVE_AUDIO_SOCKET_BACKLOG_BYTES + 1), false);
});

test("adds a small jitter buffer only when translated playback is about to underflow", () => {
  assert.equal(LIVE_TRANSLATION_JITTER_BUFFER_SECONDS, 0.32);
  assert.ok(Math.abs(getLiveTranslationChunkStartTime(10, 10) - 10.32) < 1e-9);
  assert.ok(Math.abs(getLiveTranslationChunkStartTime(10, 10.04) - 10.32) < 1e-9);
  assert.equal(getLiveTranslationChunkStartTime(10, 10.2), 10.2);
});
