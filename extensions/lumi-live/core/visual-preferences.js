import {
  DEFAULT_SHOW_ELEMENT_HIGHLIGHTS,
  FORM_INPUT_REVEAL_DURATION_MS,
  PAGE_SCROLL_DURATION_MS,
} from "./ui-config.js";

export const DEFAULT_VISUAL_PREFERENCES = Object.freeze({
  showElementHighlights: DEFAULT_SHOW_ELEMENT_HIGHLIGHTS,
  scrollDurationMs: PAGE_SCROLL_DURATION_MS,
  typingDurationMs: FORM_INPUT_REVEAL_DURATION_MS,
});

export function normalizeVisualPreferences(value = {}) {
  return {
    showElementHighlights: typeof value.showElementHighlights === "boolean"
      ? value.showElementHighlights
      : DEFAULT_VISUAL_PREFERENCES.showElementHighlights,
    scrollDurationMs: DEFAULT_VISUAL_PREFERENCES.scrollDurationMs,
    typingDurationMs: DEFAULT_VISUAL_PREFERENCES.typingDurationMs,
  };
}
