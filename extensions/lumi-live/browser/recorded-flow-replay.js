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
    || /^(?:react-select|headlessui|radix|mui|ember|mat-input|generated)[-_:]/i.test(id)
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

function associatedLabel(element) {
  const labels = Array.from(element?.labels || []);
  if (labels.length) return compactText(labels.map((label) => label.innerText || label.textContent).join(" "));
  const wrappingLabel = element?.closest?.("label");
  if (wrappingLabel) return compactText(wrappingLabel.innerText || wrappingLabel.textContent);
  const id = element?.getAttribute?.("id") || element?.id;
  if (!id) return "";
  const selector = `label[for="${attributeSelectorValue(id)}"]`;
  return compactText(element.ownerDocument?.querySelector?.(selector)?.textContent);
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
  const match = ranked[0];
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

async function waitUntilStable(element, windowObject) {
  const before = rectSignature(element);
  await nextFrame(windowObject);
  return before === rectSignature(element);
}

function eligibleRecordedTargetCandidates(ranked) {
  return ranked.filter((candidate) => candidate.priority > 0 || candidate.score >= 35);
}

function firstUsableRecordedTargetCandidate(candidates, windowObject) {
  return candidates.find((candidate) => (
    isElementVisible(candidate.element, windowObject)
    && isElementEnabled(candidate.element, windowObject)
  )) || null;
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
  documentObject = document,
  windowObject = window,
  timeoutMs = DEFAULT_TARGET_TIMEOUT_MS,
} = {}) {
  const maximumWait = Math.min(30000, Math.max(500, Number(timeoutMs) || DEFAULT_TARGET_TIMEOUT_MS));
  const startedAt = Date.now();
  let lastMatch = null;
  let lastFallbackAt = -Infinity;
  let lastRevealAt = -Infinity;
  while (Date.now() - startedAt <= maximumWait) {
    const elapsedMs = Date.now() - startedAt;
    if (rawTarget?.hoverTarget && elapsedMs - lastRevealAt >= 250) {
      lastRevealAt = elapsedMs;
      if (revealRecordedTarget(rawTarget, { documentObject, windowObject })) {
        await nextFrame(windowObject);
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
    let eligible = fastCandidates;
    let match = firstUsableRecordedTargetCandidate(fastCandidates, windowObject);
    const exactLocatorMatched = fastCandidates.some((candidate) => candidate.priority > 0);
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
      ));
      match = firstUsableRecordedTargetCandidate(eligible, windowObject);
    }
    if (match) {
      lastMatch = match;
      if (
        await waitUntilStable(match.element, windowObject)
        && isElementVisible(match.element, windowObject)
        && isElementEnabled(match.element, windowObject)
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

function selectOption(element, step, windowObject) {
  if (String(element.tagName || "").toLowerCase() !== "select") {
    throw new Error("The recorded target is no longer a select control.");
  }
  const requestedValue = String(step.value ?? "");
  const requestedText = comparableText(step.optionText);
  const option = Array.from(element.options || []).find((candidate) => (
    String(candidate.value) === requestedValue
    || requestedText && comparableText(candidate.textContent) === requestedText
  ));
  if (!option) throw new Error("The recorded option is no longer available.");
  setNativeProperty(element, "value", option.value);
  dispatchValueEvents(element, windowObject);
  if (String(element.value) !== String(option.value)) {
    throw new Error("The recorded select control rejected the saved option.");
  }
}

function setChecked(element, desired, windowObject) {
  if (!("checked" in element)) {
    throw new Error("The recorded target is no longer a checkbox or radio control.");
  }
  if (Boolean(element.checked) === desired) return;
  const inputType = String(element.type || element.getAttribute?.("type") || "").toLowerCase();
  if ((inputType === "checkbox" || desired) && typeof element.click === "function") {
    element.click();
  } else {
    setNativeProperty(element, "checked", desired);
    dispatchValueEvents(element, windowObject);
  }
  if (Boolean(element.checked) !== desired) {
    throw new Error(`The recorded control could not be ${desired ? "checked" : "unchecked"}.`);
  }
}

function clickElement(element, windowObject) {
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
  element.click();
}

export async function executeRecordedFlowStep(rawStep, {
  confirmed = false,
  documentObject = document,
  windowObject = window,
  timeoutMs = DEFAULT_TARGET_TIMEOUT_MS,
} = {}) {
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
    documentObject,
    timeoutMs,
    windowObject,
  });
  const { element } = match;
  if (step.action === "click") {
    if (!isElementEnabled(element, windowObject)) {
      throw new Error("The recorded click target became disabled before the action could run.");
    }
    assertConfirmedPageAgentClick(element, confirmed);
    element.focus?.({ preventScroll: true });
    clickElement(element, windowObject);
  } else if (step.action === "fill") {
    fillElement(element, step.value, windowObject);
  } else if (step.action === "select_option") {
    selectOption(element, step, windowObject);
  } else if (step.action === "set_checked") {
    setChecked(element, Boolean(step.value), windowObject);
  } else if (step.action === "submit") {
    const form = String(element.tagName || "").toLowerCase() === "form"
      ? element
      : element.form || element.closest?.("form");
    if (!form) throw new Error("The recorded submit target is no longer inside a form.");
    form.requestSubmit?.();
    if (typeof form.requestSubmit !== "function") form.submit?.();
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
