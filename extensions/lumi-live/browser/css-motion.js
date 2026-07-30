const LIGHT_BORDER = "rgba(111, 91, 196, 0.82)";
const LIGHT_GLOW = "rgba(129, 180, 255, 0.2)";
const DARK_BORDER = "rgba(174, 150, 255, 0.9)";
const DARK_GLOW = "rgba(108, 189, 255, 0.24)";

function finishedAnimation(animation) {
  return animation.finished.catch(() => undefined);
}

/**
 * CSS-only replacement for ai-motion's decorative WebGL border.
 *
 * PageAgent creates a mask for every controlled document. Using a WebGL
 * context for that decoration consumes the host page's limited context quota
 * and can evict chart renderers on graphics-heavy pages. This class preserves
 * the Motion API used by PageAgent without allocating a graphics context.
 */
export class Motion {
  constructor(options = {}) {
    this.disposed = false;
    this.running = false;
    this.animation = null;
    this.element = document.createElement("div");
    this.element.setAttribute("aria-hidden", "true");
    this.element.setAttribute("data-lumi-css-motion", "");

    const dark = options.mode === "dark";
    Object.assign(this.element.style, {
      boxSizing: "border-box",
      display: "block",
      pointerEvents: "none",
      border: `2px solid ${dark ? DARK_BORDER : LIGHT_BORDER}`,
      boxShadow: `inset 0 0 72px 18px ${dark ? DARK_GLOW : LIGHT_GLOW}`,
      opacity: "0",
      transformOrigin: "center",
      ...options.styles,
    });
  }

  start() {
    if (this.disposed) throw new Error("Motion instance has been disposed.");
    this.running = true;
  }

  pause() {
    if (this.disposed) throw new Error("Motion instance has been disposed.");
    this.running = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.animation?.cancel();
    this.animation = null;
    this.element.remove();
  }

  resize() {
    if (this.disposed) throw new Error("Motion instance has been disposed.");
  }

  autoResize() {
    if (this.disposed) throw new Error("Motion instance has been disposed.");
  }

  fadeIn() {
    if (this.disposed) throw new Error("Motion instance has been disposed.");
    this.animation?.cancel();
    this.animation = this.element.animate(
      [
        { opacity: 0, transform: "scale(1.01)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 180, easing: "ease-out", fill: "forwards" },
    );
    return finishedAnimation(this.animation);
  }

  fadeOut() {
    if (this.disposed) throw new Error("Motion instance has been disposed.");
    this.animation?.cancel();
    this.animation = this.element.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(1.01)" },
      ],
      { duration: 180, easing: "ease-in", fill: "forwards" },
    );
    return finishedAnimation(this.animation);
  }
}
