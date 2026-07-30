(() => {
  if (globalThis.__siteCapabilityIndexerLabInstalled) return;
  globalThis.__siteCapabilityIndexerLabInstalled = true;
  const MESSAGE_SCOPE = "site-capability-indexer-lab";
  let mutationVersion = 0;
  let lastMutationAt = performance.now();
  const activityObserver = new MutationObserver(() => {
    mutationVersion += 1;
    lastMutationAt = performance.now();
  });
  activityObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  function normalizeText(value, maxLength = 240) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/["\\#.:,[\]()]/g, "\\$&");
  }

  function collectRoots() {
    const roots = [document];
    const seen = new Set(roots);
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex];
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot && !seen.has(element.shadowRoot)) {
          seen.add(element.shadowRoot);
          roots.push(element.shadowRoot);
        }
        if (element.tagName === "IFRAME") {
          try {
            const frameDocument = element.contentDocument;
            if (frameDocument && !seen.has(frameDocument)) {
              seen.add(frameDocument);
              roots.push(frameDocument);
            }
          } catch {
            // Cross-origin frames are intentionally skipped.
          }
        }
      }
    }
    return roots;
  }

  function isRendered(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (element.closest("[hidden],[inert],[aria-hidden='true']")) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    if (
      style.display === "none"
      || style.visibility === "hidden"
      || Number(style.opacity) === 0
    ) return false;
    return element.getClientRects().length > 0;
  }

  function semanticName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledText = labelledBy
      ? labelledBy.split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent || "")
        .join(" ")
      : "";
    const label = element.labels?.length
      ? [...element.labels].map((item) => item.textContent || "").join(" ")
      : "";
    return normalizeText(
      element.getAttribute("aria-label")
      || labelledText
      || label
      || element.getAttribute("alt")
      || element.getAttribute("title")
      || element.getAttribute("placeholder")
      || element.textContent
      || element.innerText,
    );
  }

  function elementRole(element) {
    const explicitRole = normalizeText(element.getAttribute("role"), 40).toLowerCase();
    if (explicitRole) return explicitRole;
    if (element.tagName === "A" && element.href) return "link";
    if (element.tagName === "BUTTON" || element.tagName === "SUMMARY") return "button";
    if (element.tagName === "INPUT") {
      if (["checkbox", "radio", "button", "submit"].includes(element.type)) {
        return element.type === "submit" ? "button" : element.type;
      }
      return "textbox";
    }
    if (element.tagName === "SELECT") return "combobox";
    if (element.tagName === "TEXTAREA") return "textbox";
    return element.tagName.toLowerCase();
  }

  function stableSelector(element) {
    if (element.id) return `#${cssEscape(element.id)}`;
    for (const attribute of ["data-testid", "data-test", "data-qa"]) {
      const value = element.getAttribute(attribute);
      if (value) return `[${attribute}="${cssEscape(value)}"]`;
    }
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return `${element.tagName.toLowerCase()}[aria-label="${cssEscape(ariaLabel)}"]`;
    }
    const name = element.getAttribute("name");
    if (name) return `${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 6) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName)
        : [];
      const position = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      parts.unshift(`${tag}${position}`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function actionRecord(element) {
    const name = semanticName(element);
    const tag = element.tagName.toLowerCase();
    const declaredType = normalizeText(element.getAttribute("type"), 30).toLowerCase();
    const effectiveType = (
      ["BUTTON", "INPUT"].includes(element.tagName)
      && element.form
    ) ? normalizeText(element.type, 30).toLowerCase() : declaredType;
    const href = element.tagName === "A"
      ? element.href
      : element.getAttribute("href")
        ? new URL(element.getAttribute("href"), element.ownerDocument.location.href).href
        : "";
    const contextElement = element.closest("nav,form,dialog,[role='dialog'],li,tr,section,article");
    const record = {
      selector: stableSelector(element),
      tag,
      role: elementRole(element),
      name: name || `${elementRole(element)} without a label`,
      title: normalizeText(element.getAttribute("title")),
      context: normalizeText(contextElement?.getAttribute("aria-label") || contextElement?.textContent, 180),
      href,
      type: effectiveType,
      formAction: element.hasAttribute("formaction")
        ? normalizeText(element.formAction, 400)
        : "",
      download: element.hasAttribute("download"),
      expanded: element.hasAttribute("aria-expanded")
        ? element.getAttribute("aria-expanded") === "true"
        : null,
      hasPopup: Boolean(
        element.hasAttribute("aria-haspopup")
        && element.getAttribute("aria-haspopup") !== "false"
      ),
      disabled: Boolean(
        element.matches(":disabled")
        || element.getAttribute("aria-disabled") === "true"
      ),
    };
    record.key = [
      record.tag,
      record.role,
      normalizeText(record.name, 120).toLowerCase(),
      record.href,
      record.type,
      record.formAction,
      record.download,
      record.selector,
    ].join("|");
    return record;
  }

  function allRenderedElements(selector, roots = collectRoots()) {
    const results = [];
    const seen = new Set();
    for (const root of roots) {
      for (const element of root.querySelectorAll(selector)) {
        if (seen.has(element) || !isRendered(element)) continue;
        seen.add(element);
        results.push(element);
      }
    }
    return results;
  }

  function scanForms(roots) {
    return allRenderedElements("form", roots).slice(0, 40).map((form, formIndex) => ({
      name: normalizeText(
        form.getAttribute("aria-label")
        || form.querySelector("legend")?.textContent
        || form.querySelector("h1,h2,h3,h4")?.textContent
        || `Form ${formIndex + 1}`,
      ),
      method: normalizeText(form.getAttribute("method") || "get", 12).toUpperCase(),
      fields: [...form.querySelectorAll("input,select,textarea")]
        .filter((field) => isRendered(field) && field.type !== "hidden")
        .slice(0, 80)
        .map((field) => ({
          type: field.tagName === "SELECT"
            ? "select"
            : field.tagName === "TEXTAREA" ? "textarea" : field.type || "text",
          name: normalizeText(field.getAttribute("name"), 80),
          label: semanticName(field),
          required: field.required || field.getAttribute("aria-required") === "true",
        })),
    }));
  }

  function hashText(value) {
    const text = String(value || "");
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeStateText(value) {
    return normalizeText(value, 5000)
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "{id}")
      .replace(/\b[0-9a-f]{16,}\b/giu, "{id}")
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu, "{time}")
      .replace(/\b\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\b/gu, "{date}")
      .replace(/\b\d+(?:[.,]\d+)*\b/gu, "{number}");
  }

  function stateNames(selector, limit = 40, roots = collectRoots()) {
    return [...new Set(
      allRenderedElements(selector, roots)
        .slice(0, limit)
        .map((element) => semanticName(element))
        .filter(Boolean),
    )];
  }

  function scanStateSignals(forms, roots) {
    const mainRegion = allRenderedElements("main,[role='main'],article", roots)[0]
      || (isRendered(document.body) ? document.body : null);
    const mainText = normalizeStateText(mainRegion?.innerText || "");
    return {
      selected: stateNames(
        "[aria-selected='true'],[aria-current]:not([aria-current='false']),[data-state='active']",
        40,
        roots,
      ),
      expanded: stateNames("[aria-expanded='true']", 40, roots),
      tableHeaders: stateNames("th,[role='columnheader']", 80, roots),
      mainTextHash: hashText(mainText),
      formSchemaHash: hashText(forms.map((form) => [
        form.name,
        form.method,
        ...(form.fields || []).map((field) => `${field.type}:${field.label || field.name}`),
      ].join("|")).join("\n")),
    };
  }

  function scanDocument() {
    const roots = collectRoots();
    const headings = allRenderedElements("h1,h2,h3,h4,h5,h6,[role='heading']", roots)
      .slice(0, 80)
      .map((element) => ({
        level: Number(element.getAttribute("aria-level"))
          || Number(element.tagName.slice(1))
          || 2,
        text: semanticName(element),
      }))
      .filter((heading) => heading.text);
    const landmarks = allRenderedElements(
      "header,nav,main,aside,footer,[role='banner'],[role='navigation'],[role='main'],[role='complementary'],[role='contentinfo']",
      roots,
    ).slice(0, 40).map((element) => ({
      role: elementRole(element),
      name: normalizeText(element.getAttribute("aria-label") || element.querySelector("h1,h2,h3")?.textContent),
    }));
    const dialogs = allRenderedElements("dialog[open],[role='dialog'],[role='alertdialog']", roots)
      .slice(0, 20)
      .map((element) => semanticName(element))
      .filter(Boolean);
    const actionElements = allRenderedElements([
      "a[href]",
      "button",
      "input[type='button']",
      "input[type='submit']",
      "input[type='reset']",
      "input[type='image']",
      "summary",
      "[role='button']",
      "[role='tab']",
      "[role='link']",
      "[aria-expanded]",
      "[aria-haspopup]",
    ].join(","), roots);
    const actions = actionElements.slice(0, 500).map(actionRecord);
    const forms = scanForms(roots);
    return {
      url: location.href,
      origin: location.origin,
      title: normalizeText(document.title || headings[0]?.text || location.hostname),
      language: normalizeText(document.documentElement.lang, 20),
      headings,
      landmarks,
      dialogs,
      forms,
      actions,
      stateSignals: scanStateSignals(forms, roots),
      stats: {
        renderedActions: actions.length,
        renderedForms: document.forms.length,
        openDialogs: dialogs.length,
        roots: roots.length,
      },
    };
  }

  function findAction(action) {
    const roots = collectRoots();
    const candidates = allRenderedElements([
      "a[href]",
      "button",
      "input[type='button']",
      "input[type='submit']",
      "input[type='reset']",
      "input[type='image']",
      "summary",
      "[role='button']",
      "[role='tab']",
      "[role='link']",
      "[aria-expanded]",
      "[aria-haspopup]",
    ].join(","), roots);
    const exact = candidates.find((element) => actionRecord(element).key === action.key);
    if (exact) return exact;
    for (const root of roots) {
      try {
        const bySelector = root.querySelector(action.selector);
        if (bySelector && isRendered(bySelector)) {
          const candidate = actionRecord(bySelector);
          if (
            candidate.tag === action.tag
            && candidate.role === action.role
            && candidate.name.toLowerCase() === String(action.name || "").toLowerCase()
            && candidate.type === String(action.type || "")
            && candidate.formAction === String(action.formAction || "")
            && candidate.download === Boolean(action.download)
          ) {
            return bySelector;
          }
        }
      } catch {
        // Fall back to semantic matching below.
      }
    }
    return candidates.find((element) => {
      const candidate = actionRecord(element);
      return candidate.tag === action.tag
        && candidate.role === action.role
        && candidate.name.toLowerCase() === String(action.name || "").toLowerCase()
        && candidate.type === String(action.type || "")
        && candidate.formAction === String(action.formAction || "")
        && candidate.download === Boolean(action.download);
    }) || null;
  }

  function comparableUrl(value) {
    const parsed = new URL(value, location.href);
    parsed.searchParams.sort();
    return parsed.href;
  }

  function navigateTo(destination) {
    let target;
    try {
      target = comparableUrl(destination);
    } catch {
      return { success: true, clicked: false };
    }
    for (const root of collectRoots()) {
      for (const element of root.querySelectorAll("a[href]")) {
        if (!isVisible(element)) continue;
        try {
          if (comparableUrl(element.href) !== target) continue;
        } catch {
          continue;
        }
        element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
        element.click();
        return {
          success: true,
          clicked: true,
          urlBeforeClick: location.href,
        };
      }
    }
    return { success: true, clicked: false };
  }

  function clickAction(action) {
    const element = findAction(action);
    if (!element) return { success: false, error: "The indexed control is no longer present." };
    if (
      element.matches(":disabled")
      || element.getAttribute("aria-disabled") === "true"
    ) {
      return { success: false, error: "The indexed control is disabled." };
    }
    const currentAction = actionRecord(element);
    if (
      ["submit", "reset", "image"].includes(currentAction.type)
      || currentAction.formAction
      || currentAction.download
    ) {
      return { success: false, error: "The indexed control is now potentially consequential." };
    }
    element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    element.click();
    return {
      success: true,
      urlBeforeClick: location.href,
      action: currentAction,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.scope !== MESSAGE_SCOPE) return false;
    try {
      if (message.type === "ping") {
        sendResponse({ success: true });
        return false;
      }
      if (message.type === "scan") {
        sendResponse({ success: true, snapshot: scanDocument() });
        return false;
      }
      if (message.type === "click") {
        sendResponse(clickAction(message.action));
        return false;
      }
      if (message.type === "navigate") {
        sendResponse(navigateTo(message.destination));
        return false;
      }
      if (message.type === "stability") {
        sendResponse({
          success: true,
          readyState: document.readyState,
          mutationVersion,
          quietForMs: Math.max(0, performance.now() - lastMutationAt),
        });
        return false;
      }
      sendResponse({ success: false, error: "Unsupported indexer content command." });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "The page could not be inspected.",
      });
    }
    return false;
  });
})();
