import { DEFAULT_AVATAR_MODE } from "../core/ui-config.js";

const DEFAULT_MANIFEST_PATH = "assets/avatars/pixel/avatar.json";
const EXIT_FRAME_MS = 90;
const ACTION_MINIMUM_MS = 600;
const ACTION_STATES = new Set(["ui_control", "tool_call"]);

const MOOD_LABELS = {
  idle: "Ready",
  connecting: "Joining",
  listening: "Listening",
  speaking: "Speaking",
  thinking: "Thinking",
  ui_control: "Controlling",
  tool_call: "Using tool",
  success: "Done",
  error: "Retry",
};

export function normalizeAvatarMode(value) {
  return value === "vtuber" ? "vtuber" : DEFAULT_AVATAR_MODE;
}

export function normalizePixelAvatarManifest(value) {
  const columns = Number(value?.columns);
  const rows = Number(value?.rows);
  if (!Number.isInteger(columns) || columns < 1 || columns > 16
    || !Number.isInteger(rows) || rows < 1 || rows > 16) {
    throw new Error("Lumi Pixel Companion has invalid grid dimensions.");
  }
  if (typeof value?.spritesheet !== "string" || !/^[\w.-]+\.(?:png|webp)$/i.test(value.spritesheet)) {
    throw new Error("Lumi Pixel Companion has an invalid spritesheet path.");
  }

  const animations = {};
  for (const [name, animation] of Object.entries(value?.animations || {})) {
    const row = Number(animation?.row);
    const frames = Number(animation?.frames);
    const frameDurationMs = Number(animation?.frameDurationMs);
    if (!Number.isInteger(row) || row < 0 || row >= rows
      || !Number.isInteger(frames) || frames < 1 || frames > columns
      || !Number.isFinite(frameDurationMs) || frameDurationMs < 40 || frameDurationMs > 2000) continue;
    animations[name] = { row, frames, frameDurationMs, loop: animation.loop !== false };
  }
  if (!animations.idle) throw new Error("Lumi Pixel Companion is missing its idle animation.");
  return { ...value, columns, rows, animations };
}

function preloadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Lumi Pixel Companion spritesheet could not be loaded."));
    image.src = url;
  });
}

export function createAvatarController({
  elements,
  getSessionState,
  manifestPath = DEFAULT_MANIFEST_PATH,
}) {
  let mode = "pixel";
  let modeRequestId = 0;
  let manifest = null;
  let ready = false;
  let state = "idle";
  let animationId = null;
  let stateTimeoutId = null;
  let frame = 0;
  let frameStartedAt = 0;
  let stateStartedAt = 0;
  let pendingState = null;
  let timedState = null;
  let deferredState = null;
  let deferredTimeoutId = null;

  function sessionMoodLabel() {
    const session = getSessionState();
    if (session.status === "ready") return session.isMuted ? "Muted" : "Listening";
    if (session.status === "connecting") return "Joining";
    if (session.status === "error") return "Retry";
    return "Ready";
  }

  function ambientState() {
    const session = getSessionState();
    if (session.status === "error") return "error";
    if (session.status === "connecting") return "connecting";
    if (session.status === "ready") return session.isMuted ? "idle" : "listening";
    return "idle";
  }

  async function loadPixelAvatar() {
    if (ready) return;
    const manifestUrl = chrome.runtime.getURL(manifestPath);
    const response = await fetch(manifestUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Lumi Pixel Companion metadata returned ${response.status}.`);
    }
    const nextManifest = normalizePixelAvatarManifest(await response.json());
    const spritesheetUrl = new URL(nextManifest.spritesheet, manifestUrl);
    spritesheetUrl.searchParams.set("v", String(nextManifest.version || 1));
    await preloadImage(spritesheetUrl.href);
    manifest = nextManifest;
    elements.pixelAvatarSprite.style.backgroundImage = `url("${spritesheetUrl.href}")`;
    elements.pixelAvatarSprite.style.backgroundSize =
      `${nextManifest.columns * 100}% ${nextManifest.rows * 100}%`;
    ready = true;
  }

  function stopAnimation() {
    if (animationId !== null) cancelAnimationFrame(animationId);
    clearTimeout(deferredTimeoutId);
    animationId = null;
    deferredTimeoutId = null;
    pendingState = null;
    deferredState = null;
  }

  function renderFrame(animation, nextFrame) {
    if (!manifest) return;
    const x = manifest.columns === 1 ? 0 : (nextFrame / (manifest.columns - 1)) * 100;
    const y = manifest.rows === 1 ? 0 : (animation.row / (manifest.rows - 1)) * 100;
    elements.pixelAvatarSprite.style.backgroundPosition = `${x}% ${y}%`;
  }

  function armTimedState(activeState) {
    if (!timedState || timedState.state !== activeState) return;
    clearTimeout(stateTimeoutId);
    stateTimeoutId = setTimeout(() => {
      const resumeState = timedState?.resumeState || ambientState();
      timedState = null;
      stateTimeoutId = null;
      playState(resumeState);
    }, timedState.forMs);
  }

  function clearDeferredState() {
    clearTimeout(deferredTimeoutId);
    deferredTimeoutId = null;
    deferredState = null;
  }

  function scheduleDeferredState() {
    clearTimeout(deferredTimeoutId);
    deferredTimeoutId = null;
    if (!deferredState || pendingState || !ACTION_STATES.has(state)) return;
    const waitMs = Math.max(
      0,
      ACTION_MINIMUM_MS - (performance.now() - stateStartedAt),
    );
    deferredTimeoutId = setTimeout(() => {
      const nextState = deferredState;
      deferredState = null;
      deferredTimeoutId = null;
      playState(nextState);
    }, waitMs);
  }

  function deferState(nextState) {
    deferredState = nextState;
    scheduleDeferredState();
  }

  function beginState(nextState) {
    const animation = manifest?.animations?.[nextState] || manifest?.animations?.idle;
    if (!animation) return;
    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;
    pendingState = null;
    state = nextState;
    frame = 0;
    frameStartedAt = performance.now();
    stateStartedAt = frameStartedAt;
    elements.pixelAvatar.dataset.state = nextState;
    elements.avatarMood.textContent = MOOD_LABELS[nextState] || "Ready";
    renderFrame(animation, 0);
    armTimedState(nextState);
    scheduleDeferredState();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || animation.frames === 1) return;

    const draw = (now) => {
      if (pendingState) {
        const stepCount = Math.floor(
          (now - pendingState.startedAt) / EXIT_FRAME_MS,
        );
        const steppedFrame = pendingState.fromFrame + pendingState.direction * stepCount;
        const exitFrame = pendingState.direction > 0
          ? Math.min(pendingState.targetFrame, steppedFrame)
          : Math.max(pendingState.targetFrame, steppedFrame);
        if (exitFrame !== frame) {
          frame = exitFrame;
          renderFrame(animation, exitFrame);
        }
        if (exitFrame === pendingState.targetFrame) {
          const queuedState = pendingState.state;
          beginState(queuedState);
          return;
        }
      } else {
        const rawFrame = Math.floor((now - frameStartedAt) / animation.frameDurationMs);
        const nextFrame = rawFrame % animation.frames;
        if (nextFrame !== frame) {
          frame = nextFrame;
          renderFrame(animation, nextFrame);
        }
      }
      animationId = requestAnimationFrame(draw);
    };
    animationId = requestAnimationFrame(draw);
  }

  function playState(nextState, { restart = false } = {}) {
    if (mode !== "pixel") {
      state = nextState;
      return;
    }
    const animation = manifest?.animations?.[nextState] || manifest?.animations?.idle;
    if (!animation) return;
    if (!restart && state === nextState && !pendingState) {
      clearDeferredState();
      if (animationId === null) {
        beginState(nextState);
        return;
      }
      armTimedState(nextState);
      return;
    }
    if (!restart && pendingState?.state === nextState) {
      clearDeferredState();
      return;
    }
    if (pendingState && ACTION_STATES.has(pendingState.state)) {
      deferState(nextState);
      return;
    }
    if (ACTION_STATES.has(state)
      && performance.now() - stateStartedAt < ACTION_MINIMUM_MS) {
      deferState(nextState);
      return;
    }
    const currentAnimation = manifest?.animations?.[state] || manifest?.animations?.idle;
    if (animationId === null
      || frame === 0
      || frame >= (currentAnimation?.frames || 1) - 1
      || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      beginState(nextState);
      return;
    }
    clearDeferredState();
    const lastFrame = Math.max(0, (currentAnimation?.frames || 1) - 1);
    const targetFrame = frame <= lastFrame / 2 ? 0 : lastFrame;
    pendingState = {
      state: nextState,
      fromFrame: frame,
      targetFrame,
      direction: targetFrame > frame ? 1 : -1,
      startedAt: performance.now(),
    };
  }

  function transitionState(nextState, { forMs = 0, resumeState = null, restart = false } = {}) {
    clearTimeout(stateTimeoutId);
    stateTimeoutId = null;
    timedState = forMs > 0 ? { state: nextState, forMs, resumeState } : null;
    playState(nextState, { restart });
  }

  function syncState() {
    if (mode === "pixel") transitionState(ambientState());
    else elements.avatarMood.textContent = sessionMoodLabel();
  }

  async function applyMode(requestedMode) {
    const requestId = ++modeRequestId;
    let nextMode = normalizeAvatarMode(requestedMode);
    if (nextMode === "pixel") {
      try {
        await loadPixelAvatar();
      } catch (error) {
        console.warn("Falling back to the Lumi VTuber because the Pixel Companion failed to load.", error);
        nextMode = "vtuber";
      }
    }
    if (requestId !== modeRequestId) return;

    mode = nextMode;
    const pixelEnabled = nextMode === "pixel";
    elements.modeButton.setAttribute("aria-pressed", String(pixelEnabled));
    const switchLabel = pixelEnabled
      ? "Switch to Lumi VTuber"
      : "Switch to Lumi Pixel Companion";
    elements.modeButton.setAttribute("aria-label", switchLabel);
    elements.modeButton.title = switchLabel;
    elements.vtuber.hidden = pixelEnabled;
    elements.pixelAvatar.hidden = !pixelEnabled;
    elements.pixelAvatar.setAttribute("aria-hidden", String(!pixelEnabled));
    elements.avatarCard.classList.toggle("pixel-mode", pixelEnabled);
    if (pixelEnabled) syncState();
    else {
      clearTimeout(stateTimeoutId);
      stateTimeoutId = null;
      timedState = null;
      stopAnimation();
      elements.avatarMood.textContent = sessionMoodLabel();
    }
  }

  function isStateActive(nextState) {
    return state === nextState || pendingState?.state === nextState;
  }

  function dispose() {
    clearTimeout(stateTimeoutId);
    stateTimeoutId = null;
    timedState = null;
    stopAnimation();
  }

  return Object.freeze({
    applyMode,
    dispose,
    isStateActive,
    syncState,
    transitionState,
    get mode() {
      return mode;
    },
  });
}
