import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VISUAL_PREFERENCES,
  normalizeVisualPreferences,
} from "../core/visual-preferences.js";

test("uses visible browser effects by default", () => {
  assert.deepEqual(normalizeVisualPreferences(), DEFAULT_VISUAL_PREFERENCES);
});

test("keeps gradual typing fixed at half a second", () => {
  assert.equal(normalizeVisualPreferences({ typingDurationMs: 1000 }).typingDurationMs, 500);
});

test("keeps animated scrolling fixed at one second", () => {
  assert.equal(normalizeVisualPreferences({ scrollDurationMs: 20 }).scrollDurationMs, 1000);
});

test("normalizes stored visual settings", () => {
  assert.deepEqual(normalizeVisualPreferences({
    showElementHighlights: true,
    scrollDurationMs: 20,
    typingDurationMs: 1000,
  }), {
    executionMode: "step",
    showElementHighlights: true,
    actionCleanupDelayMs: 420,
    scrollDurationMs: 1000,
    typingDurationMs: 500,
  });
});

test("uses bounded QC Fast visual timings only in verified execution mode", () => {
  assert.deepEqual(normalizeVisualPreferences({
    executionMode: "fast_verified",
    showElementHighlights: false,
  }), {
    executionMode: "fast_verified",
    showElementHighlights: false,
    actionCleanupDelayMs: 80,
    scrollDurationMs: 250,
    typingDurationMs: 120,
  });
});
