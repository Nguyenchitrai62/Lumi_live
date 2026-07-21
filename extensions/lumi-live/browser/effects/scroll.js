import { wait } from "./timing.js";
import {
  PAGE_SCROLL_ARROW_PULSE_DURATION_MS,
  PAGE_SCROLL_CLEANUP_DELAY_MS,
  PAGE_SCROLL_DURATION_MS,
  PAGE_SCROLL_EXIT_DURATION_MS,
  PAGE_SCROLL_FRAME_ENTRANCE_DURATION_MS,
  PAGE_SCROLL_HUD_ENTRANCE_DURATION_MS,
} from "../../core/ui-config.js";

const SCROLL_EFFECT_HOST_ID = "lumi-page-agent-scroll-effect";

function createScrollEffect(direction) {
  document.getElementById(SCROLL_EFFECT_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = SCROLL_EFFECT_HOST_ID;
  host.dataset.direction = direction;
  host.style.cssText = "all:initial;position:fixed;z-index:2147483646;inset:0;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { --progress:0; color-scheme:light dark; }
      .frame { position:absolute; inset:10px; border:1px solid rgba(122,207,255,.34); border-radius:18px; box-shadow:inset 0 0 38px rgba(45,155,218,.11); opacity:0; animation:lumi-scroll-frame-in ${PAGE_SCROLL_FRAME_ENTRANCE_DURATION_MS}ms ease-out forwards; }
      .hud { position:absolute; right:max(20px,3vw); top:50%; display:grid; grid-template-columns:30px auto; align-items:center; gap:10px; min-width:142px; padding:10px 13px 10px 10px; border:1px solid rgba(194,231,255,.45); border-radius:999px; color:#fff; background:linear-gradient(135deg,rgba(12,49,76,.9),rgba(22,91,129,.84)); box-shadow:0 14px 36px rgba(4,30,49,.3),inset 0 1px rgba(255,255,255,.16); backdrop-filter:blur(12px); transform:translate(14px,-50%); opacity:0; animation:lumi-scroll-hud-in ${PAGE_SCROLL_HUD_ENTRANCE_DURATION_MS}ms cubic-bezier(.2,.8,.2,1) forwards; }
      .motion { position:relative; width:30px; height:30px; display:grid; place-items:center; overflow:hidden; border-radius:50%; color:#d7f4ff; background:rgba(255,255,255,.13); }
      .arrow { width:8px; height:8px; border-right:2px solid currentColor; border-bottom:2px solid currentColor; transform:rotate(45deg) translate(-1px,-1px); animation:lumi-scroll-arrow ${PAGE_SCROLL_ARROW_PULSE_DURATION_MS}ms ease-in-out infinite; }
      :host([data-direction="up"]) .arrow { transform:rotate(225deg) translate(-1px,-1px); animation-name:lumi-scroll-arrow-up; }
      .copy { display:grid; gap:3px; min-width:76px; font:700 10px/1.1 "Segoe UI",sans-serif; letter-spacing:.02em; }
      .copy small { color:rgba(225,245,255,.72); font:800 7px/1 "Segoe UI",sans-serif; letter-spacing:.14em; text-transform:uppercase; }
      .track { grid-column:1/-1; height:2px; overflow:hidden; border-radius:2px; background:rgba(255,255,255,.17); }
      .track::after { content:""; display:block; width:100%; height:100%; border-radius:inherit; background:linear-gradient(90deg,#7bdcff,#d8f7ff); transform-origin:left; transform:scaleX(var(--progress)); }
      :host([data-state="done"]) .hud,:host([data-state="done"]) .frame { opacity:0; transition:opacity ${PAGE_SCROLL_EXIT_DURATION_MS}ms ease; }
      @keyframes lumi-scroll-frame-in { to { opacity:1; } }
      @keyframes lumi-scroll-hud-in { to { transform:translate(0,-50%); opacity:1; } }
      @keyframes lumi-scroll-arrow { 0% { opacity:0; translate:0 -6px; } 35% { opacity:1; } 100% { opacity:0; translate:0 7px; } }
      @keyframes lumi-scroll-arrow-up { 0% { opacity:0; translate:0 6px; } 35% { opacity:1; } 100% { opacity:0; translate:0 -7px; } }
      @media (prefers-reduced-motion:reduce) { .frame,.hud,.arrow { animation:none; opacity:1; } .hud { transform:translate(0,-50%); } }
    </style>
    <div class="frame"></div>
    <div class="hud">
      <span class="motion" aria-hidden="true"><span class="arrow"></span></span>
      <span class="copy"><small>PAGE MOTION</small><span>${direction === "up" ? "Scrolling up" : "Scrolling down"}</span></span>
      <span class="track"></span>
    </div>`;
  (document.documentElement || document.body).append(host);
  return {
    update(progress) {
      host.style.setProperty("--progress", String(Math.max(0, Math.min(1, progress))));
    },
    async finish() {
      host.dataset.state = "done";
      await wait(PAGE_SCROLL_CLEANUP_DELAY_MS);
      host.remove();
    },
    remove() {
      host.remove();
    },
  };
}

function isScrollableElement(element, requireLargeViewport = false) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
  const style = getComputedStyle(element);
  const allowsScroll = /(auto|scroll|overlay)/.test(style.overflowY);
  const isLargeEnough = !requireLargeViewport || element.clientHeight >= window.innerHeight * 0.5;
  return allowsScroll && isLargeEnough && element.scrollHeight > element.clientHeight;
}

function findVerticalScroller(indexedElement) {
  if (indexedElement) {
    let current = indexedElement;
    for (let attempt = 0; current && attempt < 10; attempt += 1) {
      if (isScrollableElement(current)) return { element: current, targeted: true };
      if (current === document.body || current === document.documentElement) break;
      current = current.parentElement;
    }
    return null;
  }

  let current = document.activeElement;
  while (current && current !== document.body && !isScrollableElement(current, true)) {
    current = current.parentElement;
  }
  const element = isScrollableElement(current, true)
    ? current
    : Array.from(document.querySelectorAll("*")).find((candidate) => isScrollableElement(candidate, true))
      || document.scrollingElement
      || document.documentElement;
  return { element, targeted: false };
}

function abortError() {
  const error = new Error("The animated page action was cancelled.");
  error.name = "AbortError";
  return error;
}

function easeInOutCubic(progress) {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - ((-2 * progress + 2) ** 3) / 2;
}

async function animateScrollTop(element, targetTop, durationMs, effect, signal) {
  const startedAt = performance.now();
  const startTop = element.scrollTop;
  const distance = targetTop - startTop;
  await new Promise((resolve, reject) => {
    let frameId = null;
    const abort = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      reject(abortError());
    };
    const frame = (now) => {
      if (signal?.aborted) {
        abort();
        return;
      }
      const progress = Math.min(1, (now - startedAt) / durationMs);
      element.scrollTop = startTop + distance * easeInOutCubic(progress);
      effect.update(progress);
      if (progress >= 1) {
        signal?.removeEventListener("abort", abort);
        resolve();
        return;
      }
      frameId = requestAnimationFrame(frame);
    };
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    frameId = requestAnimationFrame(frame);
  });
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function isRenderedTextCandidate(element) {
  if (!element || element.matches("script,style,noscript,template,head,meta,link")) return false;
  const style = (element.ownerDocument.defaultView || window).getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

function textMatchRank(value, query) {
  if (value === query) return 0;
  if (value.startsWith(query) || value.endsWith(query)) return 1;
  return value.includes(query) ? 2 : -1;
}

function semanticTextRank(element) {
  if (/^H[1-6]$/.test(element.tagName) || element.getAttribute("role") === "heading") return 0;
  if (["SECTION", "ARTICLE", "MAIN"].includes(element.tagName)) return 1;
  if (["P", "LI", "DT", "DD", "LABEL", "LEGEND", "FIGCAPTION"].includes(element.tagName)) return 2;
  return 3;
}

function elementDepth(element) {
  let depth = 0;
  for (let current = element; current?.parentElement; current = current.parentElement) depth += 1;
  return depth;
}

function findTextElement(text, root, occurrence = 1) {
  const query = normalizeSearchText(text);
  if (!query) return null;
  const searchRoot = root?.isConnected ? root : document.body || document.documentElement;
  if (!searchRoot) return null;
  const ownerDocument = searchRoot.ownerDocument || document;
  const showElement = ownerDocument.defaultView?.NodeFilter?.SHOW_ELEMENT ?? 1;
  const walker = ownerDocument.createTreeWalker(searchRoot, showElement);
  const matches = [];
  let element = searchRoot;
  let scanned = 0;
  while (element && scanned < 20000 && matches.length < 300) {
    scanned += 1;
    const attributeText = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ].filter(Boolean).join(" ");
    const preliminaryText = normalizeSearchText(`${attributeText} ${element.textContent || ""}`);
    if (preliminaryText.includes(query) && isRenderedTextCandidate(element)) {
      const visibleText = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      const values = [attributeText, visibleText]
        .map((value) => ({ raw: value, normalized: normalizeSearchText(value) }))
        .filter(({ normalized }) => normalized);
      const rankedValues = values
        .map((value) => ({ ...value, rank: textMatchRank(value.normalized, query) }))
        .filter(({ rank }) => rank >= 0)
        .sort((a, b) => a.rank - b.rank || a.normalized.length - b.normalized.length);
      if (rankedValues.length) {
        const best = rankedValues[0];
        matches.push({
          element,
          matchRank: best.rank,
          semanticRank: semanticTextRank(element),
          textLength: best.normalized.length,
          depth: elementDepth(element),
          matchedText: best.raw.slice(0, 500),
        });
      }
    }
    element = walker.nextNode();
  }
  if (!matches.length) return null;

  const bestMatchRank = Math.min(...matches.map((match) => match.matchRank));
  const rankedMatches = matches.filter((match) => match.matchRank === bestMatchRank);
  const bestSemanticRank = Math.min(...rankedMatches.map((match) => match.semanticRank));
  const preferredMatches = rankedMatches
    .filter((match) => match.semanticRank === bestSemanticRank)
    .sort((a, b) => a.textLength - b.textLength || b.depth - a.depth);
  const specificMatches = [];
  for (const candidate of preferredMatches) {
    if (specificMatches.some((match) => candidate.element.contains(match.element))) continue;
    specificMatches.push(candidate);
  }
  specificMatches.sort((a, b) => {
    if (a.element === b.element) return 0;
    return a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1;
  });
  const selected = specificMatches[occurrence - 1];
  return selected ? { ...selected, matchCount: specificMatches.length } : {
    missingOccurrence: true,
    matchCount: specificMatches.length,
  };
}

function collectScrollEntries(element, alignment) {
  const ownerDocument = element.ownerDocument || document;
  const scrollers = [];
  for (let current = element.parentElement; current; current = current.parentElement) {
    if (isScrollableElement(current)) scrollers.push(current);
  }
  const documentScroller = ownerDocument.scrollingElement || ownerDocument.documentElement;
  if (documentScroller && !scrollers.includes(documentScroller)) scrollers.push(documentScroller);
  const entries = scrollers.map((scroller) => ({
    element: scroller,
    startTop: scroller.scrollTop,
    startLeft: scroller.scrollLeft,
    targetTop: scroller.scrollTop,
    previousScrollBehavior: scroller.style.scrollBehavior,
  }));
  try {
    for (const entry of entries) entry.element.style.scrollBehavior = "auto";
    element.scrollIntoView({ behavior: "auto", block: alignment, inline: "nearest" });
    for (const entry of entries) entry.targetTop = entry.element.scrollTop;
  } finally {
    for (const entry of entries) {
      entry.element.scrollTop = entry.startTop;
      entry.element.scrollLeft = entry.startLeft;
      entry.element.style.scrollBehavior = entry.previousScrollBehavior;
    }
  }
  return entries;
}

async function animateScrollEntries(entries, durationMs, effect, signal) {
  const elementWindow = entries[0]?.element.ownerDocument.defaultView || window;
  const startedAt = elementWindow.performance.now();
  const duration = Math.max(1, durationMs);
  await new Promise((resolve, reject) => {
    let frameId = null;
    const abort = () => {
      if (frameId !== null) elementWindow.cancelAnimationFrame(frameId);
      reject(abortError());
    };
    const frame = (now) => {
      if (signal?.aborted) {
        abort();
        return;
      }
      const progress = Math.min(1, (now - startedAt) / duration);
      const easedProgress = easeInOutCubic(progress);
      for (const entry of entries) {
        entry.element.scrollTop = entry.startTop
          + (entry.targetTop - entry.startTop) * easedProgress;
      }
      effect.update(progress);
      if (progress >= 1) {
        signal?.removeEventListener("abort", abort);
        resolve();
        return;
      }
      frameId = elementWindow.requestAnimationFrame(frame);
    };
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    frameId = elementWindow.requestAnimationFrame(frame);
  });
}

/**
 * @param {{
 *   text: string,
 *   occurrence?: number,
 *   alignment?: "start" | "center" | "end",
 *   root?: HTMLElement,
 *   durationMs?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export async function scrollToTextGradually({
  text,
  occurrence = 1,
  alignment = "center",
  root,
  durationMs = PAGE_SCROLL_DURATION_MS,
  signal,
}) {
  const match = findTextElement(text, root, occurrence);
  if (!match) {
    return {
      success: false,
      message: `No rendered page content matched "${String(text).slice(0, 200)}". The content may not be loaded in the DOM yet.`,
    };
  }
  if (match.missingOccurrence) {
    return {
      success: false,
      message: `Found ${match.matchCount} matching content item(s), but occurrence ${occurrence} was requested.`,
      matchCount: match.matchCount,
    };
  }
  const entries = collectScrollEntries(match.element, alignment);
  const motionEntry = entries.reduce((largest, entry) => (
    Math.abs(entry.targetTop - entry.startTop) > Math.abs(largest.targetTop - largest.startTop)
      ? entry
      : largest
  ), entries[0]);
  const direction = motionEntry && motionEntry.targetTop < motionEntry.startTop ? "up" : "down";
  const effect = createScrollEffect(direction);
  try {
    await animateScrollEntries(entries, Math.max(1, durationMs), effect, signal);
    await effect.finish();
  } catch (error) {
    effect.remove();
    throw error;
  }
  return {
    success: true,
    message: `Scrolled to matching content "${match.matchedText.slice(0, 200)}" with ${alignment} alignment over ${durationMs} ms.`,
    matchedText: match.matchedText,
    occurrence,
    matchCount: match.matchCount,
    alignment,
  };
}

/**
 * @param {{
 *   direction?: "up" | "down",
 *   pages?: number,
 *   position?: number,
 *   indexedElement?: HTMLElement,
 *   durationMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 */
export async function scrollPageGradually({
  direction = "down",
  pages = 0.8,
  position,
  indexedElement,
  durationMs = PAGE_SCROLL_DURATION_MS,
  signal,
} = {}) {
  const scrollTarget = findVerticalScroller(indexedElement);
  if (!scrollTarget) {
    const effect = createScrollEffect(direction);
    effect.update(1);
    await effect.finish();
    return { success: true, message: "No scrollable container was found for that element." };
  }

  const { element, targeted } = scrollTarget;
  const startTop = element.scrollTop;
  const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
  const viewportDistance = targeted ? window.innerHeight / 3 : window.innerHeight;
  const signedDistance = viewportDistance * pages * (direction === "up" ? -1 : 1);
  const targetTop = Number.isFinite(position)
    ? maxTop * position
    : Math.max(0, Math.min(maxTop, startTop + signedDistance));
  const effect = createScrollEffect(targetTop < startTop ? "up" : "down");
  try {
    await animateScrollTop(element, targetTop, Math.max(1, durationMs), effect, signal);
    await effect.finish();
  } catch (error) {
    effect.remove();
    throw error;
  }

  const scrolled = Math.round(element.scrollTop - startTop);
  if (Math.abs(scrolled) < 1) {
    return {
      success: true,
      message: direction === "down"
        ? "Already at the bottom; the page cannot scroll down further."
        : "Already at the top; the page cannot scroll up further.",
    };
  }
  const location = targeted ? `container (${element.tagName})` : "page";
  const edge = element.scrollTop <= 1
    ? " Reached the top."
    : element.scrollTop >= maxTop - 1 ? " Reached the bottom." : "";
  return {
    success: true,
    message: `Scrolled ${location} by ${scrolled}px over ${durationMs} ms.${edge}`,
  };
}
