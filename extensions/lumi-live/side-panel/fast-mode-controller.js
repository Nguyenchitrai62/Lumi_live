const ENGAGE_ANIMATION_MS = 520;

export function createFastModeController({
  button,
  documentElement,
  body,
  vtuberCard,
  vtuberToggle,
  transcript,
  panelAudio,
  avatarController,
  petalEmitter,
  getPetalsEnabled,
  flushTranscriptReveals,
  getSessionOptions,
  setSessionOptions,
  sendRuntime,
  setStatus,
}) {
  const label = button.querySelector(".fast-mode-label");
  let enabled = false;
  let engageTimerId = null;

  function animateEngagement() {
    clearTimeout(engageTimerId);
    button.classList.remove("is-engaging");
    void button.offsetWidth;
    button.classList.add("is-engaging");
    engageTimerId = setTimeout(() => {
      button.classList.remove("is-engaging");
      engageTimerId = null;
    }, ENGAGE_ANIMATION_MS);
  }

  function apply(nextEnabled, { animate = false } = {}) {
    enabled = nextEnabled === true;
    documentElement.dataset.fastMode = enabled ? "true" : "false";
    body.classList.toggle("fast-mode", enabled);
    body.classList.toggle("petals-off", !getPetalsEnabled() || enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", enabled ? "Disable Fast mode" : "Enable Fast mode");
    button.title = enabled ? "Fast execution active — click to return to Normal execution" : "Enable Fast execution";
    if (label) label.textContent = enabled ? "Fast on" : "Fast";
    panelAudio.setVisualAnimationsEnabled(!enabled);
    void avatarController.setEnabled(!enabled);

    if (enabled) {
      petalEmitter.stop();
      vtuberCard.classList.remove("expanded");
      body.classList.remove("vtuber-expanded");
      transcript.setAttribute("aria-hidden", "false");
      vtuberToggle.setAttribute("aria-expanded", "false");
      flushTranscriptReveals();
      if (animate) animateEngagement();
    } else if (getPetalsEnabled()) {
      petalEmitter.start();
    }

    const sessionOptions = getSessionOptions();
    if (sessionOptions) setSessionOptions({ ...sessionOptions, fastMode: enabled });
    return enabled;
  }

  async function toggle() {
    try {
      const preferences = await sendRuntime("set_visual_preferences", {
        fastMode: !enabled,
      });
      apply(preferences.fastMode === true, { animate: preferences.fastMode === true });
      setStatus(enabled
        ? `Fast execution active · ${preferences.workspace?.title || "strict workspace"} · shared context · visual delays removed.`
        : "Normal execution active · active-tab target · shared context · verified stages with visual progress.");
      return preferences;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error || "Chrome rejected the workspace change.");
      setStatus(`Fast mode unavailable: ${detail}`);
      return { fastMode: enabled, error: detail };
    }
  }

  function dispose() {
    clearTimeout(engageTimerId);
    button.classList.remove("is-engaging");
  }

  return Object.freeze({
    apply,
    dispose,
    toggle,
    get enabled() {
      return enabled;
    },
  });
}
