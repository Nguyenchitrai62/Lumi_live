import { wait } from "./timing.js";
import {
  GOOGLE_BUTTON_FEEDBACK_DURATION_MS,
  GOOGLE_CARET_BLINK_DURATION_MS,
  GOOGLE_CLICK_RING_DURATION_MS,
  GOOGLE_EFFECT_CLEANUP_DELAY_MS,
  GOOGLE_POINTER_AIM_DURATION_MS,
  GOOGLE_POST_CLICK_DELAY_MS,
  GOOGLE_QUERY_REVEAL_DURATION_MS,
  GOOGLE_STAGE_ENTRANCE_DURATION_MS,
} from "../../core/ui-config.js";

const TAB_TRANSITION_HOST_ID = "lumi-page-agent-tab-transition";
let tabTransitionCleanupTimer = null;

function createGoogleSearchTransitionHost() {
  document.getElementById(TAB_TRANSITION_HOST_ID)?.remove();
  const host = document.createElement("div");
  host.id = TAB_TRANSITION_HOST_ID;
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;inset:0;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      .veil { position:absolute; inset:0; overflow:hidden; background:rgba(19,15,34,.58); backdrop-filter:blur(14px); }
      .stage { position:absolute; left:50%; top:50%; width:min(620px,calc(100vw - 36px)); transform:translate3d(-50%,calc(-50% + 14px),0) scale(.96); opacity:0; animation:lumi-search-in ${GOOGLE_STAGE_ENTRANCE_DURATION_MS}ms cubic-bezier(.2,.8,.2,1) forwards; }
      .brand { display:flex; justify-content:center; margin:0 0 22px; font:600 clamp(36px,7vw,62px)/1 Arial,sans-serif; letter-spacing:-.08em; filter:drop-shadow(0 10px 25px rgba(0,0,0,.2)); }
      .brand span:nth-child(1),.brand span:nth-child(4) { color:#4285f4; }
      .brand span:nth-child(2),.brand span:nth-child(6) { color:#ea4335; }
      .brand span:nth-child(3) { color:#fbbc05; }
      .brand span:nth-child(5) { color:#34a853; }
      .search { display:flex; align-items:center; gap:14px; min-height:58px; padding:0 20px; border:1px solid #dfe1e5; border-radius:999px; background:#fff; box-shadow:0 8px 24px rgba(32,33,36,.24); }
      .magnifier { position:relative; width:17px; height:17px; flex:0 0 auto; border:2px solid #9aa0a6; border-radius:50%; }
      .magnifier::after { content:""; position:absolute; width:7px; height:2px; right:-6px; bottom:-3px; border-radius:2px; background:#9aa0a6; transform:rotate(45deg); }
      .query { min-width:0; overflow:hidden; color:#202124; font:400 18px/1.4 Arial,sans-serif; white-space:nowrap; text-overflow:ellipsis; }
      .caret { width:2px; height:24px; flex:0 0 auto; border-radius:2px; background:#4285f4; animation:lumi-caret ${GOOGLE_CARET_BLINK_DURATION_MS}ms step-end infinite; }
      .actions { display:flex; justify-content:center; margin-top:20px; }
      .search-button { position:relative; min-width:132px; padding:10px 18px; border:1px solid #f8f9fa; border-radius:4px; color:#3c4043; background:#f8f9fa; box-shadow:0 1px 1px rgba(0,0,0,.08); font:500 14px/1 Arial,sans-serif; text-align:center; transition:background ${GOOGLE_BUTTON_FEEDBACK_DURATION_MS}ms ease,border-color ${GOOGLE_BUTTON_FEEDBACK_DURATION_MS}ms ease,box-shadow ${GOOGLE_BUTTON_FEEDBACK_DURATION_MS}ms ease,transform ${GOOGLE_BUTTON_FEEDBACK_DURATION_MS}ms ease; }
      .pointer { position:absolute; z-index:2; left:50%; top:50%; width:30px; height:34px; opacity:0; transform:translate3d(150px,78px,0); filter:drop-shadow(0 3px 4px rgba(0,0,0,.35)); }
      .pointer svg { display:block; width:100%; height:100%; overflow:visible; }
      .click-ring { position:absolute; left:7px; top:7px; width:12px; height:12px; border:2px solid rgba(66,133,244,.9); border-radius:50%; opacity:0; transform:scale(.25); }
      .status { margin:14px 0 0; color:rgba(255,255,255,.9); font:700 12px/1.35 "Segoe UI",sans-serif; letter-spacing:.04em; text-align:center; text-shadow:0 2px 8px rgba(0,0,0,.32); }
      :host([data-state="aim"]) .caret,:host([data-state="click"]) .caret { opacity:0; animation:none; }
      :host([data-state="aim"]) .pointer { animation:lumi-pointer-aim ${GOOGLE_POINTER_AIM_DURATION_MS}ms cubic-bezier(.2,.75,.2,1) forwards; }
      :host([data-state="click"]) .pointer { opacity:1; transform:translate3d(10px,5px,0) scale(.92); }
      :host([data-state="click"]) .click-ring { animation:lumi-click-ring ${GOOGLE_CLICK_RING_DURATION_MS}ms ease-out forwards; }
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

async function revealSearchText(element, text, durationMs = GOOGLE_QUERY_REVEAL_DURATION_MS) {
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
  await wait(GOOGLE_STAGE_ENTRANCE_DURATION_MS);
  status.textContent = "Lumi is typing the destination";
  await revealSearchText(query, String(searchText || "new tab"), GOOGLE_QUERY_REVEAL_DURATION_MS);
  status.textContent = "Opening a new tab";
  host.dataset.state = "aim";
  await wait(GOOGLE_POINTER_AIM_DURATION_MS);
  host.dataset.state = "click";
  await wait(GOOGLE_POST_CLICK_DELAY_MS);
  tabTransitionCleanupTimer = setTimeout(() => host.remove(), GOOGLE_EFFECT_CLEANUP_DELAY_MS);
}
