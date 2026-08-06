const INPUT_DEBOUNCE_MS = 650;
const MAX_TEXT_CHARACTERS = 240;
const MAX_RECORDED_SELECTOR_CANDIDATES = 12;
const MAX_RECORDED_ANCESTORS = 6;
const MAX_RECORDED_DOM_PATH_SEGMENTS = 10;
const MAX_RECORDED_HOVER_ANCESTOR_INDEX = 2;
const SEMANTIC_FIELD_CONTROL_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='radio']",
  "[role='searchbox']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='textbox']",
  "[aria-haspopup='listbox']",
].join(",");
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
  "data-value",
];
const CUSTOM_SELECT_ROOT_SELECTOR = [
  ".ant-select",
  ".ng-select",
  ".p-dropdown",
  ".p-select",
  ".mat-mdc-select",
  ".mat-select",
  ".select2-container",
  ".el-select",
  ".v-select",
].join(",");
const CUSTOM_SELECT_TRIGGER_SELECTOR = [
  "[role='combobox']",
  "[aria-haspopup='listbox']",
  CUSTOM_SELECT_ROOT_SELECTOR,
  ".ant-select-selector",
  ".ng-select-container",
  ".select2-selection",
].join(",");
const CUSTOM_SELECT_OPTION_SELECTOR = [
  "[role='option']",
  "[role='menuitemradio']",
  ".ant-select-item-option",
  ".ng-option",
  ".p-dropdown-item",
  ".p-select-option",
  ".mat-mdc-option",
  ".mat-option",
  ".select2-results__option",
  ".el-select-dropdown__item",
  ".vs__dropdown-option",
].join(",");
const CUSTOM_SELECT_POPUP_SELECTOR = [
  "[role='listbox']",
  "[role='menu']",
  ".ant-select-dropdown",
  ".ng-dropdown-panel",
  ".p-dropdown-panel",
  ".p-select-overlay",
  ".mat-mdc-select-panel",
  ".select2-results",
  ".el-select-dropdown",
  ".vs__dropdown-menu",
].join(",");
const FILE_DROP_TARGET_SELECTOR = [
  "[data-dropzone]",
  "[data-upload]",
  ".ant-upload-drag",
  ".ant-upload-btn",
  ".ant-upload",
  "[class*='dropzone']",
  "[class*='file-upload']",
  "[class*='upload-area']",
  "[role='button']",
  "label",
].join(",");
const FILE_UPLOAD_TRIGGER_PATTERN = /\b(upload|attach|browse|choose|import|file)\b|tải\s*lên|đính\s*kèm|chọn\s*(?:tệp|file)/i;

function compactText(value, limit = MAX_TEXT_CHARACTERS) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function elementFromEvent(event) {
  return (event.composedPath?.() || [event.target])
    .find((candidate) => candidate?.nodeType === Node.ELEMENT_NODE) || null;
}

function looksLikeFieldWidget(element) {
  if (element?.matches?.(SEMANTIC_FIELD_CONTROL_SELECTOR)) return true;
  if (element?.querySelector?.(SEMANTIC_FIELD_CONTROL_SELECTOR)) return true;
  const identity = [
    element?.getAttribute?.("class"),
    element?.getAttribute?.("role"),
    element?.getAttribute?.("aria-haspopup"),
  ].filter(Boolean).join(" ");
  return /(?:^|[-_\s])(combobox|control|dropdown|field|picker|select)(?:$|[-_\s])/i.test(identity);
}

function contextualControlLabel(element, { force = false } = {}) {
  const isFieldControl = force || looksLikeFieldWidget(element);
  if (!isFieldControl) return "";
  const componentRoot = element.closest?.(CUSTOM_SELECT_ROOT_SELECTOR);
  const controlText = compactText(
    element.innerText
    || element.textContent
    || element.value
    || element.getAttribute?.("aria-valuetext")
    || componentRoot?.innerText
    || componentRoot?.textContent,
  );
  let depth = 0;
  for (let current = element.parentElement; current && depth < 4; current = current.parentElement) {
    depth += 1;
    const contextText = compactText(current.innerText || current.textContent);
    if (!contextText || contextText.length > 160) continue;
    let label = contextText;
    if (controlText) {
      const index = label.toLocaleLowerCase().indexOf(controlText.toLocaleLowerCase());
      if (index < 0) continue;
      label = compactText(`${label.slice(0, index)} ${label.slice(index + controlText.length)}`);
    }
    if (label && label !== controlText) return label;
  }
  return "";
}

function associatedLabel(element, { allowContextual = false } = {}) {
  const labels = Array.from(element?.labels || []);
  if (labels.length) return compactText(labels.map((label) => label.innerText).join(" "));
  const wrappingLabel = element?.closest?.("label");
  if (wrappingLabel) return compactText(wrappingLabel.innerText);
  const labelledBy = compactText(element?.getAttribute?.("aria-labelledby"));
  if (labelledBy) {
    const labelledText = compactText(labelledBy.split(/\s+/).map((id) => (
      element.ownerDocument?.getElementById?.(id)?.innerText
      || element.ownerDocument?.getElementById?.(id)?.textContent
      || ""
    )).join(" "));
    if (labelledText) return labelledText;
  }
  const elementId = element?.id;
  if (elementId) {
    const escapedId = cssIdentifier(elementId);
    const explicitLabel = compactText(
      element.ownerDocument.querySelector(`label[for="${escapedId}"]`)?.innerText,
    );
    if (explicitLabel) return explicitLabel;
  }
  return contextualControlLabel(element, { force: allowContextual });
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
    || /^(?:react-select|rc[_-]select|headlessui|radix|mui|ember|mat-input|generated)[-_:]/i.test(id)
    || /[-_:]\d{5,}$/.test(id);
}

function stableElementId(element) {
  return element?.id && !isLikelyDynamicElementId(element.id)
    ? compactText(element.id)
    : "";
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
      && !/(?:^|[-_])(?:active|checked|closed|disabled|expanded|focus|focused|hover|loading|open|selected)(?:$|[-_])/i.test(value)
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
  if (element.id && !isLikelyDynamicElementId(element.id)) {
    add(`#${cssIdentifier(element.id)}`);
  }
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
    elementId: stableElementId(element),
    classNames: stableClassNames(element),
    dataAttributes: stableDataAttributes(element),
    selector: stableSelector(element),
  };
}

function elementPosition(element) {
  const siblings = Array.from(element?.parentElement?.children || []);
  const sameTagSiblings = siblings.filter((candidate) => candidate.tagName === element?.tagName);
  const childIndex = siblings.indexOf(element);
  const sameTagIndex = sameTagSiblings.indexOf(element);
  return {
    childIndex: childIndex >= 0 ? childIndex : null,
    sameTagIndex: sameTagIndex >= 0 ? sameTagIndex : null,
  };
}

function domPathSegment(element) {
  if (!element) return null;
  return {
    ...contextDescriptor(element),
    type: compactText(element.getAttribute?.("type"), 60).toLowerCase(),
    inputName: compactText(element.getAttribute?.("name")),
    ...elementPosition(element),
  };
}

function domFingerprint(element) {
  const path = [];
  for (
    let current = element;
    current && current !== element.ownerDocument?.documentElement
      && path.length < MAX_RECORDED_DOM_PATH_SEGMENTS;
    current = current.parentElement
  ) {
    const segment = domPathSegment(current);
    if (segment) path.push(segment);
  }
  return {
    path,
    previousSibling: domPathSegment(element?.previousElementSibling),
    nextSibling: domPathSegment(element?.nextElementSibling),
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
  for (
    let current = element?.parentElement;
    current && current !== element.ownerDocument?.body;
    current = current.parentElement
  ) {
    ancestorElements.push(current);
  }
  const hoveredAncestorIndex = ancestorElements.findIndex((candidate) => hoveredSet.has(candidate));
  if (
    hoveredAncestorIndex < 0
    || hoveredAncestorIndex > MAX_RECORDED_HOVER_ANCESTOR_INDEX
    || !ancestors[hoveredAncestorIndex]
  ) return null;
  return ancestors[hoveredAncestorIndex];
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

export function targetDescriptor(element, { action = "", origin = element } = {}) {
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
    label: associatedLabel(element, {
      allowContextual: ["fill", "select_option", "set_checked"].includes(action),
    }),
    text,
    title: compactText(element.getAttribute("title")),
    value: ["button", "submit", "reset"].includes(String(element.type || "").toLowerCase())
      ? compactText(element.value)
      : "",
    placeholder: compactText(element.getAttribute("placeholder")),
    testId: compactText(element.getAttribute("data-testid")),
    elementId: stableElementId(element),
    inputName: compactText(element.getAttribute("name")),
    classNames: stableClassNames(element),
    dataAttributes: stableDataAttributes(element),
    href,
    selector: selectors[0] || "",
    selectors,
    semanticOrdinal: semanticOrdinal(element, name),
    domFingerprint: domFingerprint(element),
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

function editableControlFrom(element) {
  if (!element?.closest) return element;
  return element.closest(
    "input,textarea,[contenteditable]:not([contenteditable='false'])",
  ) || element;
}

function isTextControl(element) {
  if (element?.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return ![
    "button",
    "checkbox",
    "file",
    "hidden",
    "image",
    "radio",
    "reset",
    "submit",
  ].includes(String(element.type || "text").toLowerCase());
}

function textControlValue(element) {
  return element.isContentEditable ? element.innerText : element.value;
}

function clickTarget(element) {
  const candidate = element.closest?.(
    "button,a[href],summary,[role='button'],[role='checkbox'],[role='link'],[role='menuitem'],"
    + "[role='menuitemcheckbox'],[role='menuitemradio'],[role='radio'],[role='switch'],[role='tab'],"
    + "[role='treeitem'],[aria-pressed],"
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

function isFileInput(element) {
  return element instanceof HTMLInputElement
    && String(element.type || "").toLowerCase() === "file";
}

function fileInputFrom(element) {
  const direct = element?.closest?.("input[type='file']");
  if (direct) return direct;
  const label = element?.closest?.("label");
  if (!label) return null;
  const labelled = label.htmlFor
    ? label.ownerDocument?.getElementById?.(label.htmlFor)
    : label.querySelector?.("input[type='file']");
  return isFileInput(labelled) ? labelled : null;
}

function fileMetadata(fileList) {
  return Array.from(fileList || []).map((file) => ({
    lastModified: Number(file.lastModified) || 0,
    name: compactText(file.name, 500),
    size: Number(file.size) || 0,
    type: compactText(file.type, 200).toLowerCase(),
  })).filter((file) => file.name);
}

function fileUploadSignature(files) {
  return files.map((file) => (
    `${file.name}\u0000${file.size}\u0000${file.lastModified}\u0000${file.type}`
  )).join("\u0001");
}

function fileDropSurface(element) {
  return element?.closest?.(FILE_DROP_TARGET_SELECTOR) || element;
}

function relatedFileInput(element) {
  const direct = fileInputFrom(element);
  if (direct) return direct;
  for (let current = element, depth = 0;
    current && depth < 7;
    current = current.parentElement, depth += 1) {
    const nested = current.querySelector?.("input[type='file']");
    if (isFileInput(nested)) return nested;
  }
  return null;
}

function customSelectTrigger(element, { allowNestedTrigger = true } = {}) {
  const direct = element?.closest?.(CUSTOM_SELECT_TRIGGER_SELECTOR);
  if (direct) return direct.closest?.(CUSTOM_SELECT_ROOT_SELECTOR) || direct;
  if (
    !allowNestedTrigger
    || element?.matches?.("input,textarea,select,[contenteditable]")
  ) return null;
  for (let current = element?.parentElement, depth = 0;
    current && depth < 5;
    current = current.parentElement, depth += 1) {
    const nested = current.querySelector?.(CUSTOM_SELECT_TRIGGER_SELECTOR);
    if (nested) return current.closest?.(CUSTOM_SELECT_ROOT_SELECTOR) || current;
  }
  return null;
}

function customSelectSurface(element) {
  const hasVisibleBox = (candidate) => {
    const rect = candidate?.getBoundingClientRect?.();
    if (!rect) return true;
    return rect.width > 0 && rect.height > 0;
  };
  const componentRoot = element?.closest?.(CUSTOM_SELECT_ROOT_SELECTOR);
  if (componentRoot && hasVisibleBox(componentRoot)) return componentRoot;
  if (hasVisibleBox(element)) return element;
  for (let current = element?.parentElement, depth = 0;
    current && depth < 5;
    current = current.parentElement, depth += 1) {
    if (hasVisibleBox(current)) return current;
  }
  return element;
}

function customSelectReplayTrigger(element) {
  if (!element) return null;
  // Record the control the user actually interacted with. Frameworks such as
  // Ant Design expose an opacity-zero semantic input inside a visible wrapper;
  // saving that hidden input makes direct replay fail its visibility check.
  // The semantic input can always be rediscovered inside the saved wrapper.
  return customSelectSurface(element);
}

function customSelectOption(element) {
  const semanticOption = element?.closest?.(CUSTOM_SELECT_OPTION_SELECTOR);
  if (semanticOption) return semanticOption;
  const dataOption = element?.closest?.("[data-value]");
  return dataOption?.closest?.(CUSTOM_SELECT_POPUP_SELECTOR) ? dataOption : null;
}

function customSelectOptionValue(option) {
  return compactText(
    option?.getAttribute?.("data-value")
    || option?.getAttribute?.("value")
    || option?.getAttribute?.("aria-label")
    || option?.innerText
    || option?.textContent,
    2000,
  );
}

function customSelectOptionDescriptor(option, { origin = option } = {}) {
  const descriptor = targetDescriptor(option, { origin });
  const text = compactText(option?.innerText || option?.textContent);
  const value = customSelectOptionValue(option);
  return {
    ...descriptor,
    role: descriptor.role || "option",
    name: text || value,
    label: "",
    text: text || value,
    value,
  };
}

function relatedCustomSelectTrigger(option, recentTrigger) {
  const listbox = option?.closest?.(CUSTOM_SELECT_POPUP_SELECTOR);
  const listboxId = compactText(listbox?.id, 240);
  if (listboxId) {
    const escapedId = attributeSelectorValue(listboxId);
    const controlled = option.ownerDocument?.querySelector?.(
      `[aria-controls="${escapedId}"],[aria-owns="${escapedId}"]`,
    );
    if (controlled) return controlled;
  }
  const activeElement = option?.ownerDocument?.activeElement;
  const activeTrigger = customSelectTrigger(activeElement);
  if (activeTrigger) return activeTrigger;
  const expandedTrigger = option?.ownerDocument?.querySelector?.(
    "[role='combobox'][aria-expanded='true'],[aria-haspopup='listbox'][aria-expanded='true'],"
    + ".ant-select-open,.ng-select-opened,.p-dropdown-open,.p-select-open",
  );
  if (expandedTrigger) return expandedTrigger;
  return recentTrigger?.isConnected ? recentTrigger : null;
}

function customToggleTarget(element) {
  return element?.closest?.(
    "[role='checkbox'],[role='radio'],[role='switch'],[aria-pressed]",
  ) || null;
}

function customToggleValue(element) {
  const value = element?.getAttribute?.("aria-checked")
    ?? element?.getAttribute?.("aria-pressed");
  if (value === null) return null;
  return String(value).toLowerCase() === "true";
}

function eventModifiers(event) {
  return {
    alt: event.altKey === true,
    ctrl: event.ctrlKey === true,
    meta: event.metaKey === true,
    shift: event.shiftKey === true,
  };
}

function looksLikeFileUploadTrigger(element) {
  const descriptor = [
    element?.innerText,
    element?.textContent,
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("title"),
    element?.getAttribute?.("name"),
    element?.id,
  ].filter(Boolean).join(" ");
  return FILE_UPLOAD_TRIGGER_PATTERN.test(descriptor);
}

export function createFlowRecorder({
  emit,
  documentObject = document,
  windowObject = window,
}) {
  let active = false;
  let sessionId = "";
  let dragSource = null;
  let recentCustomSelectTrigger = null;
  let recentFileTrigger = null;
  let recentRecordedUpload = null;
  let uploadVariableSequence = 0;
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
    const element = editableControlFrom(elementFromEvent(event));
    if (!isTextControl(element)) return;
    queueInput(element);
  }

  function recordFileUpload({ files: rawFiles, input = null, trigger = null }) {
    const files = fileMetadata(rawFiles);
    if (!files.length) return;
    const signature = fileUploadSignature(files);
    const now = Date.now();
    if (
      recentRecordedUpload?.signature === signature
      && now - recentRecordedUpload.at < 1500
    ) return;
    const target = input || trigger;
    if (!target) return;
    recentRecordedUpload = { at: now, signature };
    const fileVariables = files.map(() => `UPLOAD_FILE_${++uploadVariableSequence}`);
    emitStep({
      accept: compactText(input?.getAttribute?.("accept"), 1000),
      action: "upload_file",
      files,
      fileVariables,
      localFilePaths: [],
      multiple: input ? Boolean(input.multiple) : files.length > 1,
      target: targetDescriptor(target),
      triggerTarget: trigger && trigger !== target ? targetDescriptor(trigger) : null,
    });
  }

  function onChange(event) {
    if (!active || !event.isTrusted) return;
    const eventElement = elementFromEvent(event);
    const element = editableControlFrom(eventElement);
    if (!element) return;
    if (isFileInput(element)) {
      const trigger = recentFileTrigger?.element?.isConnected
        && Date.now() - recentFileTrigger.at < 30000
        ? recentFileTrigger.element
        : null;
      recentFileTrigger = null;
      recordFileUpload({ files: element.files, input: element, trigger });
      return;
    }
    if (element instanceof HTMLSelectElement) {
      const selectedOptions = Array.from(element.selectedOptions || []);
      emitStep({
        action: "select_option",
        target: targetDescriptor(element),
        value: element.value,
        values: selectedOptions.map((option) => String(option.value)),
        optionText: compactText(selectedOptions[0]?.textContent),
        optionTexts: selectedOptions.map((option) => compactText(option.textContent)),
      });
      return;
    }
    const customTrigger = customSelectTrigger(element, { allowNestedTrigger: false });
    if (customTrigger) {
      const activeOptionId = compactText(customTrigger.getAttribute("aria-activedescendant"), 240);
      const selectedOption = activeOptionId
        ? customTrigger.ownerDocument?.getElementById?.(activeOptionId)
        : customTrigger.ownerDocument?.querySelector?.("[role='option'][aria-selected='true']");
      const selectedText = customSelectOptionValue(selectedOption)
        || compactText(element.value || element.getAttribute?.("aria-valuetext"));
      if (selectedText) {
        const pending = pendingInputs.get(element);
        if (pending?.timerId) windowObject.clearTimeout(pending.timerId);
        pendingInputs.delete(element);
        emitStep({
          action: "select_option",
          optionTarget: selectedOption ? customSelectOptionDescriptor(selectedOption) : null,
          optionText: selectedText,
          target: targetDescriptor(customSelectReplayTrigger(customTrigger), {
            action: "select_option",
          }),
          value: selectedText,
          values: [selectedText],
          optionTexts: [selectedText],
        });
      }
      return;
    }
    if (isTextControl(element)) {
      flushInput(element);
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
    const element = editableControlFrom(elementFromEvent(event));
    if (pendingInputs.has(element)) flushInput(element);
  }

  function onClick(event) {
    if (!active || !event.isTrusted || event.button !== 0) return;
    const origin = elementFromEvent(event);
    if (!origin) return;
    const fileInput = fileInputFrom(origin);
    if (fileInput) {
      recentFileTrigger = {
        at: Date.now(),
        element: origin.closest?.("label,button,[role='button']") || fileInput,
      };
      return;
    }
    if (
      origin instanceof HTMLInputElement
      && ["checkbox", "radio"].includes(String(origin.type).toLowerCase())
    ) return;
    const option = customSelectOption(origin);
    if (option) {
      const trigger = customSelectReplayTrigger(
        relatedCustomSelectTrigger(option, recentCustomSelectTrigger),
      );
      recentCustomSelectTrigger = null;
      if (trigger) {
        const optionText = compactText(option.innerText || option.textContent);
        emitStep({
          action: "select_option",
          optionTarget: customSelectOptionDescriptor(option, { origin }),
          optionText,
          target: targetDescriptor(trigger, { action: "select_option" }),
          value: customSelectOptionValue(option),
          values: [customSelectOptionValue(option)],
          optionTexts: [optionText],
        });
        return;
      }
    }
    const selectTrigger = customSelectTrigger(origin);
    if (selectTrigger) {
      recentCustomSelectTrigger = customSelectReplayTrigger(selectTrigger);
      return;
    }
    const toggle = customToggleTarget(origin);
    if (toggle && !(toggle instanceof HTMLInputElement)) {
      windowObject.setTimeout(() => {
        if (!active || !toggle.isConnected) return;
        const value = customToggleValue(toggle);
        if (value === null) {
          emitStep({
            action: "click",
            modifiers: eventModifiers(event),
            target: targetDescriptor(toggle, { origin }),
          });
          return;
        }
        emitStep({
          action: "set_checked",
          target: targetDescriptor(toggle, { origin }),
          value,
        });
      }, 0);
      return;
    }
    if (
      isTextControl(editableControlFrom(origin))
      || origin instanceof HTMLSelectElement
      || origin.closest?.("input,textarea,select,[contenteditable='true'],label")
    ) return;
    const element = clickTarget(origin);
    if (!element) return;
    if (looksLikeFileUploadTrigger(element)) {
      recentFileTrigger = { at: Date.now(), element };
    }
    emitStep({
      action: "click",
      modifiers: eventModifiers(event),
      target: targetDescriptor(element, { origin }),
    });
  }

  function onDoubleClick(event) {
    if (!active || !event.isTrusted || event.button !== 0) return;
    const origin = elementFromEvent(event);
    const element = origin && clickTarget(origin);
    if (!element) return;
    emitStep({
      action: "double_click",
      modifiers: eventModifiers(event),
      target: targetDescriptor(element, { origin }),
    });
  }

  function onContextMenu(event) {
    if (!active || !event.isTrusted) return;
    const origin = elementFromEvent(event);
    const element = origin && (clickTarget(origin) || origin);
    if (!element) return;
    emitStep({
      action: "context_click",
      modifiers: eventModifiers(event),
      target: targetDescriptor(element, { origin }),
    });
  }

  function onDragStart(event) {
    if (!active || !event.isTrusted) return;
    const origin = elementFromEvent(event);
    const source = origin?.closest?.("[draggable='true']") || origin;
    dragSource = source ? targetDescriptor(source, { origin }) : null;
  }

  function onDrop(event) {
    if (!active || !event.isTrusted) return;
    const origin = elementFromEvent(event);
    if (!origin) return;
    const droppedFiles = event.dataTransfer?.files;
    if (droppedFiles?.length) {
      const trigger = fileDropSurface(origin);
      recordFileUpload({
        files: droppedFiles,
        input: relatedFileInput(trigger),
        trigger,
      });
      dragSource = null;
      recentFileTrigger = null;
      return;
    }
    if (!dragSource) return;
    emitStep({
      action: "drag_drop",
      destinationTarget: targetDescriptor(origin),
      target: dragSource,
    });
    dragSource = null;
  }

  function onDragEnd() {
    dragSource = null;
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
    documentObject.addEventListener("contextmenu", onContextMenu, true);
    documentObject.addEventListener("dblclick", onDoubleClick, true);
    documentObject.addEventListener("dragend", onDragEnd, true);
    documentObject.addEventListener("dragstart", onDragStart, true);
    documentObject.addEventListener("drop", onDrop, true);
    documentObject.addEventListener("input", onInput, true);
    documentObject.addEventListener("change", onChange, true);
    documentObject.addEventListener("blur", onBlur, true);
    documentObject.addEventListener("submit", onSubmit, true);
  }

  function removeListeners() {
    documentObject.removeEventListener("click", onClick, true);
    documentObject.removeEventListener("contextmenu", onContextMenu, true);
    documentObject.removeEventListener("dblclick", onDoubleClick, true);
    documentObject.removeEventListener("dragend", onDragEnd, true);
    documentObject.removeEventListener("dragstart", onDragStart, true);
    documentObject.removeEventListener("drop", onDrop, true);
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
    dragSource = null;
    recentCustomSelectTrigger = null;
    recentFileTrigger = null;
    recentRecordedUpload = null;
    uploadVariableSequence = 0;
    return { success: true, recording: true, sessionId };
  }

  async function stop() {
    await Promise.all([...pendingInputs.keys()].map((element) => flushInput(element)));
    removeListeners();
    const stoppedSessionId = sessionId;
    active = false;
    sessionId = "";
    dragSource = null;
    recentCustomSelectTrigger = null;
    recentFileTrigger = null;
    recentRecordedUpload = null;
    return { success: true, recording: false, sessionId: stoppedSessionId };
  }

  return {
    isActive: () => active,
    start,
    stop,
  };
}
