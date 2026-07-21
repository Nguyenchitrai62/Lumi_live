import { DISCLOSURE_ANIMATION_DURATION_MS } from "../core/ui-config.js";

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function attachAnimatedDisclosure({
  root,
  summary,
  body,
  initiallyExpanded = false,
}) {
  let expanded = Boolean(initiallyExpanded);
  let rootAnimation = null;
  let bodyAnimation = null;

  root.open = expanded;
  root.dataset.expanded = String(expanded);
  summary.setAttribute("aria-expanded", String(expanded));

  function finish(nextExpanded) {
    if (!nextExpanded) root.open = false;
    root.style.removeProperty("height");
    root.style.removeProperty("overflow");
    rootAnimation = null;
    bodyAnimation = null;
  }

  function setExpanded(nextValue, { animate = true } = {}) {
    const nextExpanded = Boolean(nextValue);
    if (nextExpanded === expanded) return;

    const startHeight = root.getBoundingClientRect().height;
    rootAnimation?.cancel();
    bodyAnimation?.cancel();
    if (nextExpanded) root.open = true;
    expanded = nextExpanded;
    root.dataset.expanded = String(nextExpanded);
    summary.setAttribute("aria-expanded", String(nextExpanded));

    if (!animate || prefersReducedMotion() || typeof root.animate !== "function") {
      root.open = nextExpanded;
      finish(nextExpanded);
      return;
    }

    const borderHeight = root.offsetHeight - root.clientHeight;
    const endHeight = nextExpanded
      ? root.scrollHeight + borderHeight
      : summary.offsetHeight + borderHeight;
    root.style.height = `${startHeight}px`;
    root.style.overflow = "hidden";
    rootAnimation = root.animate(
      [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
      {
        duration: DISCLOSURE_ANIMATION_DURATION_MS,
        easing: "cubic-bezier(.2,.8,.2,1)",
      },
    );
    bodyAnimation = body.animate(
      [{ opacity: nextExpanded ? 0 : 1 }, { opacity: nextExpanded ? 1 : 0 }],
      { duration: DISCLOSURE_ANIMATION_DURATION_MS, easing: "ease" },
    );
    rootAnimation.onfinish = () => finish(nextExpanded);
  }

  function handleSummaryClick(event) {
    event.preventDefault();
    setExpanded(!expanded);
  }

  summary.addEventListener("click", handleSummaryClick);

  return Object.freeze({
    dispose() {
      rootAnimation?.cancel();
      bodyAnimation?.cancel();
      summary.removeEventListener("click", handleSummaryClick);
    },
    setExpanded,
    get expanded() {
      return expanded;
    },
  });
}
