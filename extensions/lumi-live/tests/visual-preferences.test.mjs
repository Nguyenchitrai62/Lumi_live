import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VISUAL_PREFERENCES,
  normalizeVisualPreferences,
} from "../core/visual-preferences.js";
import { DEFAULT_FAST_MODE_ENABLED } from "../core/ui-config.js";

test("uses the central Fast mode default when no preference is stored", () => {
  assert.deepEqual(normalizeVisualPreferences(), DEFAULT_VISUAL_PREFERENCES);
  assert.equal(
    DEFAULT_VISUAL_PREFERENCES.fastMode,
    DEFAULT_FAST_MODE_ENABLED,
  );
});

test("keeps gradual typing fixed at half a second", () => {
  assert.equal(normalizeVisualPreferences({
    fastMode: false,
    typingDurationMs: 1000,
  }).typingDurationMs, 500);
});

test("keeps animated scrolling fixed at one second", () => {
  assert.equal(normalizeVisualPreferences({
    fastMode: false,
    scrollDurationMs: 20,
  }).scrollDurationMs, 1000);
});

test("normalizes stored visual settings", () => {
  assert.deepEqual(normalizeVisualPreferences({
    fastMode: false,
    showElementHighlights: true,
    scrollDurationMs: 20,
    typingDurationMs: 1000,
  }), {
    fastMode: false,
    showElementHighlights: true,
    scrollDurationMs: 1000,
    typingDurationMs: 500,
  });
});

test("fast mode disables browser visuals and action delays", () => {
  assert.deepEqual(normalizeVisualPreferences({
    fastMode: true,
    showElementHighlights: true,
  }), {
    fastMode: true,
    showElementHighlights: false,
    scrollDurationMs: 0,
    typingDurationMs: 0,
  });
});
