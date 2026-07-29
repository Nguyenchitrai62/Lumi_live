import {
  BROWSER_ACTION_CLEANUP_DELAY_MS,
  DEFAULT_SHOW_ELEMENT_HIGHLIGHTS,
  FORM_INPUT_REVEAL_DURATION_MS,
  PAGE_SCROLL_DURATION_MS,
  QC_FAST_ACTION_CLEANUP_DELAY_MS,
  QC_FAST_FORM_INPUT_DURATION_MS,
  QC_FAST_PAGE_SCROLL_DURATION_MS,
} from "./ui-config.js";

export const DEFAULT_VISUAL_PREFERENCES = Object.freeze({
  executionMode: "step",
  showElementHighlights: DEFAULT_SHOW_ELEMENT_HIGHLIGHTS,
  actionCleanupDelayMs: BROWSER_ACTION_CLEANUP_DELAY_MS,
  scrollDurationMs: PAGE_SCROLL_DURATION_MS,
  typingDurationMs: FORM_INPUT_REVEAL_DURATION_MS,
});

export function normalizeVisualPreferences(value = {}) {
  const executionMode = value.executionMode === "fast_verified" ? "fast_verified" : "step";
  const fast = executionMode === "fast_verified";
  return {
    executionMode,
    showElementHighlights: typeof value.showElementHighlights === "boolean"
      ? value.showElementHighlights
      : DEFAULT_VISUAL_PREFERENCES.showElementHighlights,
    actionCleanupDelayMs: fast
      ? QC_FAST_ACTION_CLEANUP_DELAY_MS
      : DEFAULT_VISUAL_PREFERENCES.actionCleanupDelayMs,
    scrollDurationMs: fast
      ? QC_FAST_PAGE_SCROLL_DURATION_MS
      : DEFAULT_VISUAL_PREFERENCES.scrollDurationMs,
    typingDurationMs: fast
      ? QC_FAST_FORM_INPUT_DURATION_MS
      : DEFAULT_VISUAL_PREFERENCES.typingDurationMs,
  };
}
