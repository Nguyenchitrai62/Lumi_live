export const DEFAULT_VISUAL_PREFERENCES = Object.freeze({
  showElementHighlights: false,
  typingDurationMs: 500,
});

export function normalizeVisualPreferences(value = {}) {
  return {
    showElementHighlights: value.showElementHighlights === true,
    typingDurationMs: DEFAULT_VISUAL_PREFERENCES.typingDurationMs,
  };
}
