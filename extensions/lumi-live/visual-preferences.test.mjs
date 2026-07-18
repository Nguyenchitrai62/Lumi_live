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

test("normalizes stored visual settings", () => {
  assert.deepEqual(normalizeVisualPreferences({
    showElementHighlights: true,
    typingDurationMs: 1000,
  }), {
    showElementHighlights: true,
    typingDurationMs: 500,
  });
});
