import {
  DEFAULT_FAST_MODE_ENABLED,
  DEFAULT_SHOW_ELEMENT_HIGHLIGHTS,
  FORM_INPUT_REVEAL_DURATION_MS,
  PAGE_SCROLL_DURATION_MS,
} from "./ui-config.js";

export const DEFAULT_VISUAL_PREFERENCES = Object.freeze({
  fastMode: DEFAULT_FAST_MODE_ENABLED,
  showElementHighlights: DEFAULT_FAST_MODE_ENABLED ? false : DEFAULT_SHOW_ELEMENT_HIGHLIGHTS,
  scrollDurationMs: DEFAULT_FAST_MODE_ENABLED ? 0 : PAGE_SCROLL_DURATION_MS,
  typingDurationMs: DEFAULT_FAST_MODE_ENABLED ? 0 : FORM_INPUT_REVEAL_DURATION_MS,
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
      : DEFAULT_SHOW_ELEMENT_HIGHLIGHTS,
    scrollDurationMs: fastMode ? 0 : PAGE_SCROLL_DURATION_MS,
    typingDurationMs: fastMode ? 0 : FORM_INPUT_REVEAL_DURATION_MS,
  };
}
