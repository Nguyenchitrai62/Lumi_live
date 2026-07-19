import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VISUAL_PREFERENCES,
  normalizeVisualPreferences,
} from "./visual-preferences.js";

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
    showElementHighlights: true,
    scrollDurationMs: 1000,
    typingDurationMs: 500,
  });
});
