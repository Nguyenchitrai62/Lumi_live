import {
  DEFAULT_FAST_MODE_ENABLED,
  DEFAULT_SHOW_ELEMENT_HIGHLIGHTS,
  FORM_INPUT_REVEAL_DURATION_MS,
  PAGE_SCROLL_DURATION_MS,
} from "./ui-config.js";

export const DEFAULT_VISUAL_PREFERENCES = Object.freeze({
  fastMode: DEFAULT_FAST_MODE_ENABLED,
  showElementHighlights: DEFAULT_SHOW_ELEMENT_HIGHLIGHTS,
  scrollDurationMs: PAGE_SCROLL_DURATION_MS,
  typingDurationMs: FORM_INPUT_REVEAL_DURATION_MS,
});

export function normalizeVisualPreferences(value = {}) {
  const fastMode = typeof value.fastMode === "boolean"
    ? value.fastMode
    : DEFAULT_VISUAL_PREFERENCES.fastMode;
  return {
    fastMode,
    showElementHighlights: fastMode
      ? false
      : typeof value.showElementHighlights === "boolean"
      ? value.showElementHighlights
      : DEFAULT_VISUAL_PREFERENCES.showElementHighlights,
    scrollDurationMs: fastMode ? 0 : DEFAULT_VISUAL_PREFERENCES.scrollDurationMs,
    typingDurationMs: fastMode ? 0 : DEFAULT_VISUAL_PREFERENCES.typingDurationMs,
  };
}
