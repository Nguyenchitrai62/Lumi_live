const INPUT_DEBOUNCE_MS = 650;
const MAX_TEXT_CHARACTERS = 240;

function compactText(value, limit = MAX_TEXT_CHARACTERS) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function elementFromEvent(event) {
  return (event.composedPath?.() || [event.target])
    .find((candidate) => candidate?.nodeType === Node.ELEMENT_NODE) || null;
}

function associatedLabel(element) {
  const labels = Array.from(element?.labels || []);
  if (labels.length) return compactText(labels.map((label) => label.innerText).join(" "));
  const wrappingLabel = element?.closest?.("label");
  if (wrappingLabel) return compactText(wrappingLabel.innerText);
  const elementId = element?.id;
  if (!elementId) return "";
  const escapedId = CSS.escape(elementId);
  return compactText(element.ownerDocument.querySelector(`label[for="${escapedId}"]`)?.innerText);
}

function accessibleName(element) {
  return compactText(
    element.getAttribute("aria-label")
    || associatedLabel(element)
    || element.getAttribute("title")
    || element.getAttribute("alt")
    || element.getAttribute("placeholder")
    || (["BUTTON", "A", "SUMMARY", "OPTION"].includes(element.tagName)
      ? element.innerText || element.textContent
      : "")
    || (["button", "submit", "reset"].includes(String(element.type || "").toLowerCase())
      ? element.value
      : ""),
  );
}

function attributeSelectorValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isLikelyDynamicElementId(value) {
  const id = String(value || "");
  return /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(id)
    || /^(?:react-select|headlessui|radix|mui|ember|mat-input|generated)[-_:]/i.test(id)
    || /[-_:]\d{5,}$/.test(id);
}

function stableSelector(element) {
  const testId = element.getAttribute("data-testid");
  if (testId) return `[data-testid="${attributeSelectorValue(testId)}"]`;
  if (element.id && !isLikelyDynamicElementId(element.id)) return `#${CSS.escape(element.id)}`;
  const name = element.getAttribute("name");
  if (name) {
    const selector = `${element.tagName.toLowerCase()}[name="${attributeSelectorValue(name)}"]`;
    if (element.ownerDocument.querySelectorAll(selector).length === 1) return selector;
  }

  const parts = [];
  let current = element;
  while (current?.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children)
        .filter((candidate) => candidate.tagName === current.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    if (!parent || parent === current.ownerDocument.body) break;
    current = parent;
  }
  return parts.join(" > ");
}

function targetDescriptor(element) {
  const text = ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
    ? ""
    : compactText(element.innerText || element.textContent);
  const href = element instanceof HTMLAnchorElement ? element.href : "";
  return {
    tag: element.tagName.toLowerCase(),
    type: compactText(element.getAttribute("type"), 60).toLowerCase(),
    role: compactText(element.getAttribute("role"), 80).toLowerCase(),
    name: accessibleName(element),
    label: associatedLabel(element),
    text,
    placeholder: compactText(element.getAttribute("placeholder")),
    testId: compactText(element.getAttribute("data-testid")),
    elementId: compactText(element.id),
    inputName: compactText(element.getAttribute("name")),
    href,
    selector: stableSelector(element),
  };
}

function isSensitiveInput(element) {
  const type = String(element.type || "").toLowerCase();
  if (type === "password") return true;
  const identity = [
    element.autocomplete,
    element.name,
    element.id,
    element.getAttribute("aria-label"),
    associatedLabel(element),
  ].filter(Boolean).join(" ");
  return /(?:password|passcode|one.?time|otp|token|secret|api.?key|private.?key|credit.?card|card.?number|cvv|cvc)/i
    .test(identity);
}

function isTextControl(element) {
  if (element?.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(String(element.type || "text").toLowerCase());
}

function textControlValue(element) {
  return element.isContentEditable ? element.innerText : element.value;
}

function clickTarget(element) {
  const candidate = element.closest?.(
    "button,a[href],summary,[role='button'],[role='link'],[role='menuitem'],[role='tab'],"
    + "input[type='button'],input[type='submit'],input[type='reset'],[onclick],[tabindex]",
  );
  if (candidate) {
    if (candidate.matches("label") || candidate.closest("label")?.control) return null;
    return candidate;
  }
  const delegatedTarget = element.closest?.(
    "[data-action],[data-route],[data-href]",
  );
  return delegatedTarget || null;
}

export function createFlowRecorder({
  emit,
  documentObject = document,
  windowObject = window,
}) {
  let active = false;
  let sessionId = "";
  const pendingInputs = new Map();

  function emitStep(step) {
    if (!active || !sessionId) return Promise.resolve();
    return Promise.resolve(emit({
      sessionId,
      step: {
        ...step,
        url: windowObject.location.href,
        title: documentObject.title,
        recordedAt: Date.now(),
      },
    })).catch(() => {});
  }

  function flushInput(element) {
    const pending = pendingInputs.get(element);
    if (pending?.timerId) windowObject.clearTimeout(pending.timerId);
    pendingInputs.delete(element);
    if (!active || !element?.isConnected) return Promise.resolve();
    if (isSensitiveInput(element)) {
      return emitStep({
        action: "fill",
        target: targetDescriptor(element),
        redacted: true,
      });
    }
    return emitStep({
      action: "fill",
      target: targetDescriptor(element),
      value: textControlValue(element),
    });
  }

  function queueInput(element) {
    const pending = pendingInputs.get(element);
    if (pending?.timerId) windowObject.clearTimeout(pending.timerId);
    const timerId = windowObject.setTimeout(() => flushInput(element), INPUT_DEBOUNCE_MS);
    pendingInputs.set(element, { timerId });
  }

  function onInput(event) {
    if (!active || !event.isTrusted) return;
    const element = elementFromEvent(event);
    if (!isTextControl(element)) return;
    queueInput(element);
  }

  function onChange(event) {
    if (!active || !event.isTrusted) return;
    const element = elementFromEvent(event);
    if (!element) return;
    if (isTextControl(element)) {
      flushInput(element);
      return;
    }
    if (element instanceof HTMLSelectElement) {
      emitStep({
        action: "select_option",
        target: targetDescriptor(element),
        value: element.value,
        optionText: compactText(element.selectedOptions?.[0]?.textContent),
      });
      return;
    }
    if (
      element instanceof HTMLInputElement
      && ["checkbox", "radio"].includes(String(element.type).toLowerCase())
    ) {
      emitStep({
        action: "set_checked",
        target: targetDescriptor(element),
        value: Boolean(element.checked),
      });
    }
  }

  function onBlur(event) {
    if (!active) return;
    const element = elementFromEvent(event);
    if (pendingInputs.has(element)) flushInput(element);
  }

  function onClick(event) {
    if (!active || !event.isTrusted || event.button !== 0) return;
    const origin = elementFromEvent(event);
    if (!origin) return;
    if (
      origin instanceof HTMLInputElement
      && ["checkbox", "radio"].includes(String(origin.type).toLowerCase())
    ) return;
    if (
      isTextControl(origin)
      || origin instanceof HTMLSelectElement
      || origin.closest?.("input,textarea,select,[contenteditable='true'],label")
    ) return;
    const element = clickTarget(origin);
    if (!element) return;
    emitStep({
      action: "click",
      target: targetDescriptor(element),
    });
  }

  function onSubmit(event) {
    if (!active || !event.isTrusted) return;
    const target = event.submitter || event.target;
    if (!(target instanceof Element)) return;
    emitStep({
      action: event.submitter ? "click" : "submit",
      target: targetDescriptor(target),
    });
  }

  function addListeners() {
    documentObject.addEventListener("click", onClick, true);
    documentObject.addEventListener("input", onInput, true);
    documentObject.addEventListener("change", onChange, true);
    documentObject.addEventListener("blur", onBlur, true);
    documentObject.addEventListener("submit", onSubmit, true);
  }

  function removeListeners() {
    documentObject.removeEventListener("click", onClick, true);
    documentObject.removeEventListener("input", onInput, true);
    documentObject.removeEventListener("change", onChange, true);
    documentObject.removeEventListener("blur", onBlur, true);
    documentObject.removeEventListener("submit", onSubmit, true);
  }

  function start(nextSessionId) {
    const normalizedSessionId = String(nextSessionId || "").trim();
    if (!normalizedSessionId) throw new Error("A recording session ID is required.");
    if (!active) addListeners();
    active = true;
    sessionId = normalizedSessionId;
    return { success: true, recording: true, sessionId };
  }

  async function stop() {
    await Promise.all([...pendingInputs.keys()].map((element) => flushInput(element)));
    removeListeners();
    const stoppedSessionId = sessionId;
    active = false;
    sessionId = "";
    return { success: true, recording: false, sessionId: stoppedSessionId };
  }

  return {
    isActive: () => active,
    start,
    stop,
  };
}
