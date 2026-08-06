import { normalizeRecordedStep } from "../core/recorded-flows.js";
import {
  assertConfirmedPageAgentClick,
  assertSafePageAgentInput,
} from "./page-agent-safety.js";

const DEFAULT_TARGET_TIMEOUT_MS = 10000;
const MAX_SEMANTIC_CANDIDATES = 5000;
const SEMANTIC_CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
  "form",
  "[role]",
  "[contenteditable='true']",
  "[data-action]",
  "[data-route]",
  "[data-href]",
].join(",");
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
  "[role=\"combobox\"]",
  "[aria-haspopup=\"listbox\"]",
].join(",");
const CUSTOM_SELECT_INTERACTION_SELECTOR = [
  ".ant-select-selector",
  ".ng-select-container",
  ".p-dropdown-trigger",
  ".p-select-dropdown",
  ".mat-mdc-select-trigger",
  ".mat-select-trigger",
  ".select2-selection",
  ".el-select__wrapper",
  ".vs__dropdown-toggle",
].join(",");
const CUSTOM_SELECT_OPTION_SELECTOR = [
  "[role=\"option\"]",
  "[role=\"menuitemradio\"]",
  "[data-value]",
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
  "[role=\"listbox\"]",
  "[role=\"menu\"]",
  ".ant-select-dropdown",
  ".ng-dropdown-panel",
  ".p-dropdown-panel",
  ".p-select-overlay",
  ".mat-mdc-select-panel",
  ".select2-results",
  ".el-select-dropdown",
  ".vs__dropdown-menu",
].join(",");

function compactText(value, limit = 1000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function comparableText(value) {
  return compactText(value, 1000).normalize("NFKC").toLocaleLowerCase();
}

function attributeSelectorValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isLikelyDynamicElementId(value) {
  const id = String(value || "");
  return /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(id)
    || /^(?:react-select|rc[_-]select|headlessui|radix|mui|ember|mat-input|generated)[-_:]/i.test(id)
    || /[-_:]\d{5,}$/.test(id);
}

function queryAll(root, selector) {
  try {
    return Array.from(root?.querySelectorAll?.(selector) || []);
  } catch {
    return [];
  }
}

function collectQueryRoots(documentObject) {
  const roots = [documentObject];
  const seen = new Set(roots);
  for (let index = 0; index < roots.length; index += 1) {
    for (const element of queryAll(roots[index], "*")) {
      if (element.shadowRoot && !seen.has(element.shadowRoot)) {
        seen.add(element.shadowRoot);
        roots.push(element.shadowRoot);
      }
    }
  }
  return roots;
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
  if (!force && !looksLikeFieldWidget(element)) return "";
  const controlText = compactText(element.innerText || element.textContent, 240);
  let depth = 0;
  for (let current = element.parentElement; current && depth < 4; current = current.parentElement) {
    depth += 1;
    const contextText = compactText(current.innerText || current.textContent, 240);
    if (!contextText || contextText.length > 160) continue;
    let label = contextText;
    if (controlText) {
      const index = label.toLocaleLowerCase().indexOf(controlText.toLocaleLowerCase());
      if (index < 0) continue;
      label = compactText(`${label.slice(0, index)} ${label.slice(index + controlText.length)}`, 240);
    }
    if (label && label !== controlText) return label;
  }
  return "";
}

function associatedLabel(element, { allowContextual = false } = {}) {
  const labels = Array.from(element?.labels || []);
  if (labels.length) return compactText(labels.map((label) => label.innerText || label.textContent).join(" "));
  const wrappingLabel = element?.closest?.("label");
  if (wrappingLabel) return compactText(wrappingLabel.innerText || wrappingLabel.textContent);
  const labelledBy = compactText(element?.getAttribute?.("aria-labelledby"));
  if (labelledBy) {
    const labelledText = compactText(labelledBy.split(/\s+/).map((id) => (
      element.ownerDocument?.getElementById?.(id)?.innerText
      || element.ownerDocument?.getElementById?.(id)?.textContent
      || ""
    )).join(" "));
    if (labelledText) return labelledText;
  }
  const id = element?.getAttribute?.("id") || element?.id;
  if (id) {
    const selector = `label[for="${attributeSelectorValue(id)}"]`;
    const explicitLabel = compactText(element.ownerDocument?.querySelector?.(selector)?.textContent);
    if (explicitLabel) return explicitLabel;
  }
  return contextualControlLabel(element, { force: allowContextual });
}

function accessibleName(element) {
  const labelledBy = compactText(element?.getAttribute?.("aria-labelledby"));
  const labelledText = labelledBy
    ? labelledBy.split(/\s+/).map((id) => (
      element.ownerDocument?.getElementById?.(id)?.textContent || ""
    )).join(" ")
    : "";
  return compactText(
    element?.getAttribute?.("aria-label")
    || labelledText
    || associatedLabel(element)
    || element?.getAttribute?.("title")
    || element?.getAttribute?.("alt")
    || element?.getAttribute?.("placeholder")
    || element?.innerText
    || element?.textContent
    || (["button", "submit", "reset"].includes(String(element?.type || "").toLowerCase())
      ? element?.value
      : ""),
  );
}

function elementDescriptor(element) {
  const tag = String(element?.tagName || "").toLowerCase();
  const dataAttributes = {};
  for (const attribute of Array.from(element?.attributes || [])) {
    if (/^data-[a-z0-9_.:-]+$/i.test(attribute?.name || "")) {
      dataAttributes[String(attribute.name).toLowerCase()] = compactText(attribute.value, 240);
    }
  }
  return {
    tag,
    type: compactText(element?.getAttribute?.("type") || element?.type, 60).toLowerCase(),
    role: compactText(element?.getAttribute?.("role"), 80).toLowerCase(),
    name: accessibleName(element),
    label: associatedLabel(element),
    text: ["input", "textarea", "select"].includes(tag)
      ? ""
      : compactText(element?.innerText || element?.textContent, 240),
    title: compactText(element?.getAttribute?.("title"), 240),
    controlValue: ["button", "submit", "reset"].includes(
      String(element?.type || element?.getAttribute?.("type") || "").toLowerCase(),
    ) ? compactText(element?.value, 240) : "",
    placeholder: compactText(element?.getAttribute?.("placeholder"), 240),
    testId: compactText(element?.getAttribute?.("data-testid"), 240),
    elementId: compactText(element?.getAttribute?.("id") || element?.id, 240),
    inputName: compactText(element?.getAttribute?.("name") || element?.name, 240),
    classNames: String(element?.getAttribute?.("class") || "")
      .split(/\s+/)
      .map((value) => compactText(value, 100))
      .filter(Boolean)
      .slice(0, 20),
    dataAttributes,
    href: compactText(element?.href || element?.getAttribute?.("href"), 1000),
  };
}

function scoreText(actual, expected, exactScore, partialScore = Math.floor(exactScore / 2)) {
  const normalizedExpected = comparableText(expected);
  if (!normalizedExpected) return 0;
  const normalizedActual = comparableText(actual);
  if (normalizedActual === normalizedExpected) return exactScore;
  if (
    normalizedActual.length >= 3
    && (normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual))
  ) return partialScore;
  return 0;
}

function scoreSemanticIdentity(target, descriptor) {
  let score = 0;
  if (target.role && descriptor.role === target.role) score += 35;
  score += scoreText(descriptor.name, target.name, 90, 45);
  score += scoreText(descriptor.label, target.label, 80, 40);
  score += scoreText(descriptor.placeholder, target.placeholder, 65, 30);
  score += scoreText(descriptor.text, target.text, 55, 25);
  score += scoreText(descriptor.title, target.title, 45, 20);
  score += scoreText(descriptor.controlValue, target.controlValue, 40, 20);
  return score;
}

function scoreAttributeIdentity(target, descriptor) {
  let score = 0;
  const expectedClasses = Array.isArray(target.classNames) ? target.classNames : [];
  const actualClasses = new Set(descriptor.classNames || []);
  score += Math.min(30, expectedClasses.filter((name) => actualClasses.has(name)).length * 6);
  for (const [name, value] of Object.entries(target.dataAttributes || {})) {
    if (descriptor.dataAttributes?.[name] === value) score += 35;
  }
  return score;
}

function elementPosition(element) {
  const siblings = Array.from(element?.parentElement?.children || []);
  const sameTagSiblings = siblings.filter((candidate) => candidate.tagName === element?.tagName);
  return {
    childIndex: siblings.indexOf(element),
    sameTagIndex: sameTagSiblings.indexOf(element),
  };
}

function scoreDomPathSegment(expected, element, depth = 0) {
  if (!expected || !element) return -40;
  const descriptor = elementDescriptor(element);
  let score = 0;
  if (expected.tag) score += descriptor.tag === expected.tag ? 24 : -50;
  if (expected.type) score += descriptor.type === expected.type ? 18 : -30;
  if (expected.role) score += descriptor.role === expected.role ? 22 : -20;
  if (expected.testId) score += descriptor.testId === expected.testId ? 120 : -45;
  if (expected.elementId) score += descriptor.elementId === expected.elementId ? 110 : -45;
  if (expected.inputName) score += descriptor.inputName === expected.inputName ? 65 : -25;
  score += Math.min(30, scoreAttributeIdentity(expected, descriptor));
  score += Math.min(45, scoreSemanticIdentity(expected, descriptor));
  const position = elementPosition(element);
  if (Number.isInteger(expected.sameTagIndex) && expected.sameTagIndex >= 0) {
    score += position.sameTagIndex === expected.sameTagIndex ? 12 : -4;
  }
  if (Number.isInteger(expected.childIndex) && expected.childIndex >= 0) {
    score += position.childIndex === expected.childIndex ? 8 : -3;
  }
  return Math.round(score * Math.max(0.35, 1 - depth * 0.08));
}

function scoreDomFingerprint(target, element) {
  const fingerprint = target?.domFingerprint;
  const expectedPath = Array.isArray(fingerprint?.path) ? fingerprint.path : [];
  if (!expectedPath.length || !element) return 0;
  const actualPath = [];
  for (let current = element; current && actualPath.length < 14; current = current.parentElement) {
    actualPath.push(current);
  }
  let score = scoreDomPathSegment(expectedPath[0], actualPath[0], 0);
  let minimumActualIndex = 1;
  for (let expectedIndex = 1; expectedIndex < expectedPath.length; expectedIndex += 1) {
    let bestScore = -40;
    let bestIndex = -1;
    for (
      let actualIndex = minimumActualIndex;
      actualIndex < Math.min(actualPath.length, minimumActualIndex + 4);
      actualIndex += 1
    ) {
      const candidateScore = scoreDomPathSegment(
        expectedPath[expectedIndex],
        actualPath[actualIndex],
        expectedIndex,
      ) - Math.max(0, actualIndex - minimumActualIndex) * 5;
      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        bestIndex = actualIndex;
      }
    }
    if (bestIndex >= 0 && bestScore > 0) {
      score += bestScore;
      minimumActualIndex = bestIndex + 1;
    }
  }
  const siblingPairs = [
    [fingerprint.previousSibling, element.previousElementSibling],
    [fingerprint.nextSibling, element.nextElementSibling],
  ];
  for (const [expectedSibling, actualSibling] of siblingPairs) {
    if (!expectedSibling) continue;
    score += Math.max(0, Math.min(45, scoreDomPathSegment(expectedSibling, actualSibling, 2)));
  }
  return Math.max(0, score);
}

function scoreTargetContext(expected, element) {
  if (!expected || !element) return 0;
  const descriptor = elementDescriptor(element);
  let score = scoreSemanticIdentity(expected, descriptor)
    + scoreAttributeIdentity(expected, descriptor);
  if (expected.testId && descriptor.testId === expected.testId) score += 140;
  if (expected.elementId && descriptor.elementId === expected.elementId) score += 130;
  if (expected.tag && descriptor.tag === expected.tag) score += 12;
  return score;
}

function scoreAncestorIdentity(target, element) {
  const expectedAncestors = Array.isArray(target.ancestors) ? target.ancestors : [];
  if (!expectedAncestors.length) return 0;
  const actualAncestors = [];
  for (let current = element?.parentElement; current && actualAncestors.length < 10; current = current.parentElement) {
    actualAncestors.push(current);
  }
  let total = 0;
  for (let expectedIndex = 0; expectedIndex < expectedAncestors.length; expectedIndex += 1) {
    let best = 0;
    for (let actualIndex = 0; actualIndex < actualAncestors.length; actualIndex += 1) {
      const contextScore = scoreTargetContext(
        expectedAncestors[expectedIndex],
        actualAncestors[actualIndex],
      ) - Math.abs(expectedIndex - actualIndex) * 5;
      best = Math.max(best, contextScore);
    }
    total += Math.min(70, best);
  }
  return Math.min(140, total);
}

function scoreRecordedOrdinal(target, element, descriptor) {
  if (!Number.isInteger(target.semanticOrdinal) || target.semanticOrdinal < 0) return 0;
  if (target.tag && descriptor.tag !== target.tag) return 0;
  if (target.type && descriptor.type !== target.type) return 0;
  const selector = target.type
    ? `${descriptor.tag}[type="${attributeSelectorValue(target.type)}"]`
    : descriptor.tag;
  const candidates = queryAll(element?.ownerDocument, selector)
    .filter((candidate) => comparableText(accessibleName(candidate)) === comparableText(target.name));
  const candidateIndex = candidates.indexOf(element);
  if (candidateIndex < 0) return 0;
  return candidateIndex === target.semanticOrdinal ? 35 : -10;
}

export function scoreRecordedTargetCandidate(target, element) {
  const descriptor = elementDescriptor(element);
  const semanticScore = scoreSemanticIdentity(target, descriptor);
  let score = 0;
  if (target.testId && descriptor.testId === target.testId) score += 140;
  if (
    target.elementId
    && descriptor.elementId === target.elementId
    && (
      !isLikelyDynamicElementId(target.elementId)
      || !hasSemanticIdentity(target)
      || semanticScore >= 35
    )
  ) score += 130;
  if (target.inputName && descriptor.inputName === target.inputName) score += 70;
  if (target.tag && descriptor.tag === target.tag) score += 18;
  if (target.type && descriptor.type === target.type) score += 18;
  if (target.href && descriptor.href === target.href) score += 45;
  score += semanticScore;
  score += scoreAttributeIdentity(target, descriptor);
  score += scoreAncestorIdentity(target, element);
  score += target.form ? Math.min(80, scoreTargetContext(
    target.form,
    element?.form || element?.closest?.("form"),
  )) : 0;
  score += scoreRecordedOrdinal(target, element, descriptor);
  score += Math.min(260, scoreDomFingerprint(target, element));
  return score;
}

function hasSemanticIdentity(target) {
  return Boolean(
    target.name
    || target.label
    || target.text
    || target.placeholder
    || target.role
    || target.inputName
    || target.title
    || target.controlValue,
  );
}

function candidateIsCompatible(target, element, strategy) {
  const descriptor = elementDescriptor(element);
  const semanticScore = scoreSemanticIdentity(target, descriptor);
  if (target.tag && descriptor.tag && target.tag !== descriptor.tag) return false;
  if (target.type && descriptor.type && target.type !== descriptor.type) return false;
  if (
    ["testId", "inputName", "origin"].includes(strategy)
    || strategy.startsWith("data:")
  ) return true;
  if (strategy === "elementId") {
    return !isLikelyDynamicElementId(target.elementId)
      || !hasSemanticIdentity(target)
      || semanticScore >= 35;
  }
  if (strategy === "domFingerprint") {
    if (scoreDomFingerprint(target, element) < 55) return false;
    return !hasSemanticIdentity(target) || semanticScore >= 25;
  }
  if (strategy === "selector" && hasSemanticIdentity(target)) return semanticScore >= 35;
  if (!hasSemanticIdentity(target)) return true;
  return semanticScore >= 35;
}

function addCandidates(candidateMap, elements, strategy, priority, target) {
  for (const element of elements) {
    if (!element || !candidateIsCompatible(target, element, strategy)) continue;
    const previous = candidateMap.get(element);
    const entry = {
      element,
      priority,
      score: scoreRecordedTargetCandidate(target, element),
      strategy,
    };
    if (
      !previous
      || entry.priority > previous.priority
      || entry.priority === previous.priority && entry.score > previous.score
    ) candidateMap.set(element, entry);
  }
}

function queryRecordedContext(context, queryRoots) {
  if (!context) return [];
  const elements = [];
  const add = (matches) => {
    for (const element of matches) {
      if (element && !elements.includes(element)) elements.push(element);
    }
  };
  if (context.testId) {
    add(queryRoots(`[data-testid="${attributeSelectorValue(context.testId)}"]`));
  }
  if (context.elementId) {
    add(queryRoots(`[id="${attributeSelectorValue(context.elementId)}"]`));
  }
  for (const [name, value] of Object.entries(context.dataAttributes || {})) {
    add(queryRoots(`[${name}="${attributeSelectorValue(value)}"]`));
  }
  if (context.selector) add(queryRoots(context.selector));
  return elements;
}

function recordedControlFromOrigin(origin, target) {
  for (let current = origin; current; current = current.parentElement) {
    const descriptor = elementDescriptor(current);
    if (target.tag && descriptor.tag !== target.tag) continue;
    if (target.type && descriptor.type && descriptor.type !== target.type) continue;
    return current;
  }
  return null;
}

function rankRecordedTargetCandidates(rawTarget, {
  documentObject = document,
  includeSemantic = true,
  includeShadowRoots = true,
} = {}) {
  const target = rawTarget && typeof rawTarget === "object" ? rawTarget : {};
  const roots = includeShadowRoots ? collectQueryRoots(documentObject) : [documentObject];
  const candidates = new Map();
  const queryRoots = (selector) => roots.flatMap((root) => queryAll(root, selector));

  if (target.testId) {
    addCandidates(
      candidates,
      queryRoots(`[data-testid="${attributeSelectorValue(target.testId)}"]`),
      "testId",
      500,
      target,
    );
  }
  if (target.elementId) {
    addCandidates(
      candidates,
      queryRoots(`[id="${attributeSelectorValue(target.elementId)}"]`),
      "elementId",
      450,
      target,
    );
  }
  if (target.inputName) {
    const tag = /^[a-z][a-z0-9-]*$/i.test(target.tag || "") ? target.tag : "";
    addCandidates(
      candidates,
      queryRoots(`${tag}[name="${attributeSelectorValue(target.inputName)}"]`),
      "inputName",
      350,
      target,
    );
  }
  for (const [name, value] of Object.entries(target.dataAttributes || {})) {
    addCandidates(
      candidates,
      queryRoots(`[${name}="${attributeSelectorValue(value)}"]`),
      `data:${name}`,
      425,
      target,
    );
  }
  const selectors = [...new Set([
    ...(Array.isArray(target.selectors) ? target.selectors : []),
    target.selector,
  ].filter(Boolean))];
  for (let index = 0; index < selectors.length; index += 1) {
    addCandidates(
      candidates,
      queryRoots(selectors[index]),
      "selector",
      Math.max(260, 330 - index * 5),
      target,
    );
  }
  if (target.origin) {
    addCandidates(
      candidates,
      queryRecordedContext(target.origin, queryRoots)
        .map((origin) => recordedControlFromOrigin(origin, target))
        .filter(Boolean),
      "origin",
      440,
      target,
    );
  }
  const recordedDomTarget = target.domFingerprint?.path?.[0];
  if (recordedDomTarget) {
    const tag = /^[a-z][a-z0-9-]*$/i.test(recordedDomTarget.tag || "")
      ? recordedDomTarget.tag
      : "*";
    const selectors = [];
    if (recordedDomTarget.testId) {
      selectors.push(`[data-testid="${attributeSelectorValue(recordedDomTarget.testId)}"]`);
    }
    if (recordedDomTarget.elementId) {
      selectors.push(`[id="${attributeSelectorValue(recordedDomTarget.elementId)}"]`);
    }
    if (recordedDomTarget.inputName) {
      selectors.push(`${tag}[name="${attributeSelectorValue(recordedDomTarget.inputName)}"]`);
    }
    const fingerprintClasses = Array.isArray(recordedDomTarget.classNames)
      ? recordedDomTarget.classNames.slice(0, 3)
      : [];
    if (fingerprintClasses.length) {
      selectors.push(`${tag}.${fingerprintClasses.map((name) => (
        globalThis.CSS?.escape?.(name)
        || String(name).replace(/[^a-zA-Z0-9_-]/g, "\\$&")
      )).join(".")}`);
    }
    if (!selectors.length) selectors.push(tag);
    addCandidates(
      candidates,
      [...new Set(selectors)].flatMap(queryRoots),
      "domFingerprint",
      300,
      target,
    );
  }
  if (includeSemantic) {
    addCandidates(
      candidates,
      queryRoots(SEMANTIC_CONTROL_SELECTOR).slice(0, MAX_SEMANTIC_CANDIDATES),
      "semantic",
      0,
      target,
    );
  }

  return [...candidates.values()].sort((left, right) => (
    right.priority - left.priority
    || right.score - left.score
  ));
}

export function findRecordedTarget(rawTarget, { documentObject = document } = {}) {
  const ranked = rankRecordedTargetCandidates(rawTarget, { documentObject });
  const match = ranked.find((candidate) => (
    candidateMatchesRecordedIdentity(rawTarget, candidate)
  ));
  if (!match || match.priority === 0 && match.score < 35) return null;
  return {
    candidateCount: ranked.length,
    element: match.element,
    score: match.score,
    strategy: match.strategy,
  };
}

function isElementVisible(element, windowObject) {
  if (!element?.isConnected) return false;
  const style = windowObject.getComputedStyle?.(element);
  if (
    style?.display === "none"
    || style?.visibility === "hidden"
    || style?.visibility === "collapse"
    || style?.opacity === "0"
    || style?.pointerEvents === "none"
  ) return false;
  const rect = element.getBoundingClientRect?.();
  return !rect || rect.width > 0 && rect.height > 0;
}

function disabledStateValue(element, attribute) {
  const value = element?.getAttribute?.(attribute);
  return value !== null && String(value).toLowerCase() !== "false";
}

function isElementEnabled(element, windowObject) {
  if (!element) return false;
  for (let current = element; current; current = current.parentElement) {
    const classList = current.classList;
    const style = windowObject?.getComputedStyle?.(current);
    if (
      current.disabled === true
      || current.inert === true
      || current.matches?.(":disabled") === true
      || current.hasAttribute?.("disabled") === true
      || current.getAttribute?.("aria-disabled") === "true"
      || disabledStateValue(current, "data-disabled")
      || current.getAttribute?.("data-state") === "disabled"
      || classList?.contains?.("disabled")
      || classList?.contains?.("is-disabled")
      || style?.pointerEvents === "none"
    ) return false;
  }
  return true;
}

function rectSignature(element) {
  const rect = element.getBoundingClientRect?.();
  if (!rect) return "";
  return [rect.x, rect.y, rect.width, rect.height]
    .map((value) => Math.round(Number(value) * 10) / 10)
    .join(":");
}

function nextFrame(windowObject) {
  return new Promise((resolve) => {
    if (typeof windowObject.requestAnimationFrame === "function") {
      windowObject.requestAnimationFrame(() => resolve());
    } else {
      windowObject.setTimeout(resolve, 16);
    }
  });
}

function assertReplayActive(signal) {
  if (signal?.aborted) {
    throw new DOMException("The recorded flow was cancelled by the user.", "AbortError");
  }
}

async function waitUntilStable(element, windowObject) {
  const before = rectSignature(element);
  await nextFrame(windowObject);
  return before === rectSignature(element);
}

function eligibleRecordedTargetCandidates(ranked) {
  return ranked.filter((candidate) => candidate.priority > 0 || candidate.score >= 35);
}

function customSelectSemanticTrigger(element) {
  if (matchesSelector(element, CUSTOM_SELECT_TRIGGER_SELECTOR)) return element;
  const componentRoot = element?.closest?.(CUSTOM_SELECT_ROOT_SELECTOR) || element;
  return queryAll(componentRoot, CUSTOM_SELECT_TRIGGER_SELECTOR)[0] || null;
}

function customSelectInteractionSurface(element, windowObject) {
  const tag = String(element?.tagName || "").toLowerCase();
  const role = comparableText(element?.getAttribute?.("role"));
  if (tag === "select" || ["listbox", "menu"].includes(role)) return element;
  const componentRoot = element?.closest?.(CUSTOM_SELECT_ROOT_SELECTOR) || null;
  const candidates = [];
  const add = (candidate) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  if (componentRoot) {
    for (const candidate of queryAll(componentRoot, CUSTOM_SELECT_INTERACTION_SELECTOR)) add(candidate);
    add(componentRoot);
  }
  add(element);
  return candidates.find((candidate) => (
    isElementVisible(candidate, windowObject)
    && isElementEnabled(candidate, windowObject)
  )) || null;
}

function firstUsableRecordedTargetCandidate(candidates, windowObject, action = "") {
  for (const candidate of candidates) {
    const interactionElement = action === "select_option"
      ? customSelectInteractionSurface(candidate.element, windowObject)
      : candidate.element;
    if (
      interactionElement
      && isElementVisible(interactionElement, windowObject)
      && isElementEnabled(interactionElement, windowObject)
    ) return { ...candidate, interactionElement };
  }
  return null;
}

function candidateHasStrongRecordedLocator(target, candidate) {
  if (["testId", "inputName", "origin"].includes(candidate.strategy)) return true;
  if (candidate.strategy?.startsWith("data:")) return true;
  if (candidate.strategy === "domFingerprint") {
    return scoreDomFingerprint(target, candidate.element) >= 110;
  }
  return candidate.strategy === "elementId"
    && target.elementId
    && !isLikelyDynamicElementId(target.elementId);
}

function semanticIdentityMatches(target, candidate) {
  const descriptor = elementDescriptor(candidate.element);
  const fields = ["name", "label", "text", "placeholder", "title", "controlValue"];
  let compared = false;
  for (const field of fields) {
    if (!target?.[field] || !descriptor[field]) continue;
    compared = true;
    if (scoreText(descriptor[field], target[field], 1, 1) > 0) return true;
  }
  return !compared;
}

function candidateMatchesRecordedIdentity(target, candidate, action = "") {
  if (candidateHasStrongRecordedLocator(target, candidate)) return true;
  const fieldAction = ["fill", "select_option", "set_checked"].includes(action);
  const fieldLike = ["input", "select", "textarea"].includes(target.tag)
    || [
      "checkbox",
      "combobox",
      "listbox",
      "radio",
      "searchbox",
      "slider",
      "spinbutton",
      "switch",
      "textbox",
    ].includes(target.role);
  if ((fieldAction || fieldLike) && target?.label) {
    const actualLabel = associatedLabel(candidate.element, { allowContextual: fieldAction });
    if (scoreText(actualLabel, target.label, 1, 1) > 0) return true;
    return semanticIdentityMatches(target, candidate);
  }
  return semanticIdentityMatches(target, candidate);
}

function dispatchRecordedHover(element, windowObject) {
  if (!element) return false;
  element.scrollIntoView?.({ block: "center", inline: "nearest" });
  const path = [];
  for (let current = element; current; current = current.parentElement) path.unshift(current);
  const eventOptions = { bubbles: true, cancelable: true, pointerType: "mouse" };
  for (const current of path) {
    const PointerEventClass = windowObject.PointerEvent || windowObject.MouseEvent || windowObject.Event;
    const MouseEventClass = windowObject.MouseEvent || windowObject.Event;
    current.dispatchEvent?.(new PointerEventClass("pointerover", eventOptions));
    current.dispatchEvent?.(new MouseEventClass("mouseover", eventOptions));
    current.dispatchEvent?.(new MouseEventClass("mouseenter", { ...eventOptions, bubbles: false }));
  }
  element.focus?.({ preventScroll: true });
  return true;
}

export function revealRecordedTarget(rawTarget, {
  documentObject = document,
  windowObject = window,
} = {}) {
  const hoverTarget = rawTarget?.hoverTarget;
  if (!hoverTarget) return false;
  const hoverMatch = findRecordedTarget(hoverTarget, { documentObject });
  return hoverMatch ? dispatchRecordedHover(hoverMatch.element, windowObject) : false;
}

export async function waitForRecordedTarget(rawTarget, {
  action = "",
  documentObject = document,
  signal,
  windowObject = window,
  timeoutMs = DEFAULT_TARGET_TIMEOUT_MS,
} = {}) {
  const maximumWait = Math.min(30000, Math.max(500, Number(timeoutMs) || DEFAULT_TARGET_TIMEOUT_MS));
  const startedAt = Date.now();
  let lastMatch = null;
  let lastFallbackAt = -Infinity;
  let lastRevealAt = -Infinity;
  while (Date.now() - startedAt <= maximumWait) {
    assertReplayActive(signal);
    const elapsedMs = Date.now() - startedAt;
    if (rawTarget?.hoverTarget && elapsedMs - lastRevealAt >= 250) {
      lastRevealAt = elapsedMs;
      if (revealRecordedTarget(rawTarget, { documentObject, windowObject })) {
        await nextFrame(windowObject);
        assertReplayActive(signal);
      }
    }
    const fastCandidates = eligibleRecordedTargetCandidates(rankRecordedTargetCandidates(
      rawTarget,
      {
        documentObject,
        includeSemantic: false,
        includeShadowRoots: false,
      },
    ));
    let eligible = fastCandidates.filter((candidate) => (
      candidateMatchesRecordedIdentity(rawTarget, candidate, action)
    ));
    let match = firstUsableRecordedTargetCandidate(eligible, windowObject, action);
    const exactLocatorMatched = eligible.some((candidate) => candidate.priority > 0);
    // Exact locators in the light DOM cover the common recorded-flow path without
    // walking every element. Shadow-root and semantic recovery stay available, but
    // are throttled because both require a full DOM scan. Once an exact compatible
    // target is present, keep waiting on that target instead of clicking a different
    // enabled control merely because the intended one is disabled.
    if (!match && !exactLocatorMatched && elapsedMs - lastFallbackAt >= 250) {
      lastFallbackAt = elapsedMs;
      eligible = eligibleRecordedTargetCandidates(rankRecordedTargetCandidates(
        rawTarget,
        { documentObject },
      )).filter((candidate) => candidateMatchesRecordedIdentity(rawTarget, candidate, action));
      match = firstUsableRecordedTargetCandidate(eligible, windowObject, action);
    }
    if (match) {
      lastMatch = match;
      const interactionElement = match.interactionElement || match.element;
      if (
        await waitUntilStable(interactionElement, windowObject)
        && isElementVisible(interactionElement, windowObject)
        && isElementEnabled(interactionElement, windowObject)
      ) {
        return { ...match, waitedMs: Date.now() - startedAt };
      }
    } else if (rawTarget?.hoverTarget && elapsedMs >= 500) {
      const exactHiddenMatch = eligible.find((candidate) => (
        candidate.priority > 0
        && candidate.element?.isConnected
        && isElementEnabled(candidate.element, windowObject)
      ));
      if (exactHiddenMatch && await waitUntilStable(exactHiddenMatch.element, windowObject)) {
        return {
          ...exactHiddenMatch,
          hoverFallback: true,
          waitedMs: Date.now() - startedAt,
        };
      }
    } else if (eligible.length) {
      [lastMatch] = eligible;
    }
    await new Promise((resolve) => windowObject.setTimeout(resolve, 50));
  }
  assertReplayActive(signal);
  const detail = lastMatch
    ? "The recorded target was found but did not become visible, enabled, and stable."
    : "No matching element appeared.";
  throw new Error(`${detail} Direct replay waited ${Math.round(maximumWait / 1000)} seconds.`);
}

function dispatchValueEvents(element, windowObject) {
  element.dispatchEvent(new windowObject.Event("input", { bubbles: true }));
  element.dispatchEvent(new windowObject.Event("change", { bubbles: true }));
}

function setNativeProperty(element, property, value) {
  let prototype = element;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor?.set) {
      descriptor.set.call(element, value);
      return;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  element[property] = value;
}

function fillElement(element, value, windowObject) {
  const requestedValue = String(value ?? "");
  assertSafePageAgentInput(element);
  element.focus?.({ preventScroll: true });
  if (element.isContentEditable) {
    element.textContent = requestedValue;
  } else {
    setNativeProperty(element, "value", requestedValue);
  }
  dispatchValueEvents(element, windowObject);
  const actualValue = element.isContentEditable
    ? String(element.textContent ?? "")
    : String(element.value ?? "");
  if (actualValue !== requestedValue) {
    throw new Error("The recorded field rejected the saved value.");
  }
}

function matchesSelector(element, selector) {
  try {
    return element?.matches?.(selector) === true;
  } catch {
    return false;
  }
}

function customSelectLiveTrigger(element) {
  return customSelectSemanticTrigger(element) || element;
}

function customSelectPopupRoots(trigger, documentObject, windowObject) {
  const roots = [];
  const add = (element) => {
    if (element && !roots.includes(element)) roots.push(element);
  };
  for (const attribute of ["aria-controls", "aria-owns"]) {
    const ids = compactText(trigger?.getAttribute?.(attribute), 1000).split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const linked = documentObject?.getElementById?.(id);
      add(linked);
      add(linked?.closest?.(CUSTOM_SELECT_POPUP_SELECTOR));
      add(linked?.parentElement?.closest?.(CUSTOM_SELECT_POPUP_SELECTOR));
    }
  }
  // Prefer the popup explicitly owned by this combobox. Looking through every
  // open popup first can select an identical option from another field.
  if (!roots.length) {
    for (const popup of queryAll(documentObject, CUSTOM_SELECT_POPUP_SELECTOR)) {
      if (isElementVisible(popup, windowObject)) add(popup);
    }
  }
  return roots;
}

function customSelectIsOpen(trigger, documentObject, windowObject) {
  if (trigger?.getAttribute?.("aria-expanded") === "true") return true;
  return customSelectPopupRoots(trigger, documentObject, windowObject)
    .some((root) => isElementVisible(root, windowObject));
}

async function openCustomSelect(
  interactionElement,
  semanticTrigger,
  documentObject,
  windowObject,
) {
  if (customSelectIsOpen(semanticTrigger, documentObject, windowObject)) return;
  interactionElement.focus?.({ preventScroll: true });
  clickElement(interactionElement, windowObject);
  await nextFrame(windowObject);
  await nextFrame(windowObject);
  if (customSelectIsOpen(semanticTrigger, documentObject, windowObject)) return;

  // Keyboard opening is the semantic fallback used by accessible comboboxes.
  // It stays entirely inside deterministic replay and never invokes the agent.
  const KeyboardEventClass = windowObject.KeyboardEvent;
  if (typeof KeyboardEventClass !== "function") return;
  semanticTrigger.focus?.({ preventScroll: true });
  const options = {
    bubbles: true,
    cancelable: true,
    code: "ArrowDown",
    key: "ArrowDown",
    keyCode: 40,
    which: 40,
  };
  semanticTrigger.dispatchEvent?.(new KeyboardEventClass("keydown", options));
  semanticTrigger.dispatchEvent?.(new KeyboardEventClass("keyup", options));
  await nextFrame(windowObject);
  await nextFrame(windowObject);
}

function customSelectOptionIdentities(element) {
  return [
    element?.getAttribute?.("data-value"),
    element?.getAttribute?.("value"),
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("title"),
    element?.innerText,
    element?.textContent,
  ].map(comparableText).filter(Boolean);
}

function recordedSelectIdentities(step) {
  const texts = (step.optionTexts?.length ? step.optionTexts : [step.optionText])
    .map(comparableText)
    .filter(Boolean);
  const values = (step.values?.length ? step.values : [step.value])
    .map(comparableText)
    .filter(Boolean);
  return {
    all: new Set([...texts, ...values]),
    texts: new Set(texts),
    values: new Set(values),
  };
}

function optionMatchesRecordedSelection(element, identities) {
  return customSelectOptionIdentities(element).some((identity) => identities.all.has(identity));
}

function scoreRecordedSelectOption(element, optionTarget, linkedRoot) {
  const descriptor = elementDescriptor(element);
  let score = linkedRoot ? 100 : 0;
  if (descriptor.role === "option") score += 30;
  if (element.hasAttribute?.("data-value")) score += 35;
  if (optionTarget?.testId && descriptor.testId === optionTarget.testId) score += 120;
  if (
    optionTarget?.elementId
    && descriptor.elementId === optionTarget.elementId
    && !isLikelyDynamicElementId(optionTarget.elementId)
  ) score += 110;
  if (optionTarget?.tag && descriptor.tag === optionTarget.tag) score += 10;
  score += Math.min(35, scoreAttributeIdentity(optionTarget || {}, descriptor));
  return score;
}

async function waitForRecordedSelectOption(step, trigger, {
  documentObject,
  signal,
  timeoutMs,
  windowObject,
}) {
  const maximumWait = Math.min(30000, Math.max(500, Number(timeoutMs) || DEFAULT_TARGET_TIMEOUT_MS));
  const startedAt = Date.now();
  const identities = recordedSelectIdentities(step);
  const optionTarget = step.optionTarget || {};
  while (Date.now() - startedAt <= maximumWait) {
    assertReplayActive(signal);
    const linkedRoots = customSelectPopupRoots(trigger, documentObject, windowObject);
    const candidates = new Map();
    const collect = (root, linkedRoot) => {
      const elements = [
        ...(matchesSelector(root, CUSTOM_SELECT_OPTION_SELECTOR) ? [root] : []),
        ...queryAll(root, CUSTOM_SELECT_OPTION_SELECTOR),
      ];
      for (const element of elements) {
        if (!optionMatchesRecordedSelection(element, identities)) continue;
        const score = scoreRecordedSelectOption(element, optionTarget, linkedRoot);
        if (score > (candidates.get(element) ?? -Infinity)) candidates.set(element, score);
      }
    };
    for (const root of linkedRoots) collect(root, true);
    collect(documentObject, false);
    const matches = [...candidates.entries()]
      .map(([element, score]) => ({ element, score }))
      .filter(({ element }) => (
        isElementVisible(element, windowObject)
        && isElementEnabled(element, windowObject)
        && element.getAttribute?.("aria-disabled") !== "true"
      ))
      .sort((left, right) => right.score - left.score);
    if (matches[0]) {
      if (await waitUntilStable(matches[0].element, windowObject)) return matches[0].element;
    }
    await new Promise((resolve) => windowObject.setTimeout(resolve, 40));
  }
  const description = [...identities.texts][0] || [...identities.values][0] || "saved option";
  throw new Error(`The recorded option “${description}” is not available in the current combobox.`);
}

function customSelectCurrentValues(element, trigger) {
  const selectionSurface = trigger.closest?.(CUSTOM_SELECT_ROOT_SELECTOR)
    || element.closest?.(CUSTOM_SELECT_ROOT_SELECTOR)
    || element;
  return [
    trigger.value,
    trigger.getAttribute?.("aria-valuetext"),
    selectionSurface.value,
    selectionSurface.getAttribute?.("aria-valuetext"),
    ...queryAll(selectionSurface, [
      "[aria-selected='true']",
      ".ant-select-selection-item",
      ".ng-value-label",
      ".p-dropdown-label",
      ".p-select-label",
      ".select2-selection__rendered",
      ".el-select__selected-item",
      ".vs__selected",
    ].join(",")).map((candidate) => candidate.innerText || candidate.textContent),
    ...String(selectionSurface.innerText || selectionSurface.textContent || "").split(/\r?\n/),
  ].map(comparableText).filter(Boolean);
}

async function selectOption(
  element,
  step,
  windowObject,
  documentObject,
  timeoutMs,
  signal,
  recordedInteractionElement = null,
) {
  assertReplayActive(signal);
  if (String(element.tagName || "").toLowerCase() === "select") {
    const requestedValues = new Set(
      (step.values?.length ? step.values : [step.value])
        .map((value) => String(value ?? "")),
    );
    const requestedTexts = new Set(
      (step.optionTexts?.length ? step.optionTexts : [step.optionText])
        .map(comparableText)
        .filter(Boolean),
    );
    const options = Array.from(element.options || []);
    const matchingOptions = options.filter((candidate) => (
      requestedValues.has(String(candidate.value))
      || requestedTexts.has(comparableText(candidate.textContent))
    ));
    if (!matchingOptions.length) throw new Error("The recorded option is no longer available.");
    if (element.multiple) {
      const matching = new Set(matchingOptions);
      for (const option of options) setNativeProperty(option, "selected", matching.has(option));
    } else {
      setNativeProperty(element, "value", matchingOptions[0].value);
    }
    dispatchValueEvents(element, windowObject);
    const actualValues = new Set(Array.from(element.selectedOptions || [], (option) => String(option.value)));
    if (!matchingOptions.every((option) => actualValues.has(String(option.value)))) {
      throw new Error("The recorded select control rejected the saved option.");
    }
    return;
  }

  const trigger = customSelectLiveTrigger(element);
  const interactionElement = recordedInteractionElement
    || customSelectInteractionSurface(element, windowObject)
    || element;
  const triggerRole = comparableText(element.getAttribute?.("role"));
  if (!["listbox", "menu"].includes(triggerRole)) {
    await openCustomSelect(interactionElement, trigger, documentObject, windowObject);
  }
  const optionText = step.optionTexts?.[0] || step.optionText || step.values?.[0] || step.value || "";
  const option = await waitForRecordedSelectOption(step, trigger, {
    documentObject,
    signal,
    timeoutMs,
    windowObject,
  });
  clickElement(option, windowObject);
  const expected = recordedSelectIdentities(step).all;
  if (!expected.size) return;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    assertReplayActive(signal);
    if (customSelectCurrentValues(element, trigger).some((value) => expected.has(value))) return;
    await new Promise((resolve) => windowObject.setTimeout(resolve, 50));
  }
  assertReplayActive(signal);
  throw new Error(`The recorded option “${optionText}” was clicked but did not become selected.`);
}

async function setChecked(element, desired, windowObject) {
  const stateAttribute = element.hasAttribute?.("aria-checked")
    ? "aria-checked"
    : element.hasAttribute?.("aria-pressed") ? "aria-pressed" : "";
  const currentState = stateAttribute
    ? element.getAttribute(stateAttribute) === "true"
    : "checked" in element ? Boolean(element.checked) : null;
  if (currentState === null) {
    throw new Error("The recorded target is no longer a checkbox, radio, switch, or toggle control.");
  }
  if (currentState === desired) return;
  const inputType = String(element.type || element.getAttribute?.("type") || "").toLowerCase();
  if (stateAttribute || (inputType === "checkbox" || desired) && typeof element.click === "function") {
    clickElement(element, windowObject);
    if (stateAttribute) await nextFrame(windowObject);
  } else {
    setNativeProperty(element, "checked", desired);
    dispatchValueEvents(element, windowObject);
  }
  const resultingState = stateAttribute
    ? element.getAttribute(stateAttribute) === "true"
    : Boolean(element.checked);
  if (resultingState !== desired) {
    throw new Error(`The recorded control could not be ${desired ? "checked" : "unchecked"}.`);
  }
}

function clickElement(element, windowObject, modifiers = {}) {
  const rect = element.getBoundingClientRect?.() || {
    height: 0,
    left: 0,
    top: 0,
    width: 0,
  };
  const eventOptions = {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: (rect.left ?? rect.x ?? 0) + rect.width / 2,
    clientY: (rect.top ?? rect.y ?? 0) + rect.height / 2,
    pointerType: "mouse",
    altKey: modifiers.alt === true,
    ctrlKey: modifiers.ctrl === true,
    metaKey: modifiers.meta === true,
    shiftKey: modifiers.shift === true,
  };
  const PointerEventClass = windowObject.PointerEvent || windowObject.MouseEvent;
  if (PointerEventClass) {
    element.dispatchEvent(new PointerEventClass("pointerover", eventOptions));
    element.dispatchEvent(new PointerEventClass("pointerdown", eventOptions));
  }
  if (windowObject.MouseEvent) {
    element.dispatchEvent(new windowObject.MouseEvent("mouseover", eventOptions));
    element.dispatchEvent(new windowObject.MouseEvent("mousedown", eventOptions));
  }
  if (PointerEventClass) {
    element.dispatchEvent(new PointerEventClass("pointerup", eventOptions));
  }
  if (windowObject.MouseEvent) {
    element.dispatchEvent(new windowObject.MouseEvent("mouseup", eventOptions));
  }
  const hasModifiers = Object.values(modifiers).some(Boolean);
  if (hasModifiers && windowObject.MouseEvent) {
    element.dispatchEvent(new windowObject.MouseEvent("click", eventOptions));
  } else {
    element.click();
  }
}

function contextClickElement(element, windowObject, modifiers = {}) {
  const rect = element.getBoundingClientRect?.() || { height: 0, left: 0, top: 0, width: 0 };
  element.dispatchEvent(new windowObject.MouseEvent("contextmenu", {
    altKey: modifiers.alt === true,
    bubbles: true,
    button: 2,
    buttons: 2,
    cancelable: true,
    clientX: (rect.left ?? rect.x ?? 0) + rect.width / 2,
    clientY: (rect.top ?? rect.y ?? 0) + rect.height / 2,
    ctrlKey: modifiers.ctrl === true,
    metaKey: modifiers.meta === true,
    shiftKey: modifiers.shift === true,
  }));
}

function dragElement(source, destination, windowObject) {
  const dataTransfer = typeof windowObject.DataTransfer === "function"
    ? new windowObject.DataTransfer()
    : undefined;
  const DragEventClass = windowObject.DragEvent || windowObject.Event;
  const dispatch = (element, type) => element.dispatchEvent(new DragEventClass(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer,
  }));
  dispatch(source, "dragstart");
  dispatch(destination, "dragenter");
  dispatch(destination, "dragover");
  dispatch(destination, "drop");
  dispatch(source, "dragend");
}

export async function executeRecordedFlowStep(rawStep, {
  confirmed = false,
  documentObject = document,
  signal,
  windowObject = window,
  timeoutMs = DEFAULT_TARGET_TIMEOUT_MS,
} = {}) {
  assertReplayActive(signal);
  const step = normalizeRecordedStep(rawStep);
  if (!step || step.action === "agent_group") {
    throw new Error("Direct replay received an invalid recorded action.");
  }
  if (step.redacted) throw new Error("Direct replay cannot enter a redacted value.");
  if (step.action === "navigate") {
    const url = String(step.value || step.url || "").trim();
    if (!url) throw new Error("The recorded navigation URL is missing.");
    windowObject.location.assign(url);
    return { action: step.action, navigated: true, success: true, url };
  }

  const match = await waitForRecordedTarget(step.target, {
    action: step.action,
    documentObject,
    signal,
    timeoutMs,
    windowObject,
  });
  const { element } = match;
  assertReplayActive(signal);
  if (["click", "context_click", "double_click"].includes(step.action)) {
    if (!isElementEnabled(element, windowObject)) {
      throw new Error("The recorded click target became disabled before the action could run.");
    }
    assertConfirmedPageAgentClick(element, confirmed);
    element.focus?.({ preventScroll: true });
    if (step.action === "context_click") {
      contextClickElement(element, windowObject, step.modifiers);
    } else if (step.action === "double_click") {
      clickElement(element, windowObject, step.modifiers);
      clickElement(element, windowObject, step.modifiers);
      element.dispatchEvent(new windowObject.MouseEvent("dblclick", {
        bubbles: true,
        button: 0,
        cancelable: true,
        detail: 2,
      }));
    } else {
      clickElement(element, windowObject, step.modifiers);
    }
  } else if (step.action === "fill") {
    fillElement(element, step.value, windowObject);
  } else if (step.action === "select_option") {
    await selectOption(
      element,
      step,
      windowObject,
      documentObject,
      timeoutMs,
      signal,
      match.interactionElement,
    );
  } else if (step.action === "set_checked") {
    await setChecked(element, Boolean(step.value), windowObject);
  } else if (step.action === "drag_drop") {
    const destination = await waitForRecordedTarget(step.destinationTarget, {
      documentObject,
      signal,
      timeoutMs,
      windowObject,
    });
    dragElement(element, destination.element, windowObject);
  } else if (step.action === "submit") {
    const form = String(element.tagName || "").toLowerCase() === "form"
      ? element
      : element.form || element.closest?.("form");
    if (!form) throw new Error("The recorded submit target is no longer inside a form.");
    form.requestSubmit?.();
    if (typeof form.requestSubmit !== "function") form.submit?.();
  } else if (step.action === "upload_file") {
    throw new Error("Recorded file uploads must be replayed by the extension background service.");
  } else {
    throw new Error(`Direct replay does not support the recorded ${step.action} action.`);
  }

  return {
    action: step.action,
    candidateCount: match.candidateCount,
    locatorStrategy: match.strategy,
    score: match.score,
    success: true,
    hoverFallback: match.hoverFallback === true,
    waitedMs: match.waitedMs,
  };
}
