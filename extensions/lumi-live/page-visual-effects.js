const TAB_TRANSITION_HOST_ID = "lumi-page-agent-tab-transition";

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

export async function typeTextGradually(element, text, durationMs) {
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
  element.focus({ preventScroll: true });
  replaceTextAndDispatchInput(element, "", "deleteContentBackward");

  if (characters.length && duration > 0) {
    const startedAt = elementWindow.performance.now();
    let renderedCount = 0;
    while (renderedCount < characters.length) {
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

  const EventConstructor = elementWindow.Event || Event;
  element.dispatchEvent(new EventConstructor("change", { bubbles: true }));
  element.blur();
}

function createTabTransitionHost() {
  document.getElementById(TAB_TRANSITION_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = TAB_TRANSITION_HOST_ID;
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;inset:0;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { color-scheme: light dark; }
      .veil { position:absolute; inset:0; overflow:hidden; background:rgba(19,15,34,.56); backdrop-filter:blur(14px); transition:background .34s ease,backdrop-filter .34s ease; }
      .stage { position:absolute; left:50%; top:50%; width:min(620px,calc(100vw - 36px)); transform:translate(-50%,-50%) translateY(14px) scale(.96); opacity:0; animation:lumi-search-in 1s cubic-bezier(.2,.8,.2,1) forwards; }
      .brand { display:flex; justify-content:center; margin:0 0 22px; font:600 clamp(36px,7vw,62px)/1 Arial,sans-serif; letter-spacing:-.08em; filter:drop-shadow(0 10px 25px rgba(0,0,0,.2)); }
      .brand span:nth-child(1),.brand span:nth-child(4) { color:#4285f4; }
      .brand span:nth-child(2),.brand span:nth-child(6) { color:#ea4335; }
      .brand span:nth-child(3) { color:#fbbc05; }
      .brand span:nth-child(5) { color:#34a853; }
      .search { display:flex; align-items:center; gap:14px; min-height:58px; padding:0 20px; border:1px solid #dfe1e5; border-radius:999px; background:#fff; box-shadow:0 8px 24px rgba(32,33,36,.24); transition:transform .2s ease,box-shadow .2s ease; }
      .magnifier { width:17px; height:17px; flex:0 0 auto; border:2px solid #9aa0a6; border-radius:50%; position:relative; }
      .magnifier::after { content:""; position:absolute; width:7px; height:2px; right:-6px; bottom:-3px; border-radius:2px; background:#9aa0a6; transform:rotate(45deg); }
      .query { min-width:0; overflow:hidden; color:#202124; font:400 18px/1.4 Arial,sans-serif; white-space:nowrap; text-overflow:ellipsis; }
      .caret { width:2px; height:24px; flex:0 0 auto; border-radius:2px; background:#4285f4; animation:lumi-caret .7s step-end infinite; }
      .actions { display:flex; justify-content:center; margin-top:20px; }
      .search-button { position:relative; min-width:132px; padding:10px 18px; border:1px solid #f8f9fa; border-radius:4px; color:#3c4043; background:#f8f9fa; box-shadow:0 1px 1px rgba(0,0,0,.08); font:500 14px/1 Arial,sans-serif; text-align:center; transition:background .1s ease,border-color .1s ease,box-shadow .1s ease,transform .1s ease; }
      .pointer { position:absolute; z-index:2; left:50%; top:50%; width:30px; height:34px; opacity:0; transform:translate(150px,78px); filter:drop-shadow(0 3px 4px rgba(0,0,0,.35)); }
      .pointer svg { display:block; width:100%; height:100%; overflow:visible; }
      .click-ring { position:absolute; left:7px; top:7px; width:12px; height:12px; border:2px solid rgba(66,133,244,.9); border-radius:50%; opacity:0; transform:scale(.25); }
      .status { margin:14px 0 0; color:rgba(255,255,255,.88); font:700 12px/1.35 "Segoe UI",sans-serif; letter-spacing:.04em; text-align:center; text-shadow:0 2px 8px rgba(0,0,0,.32); }
      :host([data-state="aim"]) .caret,:host([data-state="click"]) .caret { opacity:0; animation:none; }
      :host([data-state="aim"]) .pointer { animation:lumi-pointer-aim .36s cubic-bezier(.2,.75,.2,1) forwards; }
      :host([data-state="click"]) .pointer { opacity:1; transform:translate(10px,5px) scale(.92); }
      :host([data-state="click"]) .click-ring { animation:lumi-click-ring .24s ease-out forwards; }
      :host([data-state="click"]) .search-button { border-color:#dadce0; background:#eef3fe; box-shadow:inset 0 1px 3px rgba(60,64,67,.2); transform:translateY(2px); }
      @keyframes lumi-search-in { to { transform:translate(-50%,-50%) translateY(0) scale(1); opacity:1; } }
      @keyframes lumi-caret { 50% { opacity:0; } }
      @keyframes lumi-pointer-aim { from { opacity:0; transform:translate(150px,78px); } 18% { opacity:1; } to { opacity:1; transform:translate(10px,5px); } }
      @keyframes lumi-click-ring { 0% { opacity:.9; transform:scale(.25); } 100% { opacity:0; transform:scale(2.4); } }
      @media (prefers-reduced-motion:reduce) { .stage { animation:none; transform:translate(-50%,-50%); opacity:1; } .caret,.magnifier { animation:none; } :host([data-state="aim"]) .pointer { animation:none; opacity:1; transform:translate(10px,5px); } }
    </style>
    <div class="veil">
      <div class="stage">
        <div class="brand" aria-hidden="true"><span>G</span><span>o</span><span>o</span><span>g</span><span>l</span><span>e</span></div>
        <div class="search"><span class="magnifier"></span><span class="query"></span><span class="caret"></span></div>
        <div class="actions">
          <div class="search-button">Google Search
            <span class="pointer" aria-hidden="true">
              <svg viewBox="0 0 30 34"><path d="M3 2.5 25.5 23l-10.4.6-5.2 8.8z" fill="#fff" stroke="#202124" stroke-width="2" stroke-linejoin="round"/></svg>
              <span class="click-ring"></span>
            </span>
          </div>
        </div>
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

export async function showTabDeparture(searchText = "new tab") {
  const { host, query, status } = createTabTransitionHost();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await wait(1000);
  status.textContent = "Lumi is typing the destination";
  await revealSearchText(query, String(searchText || "new tab"), 500);
  status.textContent = "Opening a new tab";
  host.dataset.state = "aim";
  await wait(360);
  host.dataset.state = "click";
  await wait(100);
  setTimeout(() => host.remove(), 1200);
}
