const INPUT_DEBOUNCE_MS = 650;
const MAX_TEXT_CHARACTERS = 240;
const MAX_RECORDED_SELECTOR_CANDIDATES = 12;
const MAX_RECORDED_ANCESTORS = 6;
const STABLE_DATA_ATTRIBUTE_NAMES = [
  "data-testid",
  "data-test",
  "data-cy",
  "data-qa",
  "data-action",
  "data-route",
  "data-href",
  "data-key",
  "data-id",
  "data-control",
  "data-name",
];

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
  const escapedId = cssIdentifier(elementId);
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

function cssIdentifier(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => (
    `\\${character.codePointAt(0).toString(16)} `
  ));
}

function isLikelyDynamicElementId(value) {
  const id = String(value || "");
  return /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(id)
    || /^(?:react-select|headlessui|radix|mui|ember|mat-input|generated)[-_:]/i.test(id)
    || /[-_:]\d{5,}$/.test(id);
}

function stableDataAttributes(element) {
  const attributes = {};
  for (const name of STABLE_DATA_ATTRIBUTE_NAMES) {
    const value = compactText(element?.getAttribute?.(name), 240);
    if (value && !/(?:password|passcode|token|secret|api.?key|private.?key)/i.test(name)) {
      attributes[name] = value;
    }
  }
  return attributes;
}

function stableClassNames(element) {
  return String(element?.getAttribute?.("class") || "")
    .split(/\s+/)
    .map((value) => compactText(value, 100))
    .filter((value) => (
      value
      && !/^(?:active|focus|focused|hover|selected|disabled|open|closed)$/i.test(value)
      && !/^(?:css|jsx)-[a-z0-9]{5,}$/i.test(value)
    ))
    .slice(0, 12);
}

function selectorMatchesOnlyElement(element, selector) {
  try {
    const matches = Array.from(element.ownerDocument?.querySelectorAll?.(selector) || []);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

function structuralSelector(element) {
  const parts = [];
  let current = element;
  while (current?.nodeType === Node.ELEMENT_NODE && parts.length < 12) {
    let part = current.tagName.toLowerCase();
    const testId = current.getAttribute("data-testid");
    if (testId) {
      parts.unshift(`[data-testid="${attributeSelectorValue(testId)}"]`);
      return parts.join(" > ");
    }
    if (current.id && !isLikelyDynamicElementId(current.id)) {
      parts.unshift(`#${cssIdentifier(current.id)}`);
      return parts.join(" > ");
    }
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

function stableSelectorCandidates(element) {
  const tag = element.tagName.toLowerCase();
  const candidates = [];
  const add = (selector) => {
    const normalized = compactText(selector, 1000);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  for (const [name, value] of Object.entries(stableDataAttributes(element))) {
    add(`[${name}="${attributeSelectorValue(value)}"]`);
  }
  if (element.id) add(`#${cssIdentifier(element.id)}`);
  const name = compactText(element.getAttribute("name"));
  if (name) add(`${tag}[name="${attributeSelectorValue(name)}"]`);
  const ariaLabel = compactText(element.getAttribute("aria-label"));
  if (ariaLabel) add(`${tag}[aria-label="${attributeSelectorValue(ariaLabel)}"]`);
  const type = compactText(element.getAttribute("type"), 60).toLowerCase();
  if (type) add(`${tag}[type="${attributeSelectorValue(type)}"]`);
  const role = compactText(element.getAttribute("role"), 80).toLowerCase();
  if (role) add(`${tag}[role="${attributeSelectorValue(role)}"]`);
  const classes = stableClassNames(element);
  if (classes.length) add(`${tag}.${classes.slice(0, 3).map(cssIdentifier).join(".")}`);
  add(structuralSelector(element));
  return candidates
    .sort((left, right) => (
      Number(selectorMatchesOnlyElement(element, right))
      - Number(selectorMatchesOnlyElement(element, left))
    ))
    .slice(0, MAX_RECORDED_SELECTOR_CANDIDATES);
}

function stableSelector(element) {
  return stableSelectorCandidates(element)[0] || "";
}

function contextDescriptor(element) {
  if (!element) return null;
  return {
    tag: String(element.tagName || "").toLowerCase(),
    role: compactText(element.getAttribute?.("role"), 80).toLowerCase(),
    name: accessibleName(element),
    text: compactText(element.innerText || element.textContent),
    title: compactText(element.getAttribute?.("title")),
    testId: compactText(element.getAttribute?.("data-testid")),
    elementId: compactText(element.id),
    classNames: stableClassNames(element),
    dataAttributes: stableDataAttributes(element),
    selector: stableSelector(element),
  };
}

function ancestorDescriptors(element) {
  const ancestors = [];
  for (
    let current = element?.parentElement;
    current && current !== element.ownerDocument?.body && ancestors.length < MAX_RECORDED_ANCESTORS;
    current = current.parentElement
  ) {
    ancestors.push(contextDescriptor(current));
  }
  return ancestors.filter(Boolean);
}

function recordedHoverTarget(element, ancestors) {
  let hovered = [];
  try {
    hovered = Array.from(element.ownerDocument?.querySelectorAll?.(":hover") || []);
  } catch {
    return null;
  }
  const hoveredSet = new Set(hovered);
  const ancestorElements = [];
  for (let current = element?.parentElement; current; current = current.parentElement) {
    ancestorElements.push(current);
  }
  const hoveredAncestorIndex = ancestorElements.findIndex((candidate) => hoveredSet.has(candidate));
  if (hoveredAncestorIndex < 0) return null;
  return ancestors[hoveredAncestorIndex] || contextDescriptor(ancestorElements[hoveredAncestorIndex]);
}

function semanticOrdinal(element, name) {
  const tag = String(element.tagName || "").toLowerCase();
  if (!tag || !name) return null;
  const type = compactText(element.getAttribute?.("type"), 60).toLowerCase();
  const selector = type
    ? `${tag}[type="${attributeSelectorValue(type)}"]`
    : tag;
  let candidates = [];
  try {
    candidates = Array.from(element.ownerDocument?.querySelectorAll?.(selector) || [])
      .filter((candidate) => accessibleName(candidate) === name);
  } catch {
    return null;
  }
  const index = candidates.indexOf(element);
  return index >= 0 ? index : null;
}

export function targetDescriptor(element, { origin = element } = {}) {
  const text = ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
    ? ""
    : compactText(element.innerText || element.textContent);
  const tag = element.tagName.toLowerCase();
  const href = tag === "a" ? compactText(element.href || element.getAttribute("href"), 1000) : "";
  const name = accessibleName(element);
  const selectors = stableSelectorCandidates(element);
  const ancestors = ancestorDescriptors(element);
  const form = element.form || element.closest?.("form");
  return {
    tag,
    type: compactText(element.getAttribute("type"), 60).toLowerCase(),
    role: compactText(element.getAttribute("role"), 80).toLowerCase(),
    name,
    label: associatedLabel(element),
    text,
    title: compactText(element.getAttribute("title")),
    value: ["button", "submit", "reset"].includes(String(element.type || "").toLowerCase())
      ? compactText(element.value)
      : "",
    placeholder: compactText(element.getAttribute("placeholder")),
    testId: compactText(element.getAttribute("data-testid")),
    elementId: compactText(element.id),
    inputName: compactText(element.getAttribute("name")),
    classNames: stableClassNames(element),
    dataAttributes: stableDataAttributes(element),
    href,
    selector: selectors[0] || "",
    selectors,
    semanticOrdinal: semanticOrdinal(element, name),
    ancestors,
    hoverTarget: recordedHoverTarget(element, ancestors),
    form: form ? contextDescriptor(form) : null,
    origin: origin && origin !== element ? contextDescriptor(origin) : null,
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
      target: targetDescriptor(element, { origin }),
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
