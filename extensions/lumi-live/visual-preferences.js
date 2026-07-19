export const DEFAULT_VISUAL_PREFERENCES = Object.freeze({
  showElementHighlights: false,
  scrollDurationMs: 1000,
  typingDurationMs: 500,
});

export function normalizeVisualPreferences(value = {}) {
  return {
    showElementHighlights: value.showElementHighlights === true,
    scrollDurationMs: DEFAULT_VISUAL_PREFERENCES.scrollDurationMs,
    typingDurationMs: DEFAULT_VISUAL_PREFERENCES.typingDurationMs,
  };
}
