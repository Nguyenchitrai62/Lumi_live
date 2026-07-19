const TAB_TRANSITION_HOST_ID = "lumi-page-agent-tab-transition";
const SCROLL_EFFECT_HOST_ID = "lumi-page-agent-scroll-effect";
let tabTransitionCleanupTimer = null;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function setNativeControlValue(element, value) {
  const elementWindow = element.ownerDocument.defaultView || window;
  const prototype = element.tagName === "TEXTAREA"
    ? elementWindow.HTMLTextAreaElement.prototype
    : elementWindow.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("The input does not expose a native value setter.");
  setter.call(element, value);
  try {
    element.setSelectionRange(value.length, value.length);
  } catch {
    // Some input types, such as number and date, do not expose a text selection.
  }
}

function replaceTextAndDispatchInput(element, value, inputType, data = null) {
  const elementWindow = element.ownerDocument.defaultView || window;
  const InputEventConstructor = elementWindow.InputEvent || InputEvent;
  element.dispatchEvent(new InputEventConstructor("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType,
    data,
  }));
  replaceVisibleText(element, value);
  element.dispatchEvent(new InputEventConstructor("input", {
    bubbles: true,
    inputType,
    data,
  }));
}

function replaceVisibleText(element, value) {
  if (element.isContentEditable) {
    element.innerText = value;
    return;
  }
  setNativeControlValue(element, value);
}

export async function typeTextGradually(element, text, durationMs, signal) {
  const isTextControl = element?.tagName === "INPUT"
    || element?.tagName === "TEXTAREA"
    || element?.isContentEditable;
  if (!isTextControl) {
    throw new Error("Element is not an input, textarea, or contenteditable.");
  }

  const elementWindow = element.ownerDocument.defaultView || window;
  const rawText = String(text);
  const segmenter = elementWindow.Intl?.Segmenter
    ? new elementWindow.Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
  const characters = segmenter
    ? [...segmenter.segment(rawText)].map(({ segment }) => segment)
    : Array.from(rawText);
  const duration = Math.max(0, Number(durationMs) || 0);
  const originalValue = element.isContentEditable ? element.innerText : element.value;
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new DOMException("The page action was cancelled by the user.", "AbortError");
  };
  throwIfCancelled();
  element.focus({ preventScroll: true });
  replaceTextAndDispatchInput(element, "", "deleteContentBackward");

  try {
    if (characters.length && duration > 0) {
      const startedAt = elementWindow.performance.now();
      let renderedCount = 0;
      while (renderedCount < characters.length) {
        throwIfCancelled();
        const elapsed = elementWindow.performance.now() - startedAt;
        const nextCount = Math.min(
          characters.length,
          Math.max(1, Math.ceil((elapsed / duration) * characters.length)),
        );
        if (nextCount > renderedCount) {
          const insertedText = characters.slice(renderedCount, nextCount).join("");
          replaceTextAndDispatchInput(
            element,
            characters.slice(0, nextCount).join(""),
            "insertText",
            insertedText,
          );
          renderedCount = nextCount;
        }
        if (renderedCount < characters.length) {
          await new Promise((resolve) => elementWindow.requestAnimationFrame(resolve));
        }
      }
      const remaining = duration - (elementWindow.performance.now() - startedAt);
      if (remaining > 0) await wait(remaining);
    } else if (characters.length) {
      replaceTextAndDispatchInput(element, characters.join(""), "insertText", characters.join(""));
    }
    throwIfCancelled();
  } catch (error) {
    if (signal?.aborted) {
      replaceTextAndDispatchInput(element, originalValue, "insertReplacementText", originalValue);
    }
    element.blur();
    throw error;
  }

  const EventConstructor = elementWindow.Event || Event;
  element.dispatchEvent(new EventConstructor("change", { bubbles: true }));
  element.blur();
}

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
      .frame { position:absolute; inset:10px; border:1px solid rgba(122,207,255,.34); border-radius:18px; box-shadow:inset 0 0 38px rgba(45,155,218,.11); opacity:0; animation:lumi-scroll-frame-in .18s ease-out forwards; }
      .hud { position:absolute; right:max(20px,3vw); top:50%; display:grid; grid-template-columns:30px auto; align-items:center; gap:10px; min-width:142px; padding:10px 13px 10px 10px; border:1px solid rgba(194,231,255,.45); border-radius:999px; color:#fff; background:linear-gradient(135deg,rgba(12,49,76,.9),rgba(22,91,129,.84)); box-shadow:0 14px 36px rgba(4,30,49,.3),inset 0 1px rgba(255,255,255,.16); backdrop-filter:blur(12px); transform:translate(14px,-50%); opacity:0; animation:lumi-scroll-hud-in .22s cubic-bezier(.2,.8,.2,1) forwards; }
      .motion { position:relative; width:30px; height:30px; display:grid; place-items:center; overflow:hidden; border-radius:50%; color:#d7f4ff; background:rgba(255,255,255,.13); }
      .arrow { width:8px; height:8px; border-right:2px solid currentColor; border-bottom:2px solid currentColor; transform:rotate(45deg) translate(-1px,-1px); animation:lumi-scroll-arrow .72s ease-in-out infinite; }
      :host([data-direction="up"]) .arrow { transform:rotate(225deg) translate(-1px,-1px); animation-name:lumi-scroll-arrow-up; }
      .copy { display:grid; gap:3px; min-width:76px; font:700 10px/1.1 "Segoe UI",sans-serif; letter-spacing:.02em; }
      .copy small { color:rgba(225,245,255,.72); font:800 7px/1 "Segoe UI",sans-serif; letter-spacing:.14em; text-transform:uppercase; }
      .track { grid-column:1/-1; height:2px; overflow:hidden; border-radius:2px; background:rgba(255,255,255,.17); }
      .track::after { content:""; display:block; width:100%; height:100%; border-radius:inherit; background:linear-gradient(90deg,#7bdcff,#d8f7ff); transform-origin:left; transform:scaleX(var(--progress)); }
      :host([data-state="done"]) .hud,:host([data-state="done"]) .frame { opacity:0; transition:opacity .16s ease; }
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
      await wait(170);
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

export async function scrollPageGradually({
  direction = "down",
  pages = 0.8,
  indexedElement,
  durationMs = 1000,
  signal,
} = {}) {
  const scrollTarget = findVerticalScroller(indexedElement);
  const effect = createScrollEffect(direction);
  if (!scrollTarget) {
    effect.update(1);
    await effect.finish();
    return { success: true, message: "No scrollable container was found for that element." };
  }

  const { element, targeted } = scrollTarget;
  const startTop = element.scrollTop;
  const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
  const viewportDistance = targeted ? window.innerHeight / 3 : window.innerHeight;
  const signedDistance = viewportDistance * pages * (direction === "up" ? -1 : 1);
  const targetTop = Math.max(0, Math.min(maxTop, startTop + signedDistance));
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

function createGoogleSearchTransitionHost() {
  document.getElementById(TAB_TRANSITION_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = TAB_TRANSITION_HOST_ID;
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;inset:0;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      .veil { position:absolute; inset:0; overflow:hidden; background:rgba(19,15,34,.58); backdrop-filter:blur(14px); }
      .stage { position:absolute; left:50%; top:50%; width:min(620px,calc(100vw - 36px)); transform:translate3d(-50%,calc(-50% + 14px),0) scale(.96); opacity:0; animation:lumi-search-in 1s cubic-bezier(.2,.8,.2,1) forwards; }
      .brand { display:flex; justify-content:center; margin:0 0 22px; font:600 clamp(36px,7vw,62px)/1 Arial,sans-serif; letter-spacing:-.08em; filter:drop-shadow(0 10px 25px rgba(0,0,0,.2)); }
      .brand span:nth-child(1),.brand span:nth-child(4) { color:#4285f4; }
      .brand span:nth-child(2),.brand span:nth-child(6) { color:#ea4335; }
      .brand span:nth-child(3) { color:#fbbc05; }
      .brand span:nth-child(5) { color:#34a853; }
      .search { display:flex; align-items:center; gap:14px; min-height:58px; padding:0 20px; border:1px solid #dfe1e5; border-radius:999px; background:#fff; box-shadow:0 8px 24px rgba(32,33,36,.24); }
      .magnifier { position:relative; width:17px; height:17px; flex:0 0 auto; border:2px solid #9aa0a6; border-radius:50%; }
      .magnifier::after { content:""; position:absolute; width:7px; height:2px; right:-6px; bottom:-3px; border-radius:2px; background:#9aa0a6; transform:rotate(45deg); }
      .query { min-width:0; overflow:hidden; color:#202124; font:400 18px/1.4 Arial,sans-serif; white-space:nowrap; text-overflow:ellipsis; }
      .caret { width:2px; height:24px; flex:0 0 auto; border-radius:2px; background:#4285f4; animation:lumi-caret .7s step-end infinite; }
      .actions { display:flex; justify-content:center; margin-top:20px; }
      .search-button { position:relative; min-width:132px; padding:10px 18px; border:1px solid #f8f9fa; border-radius:4px; color:#3c4043; background:#f8f9fa; box-shadow:0 1px 1px rgba(0,0,0,.08); font:500 14px/1 Arial,sans-serif; text-align:center; transition:background .1s ease,border-color .1s ease,box-shadow .1s ease,transform .1s ease; }
      .pointer { position:absolute; z-index:2; left:50%; top:50%; width:30px; height:34px; opacity:0; transform:translate3d(150px,78px,0); filter:drop-shadow(0 3px 4px rgba(0,0,0,.35)); }
      .pointer svg { display:block; width:100%; height:100%; overflow:visible; }
      .click-ring { position:absolute; left:7px; top:7px; width:12px; height:12px; border:2px solid rgba(66,133,244,.9); border-radius:50%; opacity:0; transform:scale(.25); }
      .status { margin:14px 0 0; color:rgba(255,255,255,.9); font:700 12px/1.35 "Segoe UI",sans-serif; letter-spacing:.04em; text-align:center; text-shadow:0 2px 8px rgba(0,0,0,.32); }
      :host([data-state="aim"]) .caret,:host([data-state="click"]) .caret { opacity:0; animation:none; }
      :host([data-state="aim"]) .pointer { animation:lumi-pointer-aim .36s cubic-bezier(.2,.75,.2,1) forwards; }
      :host([data-state="click"]) .pointer { opacity:1; transform:translate3d(10px,5px,0) scale(.92); }
      :host([data-state="click"]) .click-ring { animation:lumi-click-ring .24s ease-out forwards; }
      :host([data-state="click"]) .search-button { border-color:#dadce0; background:#eef3fe; box-shadow:inset 0 1px 3px rgba(60,64,67,.2); transform:translateY(2px); }
      @keyframes lumi-search-in { to { transform:translate3d(-50%,-50%,0) scale(1); opacity:1; } }
      @keyframes lumi-caret { 50% { opacity:0; } }
      @keyframes lumi-pointer-aim { from { opacity:0; transform:translate3d(150px,78px,0); } 18% { opacity:1; } to { opacity:1; transform:translate3d(10px,5px,0); } }
      @keyframes lumi-click-ring { from { opacity:.9; transform:scale(.25); } to { opacity:0; transform:scale(2.4); } }
      @media (prefers-reduced-motion:reduce) { .stage { animation:none; transform:translate3d(-50%,-50%,0); opacity:1; } .caret { animation:none; } :host([data-state="aim"]) .pointer { animation:none; opacity:1; transform:translate3d(10px,5px,0); } }
    </style>
    <div class="veil">
      <div class="stage">
        <div class="brand" aria-hidden="true"><span>G</span><span>o</span><span>o</span><span>g</span><span>l</span><span>e</span></div>
        <div class="search"><span class="magnifier"></span><span class="query"></span><span class="caret"></span></div>
        <div class="actions"><div class="search-button">Google Search
          <span class="pointer" aria-hidden="true">
            <svg viewBox="0 0 30 34"><path d="M3 2.5 25.5 23l-10.4.6-5.2 8.8z" fill="#fff" stroke="#202124" stroke-width="2" stroke-linejoin="round"/></svg>
            <span class="click-ring"></span>
          </span>
        </div></div>
        <div class="status">Lumi is preparing a new tab</div>
      </div>
    </div>`;
  (document.documentElement || document.body).append(host);
  return {
    host,
    query: shadow.querySelector(".query"),
    status: shadow.querySelector(".status"),
  };
}

async function revealSearchText(element, text, durationMs = 500) {
  const elementWindow = element.ownerDocument.defaultView || window;
  const segmenter = elementWindow.Intl?.Segmenter
    ? new elementWindow.Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
  const characters = segmenter
    ? [...segmenter.segment(String(text))].map(({ segment }) => segment)
    : Array.from(String(text));
  const startedAt = elementWindow.performance.now();
  let renderedCount = 0;
  while (renderedCount < characters.length) {
    const elapsed = elementWindow.performance.now() - startedAt;
    const nextCount = Math.min(
      characters.length,
      Math.max(1, Math.ceil((elapsed / durationMs) * characters.length)),
    );
    if (nextCount > renderedCount) {
      element.textContent = characters.slice(0, nextCount).join("");
      renderedCount = nextCount;
    }
    if (renderedCount < characters.length) {
      await new Promise((resolve) => elementWindow.requestAnimationFrame(resolve));
    }
  }
  const remaining = durationMs - (elementWindow.performance.now() - startedAt);
  if (remaining > 0) await wait(remaining);
}

export function clearTabTransition() {
  clearTimeout(tabTransitionCleanupTimer);
  tabTransitionCleanupTimer = null;
  document.getElementById(TAB_TRANSITION_HOST_ID)?.remove();
}

export async function showGoogleSearchDeparture(searchText = "new tab") {
  clearTabTransition();
  const { host, query, status } = createGoogleSearchTransitionHost();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await wait(1000);
  status.textContent = "Lumi is typing the destination";
  await revealSearchText(query, String(searchText || "new tab"), 500);
  status.textContent = "Opening a new tab";
  host.dataset.state = "aim";
  await wait(360);
  host.dataset.state = "click";
  await wait(120);
  tabTransitionCleanupTimer = setTimeout(() => host.remove(), 12000);
}
