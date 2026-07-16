import { PageController } from "@page-agent/page-controller";

const CONTENT_REQUEST_SOURCE = "lumi-page-agent-service";
const MAX_STATE_CHARACTERS = 16000;
const GLOBAL_KEY = "__LUMI_PAGE_AGENT_CONTROLLER__";
const HIGHLIGHT_STYLE_ID = "lumi-page-agent-highlight-preference";

if (!globalThis[GLOBAL_KEY]) {
  const runtime = {
    controller: null,
    stateIndexed: false,
    visualPreferences: {
      showElementHighlights: true,
    },
  };
  globalThis[GLOBAL_KEY] = runtime;

  function getController() {
    if (!runtime.controller) {
      runtime.controller = new PageController({
        enableMask: true,
        viewportExpansion: 0,
        highlightOpacity: 0.08,
        highlightLabelOpacity: 0.82,
        includeAttributes: [
          "aria-label",
          "aria-expanded",
          "aria-selected",
          "aria-checked",
          "role",
          "name",
          "placeholder",
          "type",
          "title",
          "href",
          "disabled",
        ],
      });
    }
    return runtime.controller;
  }

  function applyVisualPreferences() {
    let style = document.getElementById(HIGHLIGHT_STYLE_ID);
    if (runtime.visualPreferences.showElementHighlights) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = HIGHLIGHT_STYLE_ID;
      style.textContent = "#playwright-highlight-container { display: none !important; }";
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function requireIndex(args) {
    const index = Number(args?.index);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error("A non-negative element index from the latest page state is required.");
    }
    if (!runtime.stateIndexed) {
      throw new Error("Read browser_get_page_state before using an element index.");
    }
    return index;
  }

  function indexedElement(index) {
    return getController().selectorMap?.get(index)?.ref || null;
  }

  function assertSafeInput(index) {
    const element = indexedElement(index);
    if (!(element instanceof HTMLElement)) return;
    const descriptor = [
      element.getAttribute("type"),
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("autocomplete"),
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
    ].filter(Boolean).join(" ").toLowerCase();

    if (/(password|passcode|mật.?khẩu|otp|one.?time|mã.?xác.?thực|credit.?card|card.?number|thẻ.?tín.?dụng|cvv|cvc|api.?key|khóa.?api|secret|bí.?mật|access.?token)/i.test(descriptor)) {
      throw new Error("Lumi blocks typing passwords, OTPs, payment-card data, API keys, and other secrets.");
    }
  }

  function assertConfirmedHighImpactClick(index, confirmed) {
    const element = indexedElement(index);
    if (!(element instanceof HTMLElement)) return;
    const label = [
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ].filter(Boolean).join(" ").trim().slice(0, 240);

    if (/(submit|send|gửi|publish|xuất.?bản|post|đăng|pay|thanh.?toán|purchase|buy now|mua.?ngay|place order|đặt.?hàng|delete|xóa|remove account|xóa.?tài.?khoản|confirm order|xác.?nhận.?đơn|authorize|ủy.?quyền|transfer|chuyển.?tiền|unsubscribe|hủy.?đăng.?ký|save password)/i.test(label) && confirmed !== true) {
      throw new Error(
        `This looks like a consequential action (${label || "unlabeled control"}). Ask for explicit confirmation, then retry with confirmed=true.`,
      );
    }
  }

  async function withVisualAction(action) {
    const pageController = getController();
    await pageController.showMask();
    try {
      return await action(pageController);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 420));
      await pageController.hideMask();
      await pageController.cleanUpHighlights();
      runtime.stateIndexed = false;
    }
  }

  async function handleControllerTool(tool, args = {}) {
    const pageController = getController();

    if (tool === "bridge_controller_ping") {
      return { success: true, ready: true, visualPreferences: runtime.visualPreferences };
    }

    if (tool === "bridge_set_visual_preferences") {
      runtime.visualPreferences.showElementHighlights = args.showElementHighlights !== false;
      applyVisualPreferences();
      if (!runtime.visualPreferences.showElementHighlights) {
        await pageController.cleanUpHighlights();
      }
      return { success: true, visualPreferences: runtime.visualPreferences };
    }

    if (tool === "browser_get_page_state") {
      applyVisualPreferences();
      const state = await pageController.getBrowserState();
      runtime.stateIndexed = true;
      if (!runtime.visualPreferences.showElementHighlights) {
        await pageController.cleanUpHighlights();
      }
      const content = state.content.length > MAX_STATE_CHARACTERS
        ? `${state.content.slice(0, MAX_STATE_CHARACTERS)}\n[Page state truncated]`
        : state.content;
      return { success: true, ...state, content };
    }

    if (tool === "browser_click") {
      const index = requireIndex(args);
      assertConfirmedHighImpactClick(index, args.confirmed);
      return withVisualAction((activeController) => activeController.clickElement(index));
    }

    if (tool === "browser_input_text") {
      const index = requireIndex(args);
      const text = String(args.text ?? "");
      assertSafeInput(index);
      return withVisualAction((activeController) => activeController.inputText(index, text));
    }

    if (tool === "browser_select_option") {
      const index = requireIndex(args);
      const optionText = String(args.optionText ?? "").trim();
      if (!optionText) throw new Error("optionText is required.");
      return withVisualAction((activeController) => activeController.selectOption(index, optionText));
    }

    if (tool === "browser_scroll") {
      if (!runtime.stateIndexed) {
        await pageController.getBrowserState();
        runtime.stateIndexed = true;
      }
      const direction = args.direction === "up" ? "up" : "down";
      const pages = Math.min(3, Math.max(0.25, Number(args.pages) || 0.8));
      const index = args.index === undefined ? undefined : requireIndex(args);
      return withVisualAction((activeController) => activeController.scroll({
        down: direction === "down",
        numPages: pages,
        index,
      }));
    }

    throw new Error(`Unsupported PageAgent controller tool: ${tool}`);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.source !== CONTENT_REQUEST_SOURCE) return false;
    handleControllerTool(message.tool, message.args)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "PageAgent controller failed.",
      }));
    return true;
  });
}
