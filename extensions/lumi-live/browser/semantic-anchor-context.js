export const MAX_SEMANTIC_ANCHORS = 4;
export const MAX_SEMANTIC_ANCHOR_CHARACTERS = 200;
export const MAX_SEMANTIC_CONTEXT_CHARACTERS = 24000;
export const SEMANTIC_ACTION_INTENTS = [
  "auto",
  "select",
  "activate",
  "input",
  "choose",
  "inspect",
];

const MAX_CANDIDATE_TEXT_CHARACTERS = 800;
const MAX_SERIALIZED_TEXT_CHARACTERS = 500;
const MAX_SERIALIZED_NODES = 1200;
const MAX_SERIALIZED_DEPTH = 32;
const MIN_FUZZY_MATCH_SCORE = 0.56;
const MAX_MATCHES_PER_ANCHOR = 3;

const OMITTED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "link",
  "meta",
]);
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "source",
  "track",
  "wbr",
]);
const SAFE_ATTRIBUTES = [
  "id",
  "role",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-checked",
  "aria-selected",
  "aria-expanded",
  "aria-disabled",
  "alt",
  "name",
  "type",
  "placeholder",
  "title",
  "for",
  "colspan",
  "rowspan",
  "data-testid",
];
const ROW_CONTAINER_SELECTOR = [
  "tr",
  "[role='row']",
].join(",");
const REPEATED_CONTAINER_SELECTOR = [
  "li",
  "[role='listitem']",
  "[role='treeitem']",
  "[role='option']",
  "article",
  "[data-row-key]",
  "[data-row-id]",
].join(",");
const GROUP_CONTAINER_SELECTOR = [
  "form",
  "fieldset",
  "dialog",
  "[role='dialog']",
  "[role='toolbar']",
  "[role='group']",
  "[role='menu']",
  "section",
].join(",");
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  "[role='button']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='option']",
  "[role='menuitem']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='textbox']",
  "[contenteditable='true']",
  "[tabindex]",
].join(",");
const SEMANTIC_CANDIDATE_SELECTOR = [
  ROW_CONTAINER_SELECTOR,
  REPEATED_CONTAINER_SELECTOR,
  GROUP_CONTAINER_SELECTOR,
  INTERACTIVE_SELECTOR,
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "[aria-label]",
  "[title]",
  "[placeholder]",
  "[alt]",
].join(",");

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeSemanticAnchor(value) {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeSemanticActionIntent(value) {
  const intent = String(value || "").trim().toLocaleLowerCase();
  return SEMANTIC_ACTION_INTENTS.includes(intent) ? intent : "auto";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function boundedAttribute(value, maxCharacters = 160) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return "";
  return normalized.length > maxCharacters
    ? `${normalized.slice(0, maxCharacters - 1)}…`
    : normalized;
}

function normalizedBigrams(value) {
  const compact = normalizeSemanticAnchor(value).replaceAll(" ", "");
  if (compact.length < 2) return compact ? new Set([compact]) : new Set();
  const result = new Set();
  for (let index = 0; index < compact.length - 1; index += 1) {
    result.add(compact.slice(index, index + 2));
  }
  return result;
}

function diceSimilarity(left, right) {
  const leftBigrams = normalizedBigrams(left);
  const rightBigrams = normalizedBigrams(right);
  if (!leftBigrams.size || !rightBigrams.size) return 0;
  let overlap = 0;
  for (const bigram of leftBigrams) {
    if (rightBigrams.has(bigram)) overlap += 1;
  }
  return (2 * overlap) / (leftBigrams.size + rightBigrams.size);
}

function tokenCoverage(query, candidate) {
  const queryTokens = new Set(normalizeSemanticAnchor(query).split(" ").filter(Boolean));
  const candidateTokens = new Set(normalizeSemanticAnchor(candidate).split(" ").filter(Boolean));
  if (!queryTokens.size || !candidateTokens.size) return 0;
  let matched = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) matched += 1;
  }
  return matched / queryTokens.size;
}

function semanticSimilarity(query, candidate) {
  const normalizedQuery = normalizeSemanticAnchor(query);
  const normalizedCandidate = normalizeSemanticAnchor(candidate);
  if (!normalizedQuery || !normalizedCandidate) {
    return { score: 0, method: "none" };
  }
  if (normalizedQuery === normalizedCandidate) {
    return { score: 1, method: "exact" };
  }
  if (normalizedCandidate.includes(normalizedQuery)) {
    const specificity = Math.min(0.04, normalizedQuery.length / normalizedCandidate.length * 0.04);
    return { score: 0.94 + specificity, method: "contained" };
  }
  if (normalizedQuery.includes(normalizedCandidate) && normalizedCandidate.length >= 5) {
    const specificity = normalizedCandidate.length / normalizedQuery.length;
    return { score: 0.76 + specificity * 0.12, method: "query_contains" };
  }
  const coverage = tokenCoverage(normalizedQuery, normalizedCandidate);
  const dice = diceSimilarity(normalizedQuery, normalizedCandidate);
  const score = coverage * 0.35 + dice * 0.65;
  return {
    score,
    method: score >= MIN_FUZZY_MATCH_SCORE ? "fuzzy" : "none",
  };
}

export function scoreSemanticAnchorMatch(query, candidate) {
  return semanticSimilarity(query, candidate);
}

function anchorVariants(value) {
  const original = normalizeWhitespace(value).slice(0, MAX_SEMANTIC_ANCHOR_CHARACTERS);
  if (!original) return [];
  const unquoted = original.replace(/^["'`]+|["'`]+$/g, "");
  const pathParts = unquoted.split(/[\\/]/).filter(Boolean);
  const basename = pathParts.at(-1) || "";
  const variants = [unquoted, basename];
  if (basename.includes(".")) {
    variants.push(basename.slice(0, basename.lastIndexOf(".")));
  }
  const seen = new Set();
  return variants.filter((variant) => {
    const normalized = normalizeSemanticAnchor(variant);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function scoreSemanticAnchorVariants(anchor, candidate) {
  let best = { score: 0, method: "none", variant: "" };
  for (const variant of anchorVariants(anchor)) {
    const result = semanticSimilarity(variant, candidate);
    if (result.score > best.score) best = { ...result, variant };
  }
  return best;
}

function elementTag(element) {
  return String(element?.tagName || "").toLocaleLowerCase();
}

function getWindow(element) {
  return element?.ownerDocument?.defaultView || globalThis.window;
}

function isHiddenElement(element) {
  if (!element || element.nodeType !== 1) return false;
  if (
    element.hidden
    || element.getAttribute?.("aria-hidden") === "true"
    || element.closest?.("[hidden], [aria-hidden='true']")
  ) {
    return true;
  }
  try {
    const style = getWindow(element)?.getComputedStyle?.(element);
    if (
      style?.display === "none"
      || style?.visibility === "hidden"
      || style?.visibility === "collapse"
    ) {
      return true;
    }
    const tag = elementTag(element);
    if (tag !== "option" && tag !== "body" && !element.getClientRects?.().length) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function elementText(element, maxCharacters = MAX_CANDIDATE_TEXT_CHARACTERS) {
  const ownerDocument = element?.ownerDocument;
  const referencedText = (attributeName) => String(element?.getAttribute?.(attributeName) || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => ownerDocument?.getElementById?.(id)?.textContent || "")
    .join(" ");
  const labelText = Array.from(element?.labels || [], (label) => label.textContent || "").join(" ");
  const attributes = [
    element?.getAttribute?.("aria-label"),
    referencedText("aria-labelledby"),
    referencedText("aria-describedby"),
    labelText,
    element?.getAttribute?.("title"),
    element?.getAttribute?.("placeholder"),
    element?.getAttribute?.("name"),
    element?.getAttribute?.("alt"),
    element?.getAttribute?.("id"),
    element?.getAttribute?.("data-testid"),
  ];
  let visibleText = "";
  try {
    visibleText = element?.innerText || element?.textContent || "";
  } catch {
    visibleText = element?.textContent || "";
  }
  return normalizeWhitespace([...attributes, visibleText].filter(Boolean).join(" "))
    .slice(0, maxCharacters);
}

function isInteractiveElement(element) {
  try {
    return Boolean(element?.matches?.(INTERACTIVE_SELECTOR));
  } catch {
    return false;
  }
}

function semanticControlKind(element) {
  if (!element) return "";
  const tag = elementTag(element);
  const role = String(element.getAttribute?.("role") || "").toLocaleLowerCase();
  const type = String(element.type || element.getAttribute?.("type") || "").toLocaleLowerCase();
  if (
    role === "checkbox"
    || role === "radio"
    || role === "switch"
    || (tag === "input" && (type === "checkbox" || type === "radio"))
    || element.querySelector?.("input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio'], [role='switch']")
  ) {
    return "select";
  }
  if (
    tag === "select"
    || tag === "option"
    || role === "combobox"
    || role === "listbox"
    || role === "option"
  ) {
    return "choose";
  }
  if (
    tag === "textarea"
    || role === "textbox"
    || element.isContentEditable
    || (tag === "input" && ![
      "button",
      "checkbox",
      "file",
      "hidden",
      "image",
      "radio",
      "reset",
      "submit",
    ].includes(type))
  ) {
    return "input";
  }
  if (
    tag === "button"
    || tag === "a"
    || tag === "summary"
    || ["button", "link", "menuitem", "tab"].includes(role)
    || (tag === "input" && ["button", "file", "image", "reset", "submit"].includes(type))
    || element.hasAttribute?.("tabindex")
  ) {
    return "activate";
  }
  return "";
}

function isControlSelected(element) {
  const related = element?.querySelector?.(
    "input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio'], [role='switch'], option",
  );
  return Boolean(
    element?.checked
    || element?.selected
    || element?.getAttribute?.("aria-checked") === "true"
    || element?.getAttribute?.("aria-selected") === "true"
    || related?.checked
    || related?.selected
    || related?.getAttribute?.("aria-checked") === "true"
    || related?.getAttribute?.("aria-selected") === "true"
  );
}

function isControlDisabled(element) {
  const related = element?.querySelector?.(
    "input, button, select, textarea, [aria-disabled='true']",
  );
  return Boolean(
    element?.disabled
    || element?.getAttribute?.("aria-disabled") === "true"
    || related?.disabled
    || related?.getAttribute?.("aria-disabled") === "true"
  );
}

export function scoreSemanticControlIntent(
  intentValue,
  controlKindValue,
  { disabled = false, selected = false } = {},
) {
  const intent = normalizeSemanticActionIntent(intentValue);
  const controlKind = String(controlKindValue || "").trim().toLocaleLowerCase();
  if (!controlKind || disabled) return 0;
  const scores = {
    auto: { select: 0.7, activate: 0.7, input: 0.7, choose: 0.7 },
    select: { select: 1, choose: 0.5, activate: 0.2, input: 0.05 },
    activate: { activate: 1, select: 0.3, choose: 0.25, input: 0.05 },
    input: { input: 1, choose: 0.25, activate: 0.1, select: 0.05 },
    choose: { choose: 1, select: 0.45, activate: 0.15, input: 0.1 },
    inspect: { select: 0.15, activate: 0.15, input: 0.15, choose: 0.15 },
  };
  const score = scores[intent]?.[controlKind] || 0;
  if (intent === "select" && controlKind === "select" && selected) return 0.08;
  return score;
}

function isInViewport(element) {
  try {
    const view = getWindow(element);
    const width = Number(view?.innerWidth) || 0;
    const height = Number(view?.innerHeight) || 0;
    return Array.from(element?.getClientRects?.() || []).some((rect) =>
      rect.width > 0
      && rect.height > 0
      && rect.bottom >= 0
      && rect.right >= 0
      && rect.top <= height
      && rect.left <= width);
  } catch {
    return false;
  }
}

function buildIndexData(controller) {
  const lookup = new WeakMap();
  const elements = [];
  for (const [index, node] of controller?.selectorMap?.entries?.() || []) {
    if (node?.ref && typeof node.ref === "object") {
      const normalizedIndex = Number(index);
      lookup.set(node.ref, normalizedIndex);
      elements.push({ index: normalizedIndex, element: node.ref });
    }
  }
  return { lookup, elements };
}

function rootContains(root, element) {
  return root === element || Boolean(root?.contains?.(element));
}

function meaningfulParent(element, root, intent) {
  const row = element?.closest?.(ROW_CONTAINER_SELECTOR);
  if (row && rootContains(root, row)) return { element: row, kind: "row" };

  const repeated = element?.closest?.(REPEATED_CONTAINER_SELECTOR);
  if (repeated && rootContains(root, repeated)) {
    return { element: repeated, kind: "repeated-item" };
  }

  const interactive = element?.closest?.(INTERACTIVE_SELECTOR);
  if (interactive && rootContains(root, interactive)) {
    const kind = semanticControlKind(interactive);
    const tag = elementTag(interactive);
    const prefersControl = normalizeSemanticActionIntent(intent) === "auto"
      ? tag === "button" || kind === "select" || kind === "input" || kind === "choose"
      : scoreSemanticControlIntent(intent, kind, {
        disabled: isControlDisabled(interactive),
        selected: isControlSelected(interactive),
      }) >= 0.7;
    if (prefersControl) return { element: interactive, kind: "control" };
  }

  const group = element?.closest?.(GROUP_CONTAINER_SELECTOR);
  if (group && rootContains(root, group)) {
    const textLength = elementText(group, 3501).length;
    if (textLength <= 3500) return { element: group, kind: "group" };
  }

  let interactionContainer = element?.parentElement;
  for (let depth = 0; interactionContainer && depth < 6; depth += 1) {
    if (!rootContains(root, interactionContainer)) break;
    const textLength = elementText(interactionContainer, 3501).length;
    if (
      textLength <= 3500
      && interactionContainer.querySelector?.(INTERACTIVE_SELECTOR)
    ) {
      return { element: interactionContainer, kind: "interaction-container" };
    }
    if (interactionContainer === root) break;
    interactionContainer = interactionContainer.parentElement;
  }

  const parent = element?.parentElement;
  if (
    parent
    && rootContains(root, parent)
    && elementText(parent, 2501).length <= 2500
  ) {
    return { element: parent, kind: "parent" };
  }
  return { element, kind: isInteractiveElement(element) ? "control" : "element" };
}

function candidatePreference(element) {
  const tag = elementTag(element);
  if (isInteractiveElement(element)) return 0.035;
  if (tag === "td" || tag === "th") return 0.025;
  if (tag === "tr" || element?.getAttribute?.("role") === "row") return 0.015;
  return 0;
}

function nodeFilterValue(root, name, fallback) {
  return root?.ownerDocument?.defaultView?.NodeFilter?.[name]
    ?? globalThis.NodeFilter?.[name]
    ?? fallback;
}

function discoverSearchRoots(root) {
  const roots = [];
  const pending = [root];
  const visited = new Set();
  while (pending.length) {
    const currentRoot = pending.shift();
    if (!currentRoot || visited.has(currentRoot)) continue;
    visited.add(currentRoot);
    roots.push(currentRoot);
    const document = currentRoot.ownerDocument || currentRoot;
    const walker = document.createTreeWalker?.(
      currentRoot,
      nodeFilterValue(currentRoot, "SHOW_ELEMENT", 1),
    );
    if (!walker) continue;
    let element = walker.nextNode();
    while (element) {
      if (element.shadowRoot) pending.push(element.shadowRoot);
      if (elementTag(element) === "iframe") {
        try {
          if (element.contentDocument?.body) pending.push(element.contentDocument.body);
        } catch {
          // Cross-origin frames are intentionally not readable from this document.
        }
      }
      element = walker.nextNode();
    }
  }
  return roots;
}

function collectCandidateElements(root) {
  const candidates = new Set();
  if (root?.nodeType === 1) candidates.add(root);
  for (const element of root?.querySelectorAll?.(SEMANTIC_CANDIDATE_SELECTOR) || []) {
    candidates.add(element);
  }

  const document = root?.ownerDocument || root;
  const walker = document?.createTreeWalker?.(
    root,
    nodeFilterValue(root, "SHOW_TEXT", 4),
  );
  if (!walker) return candidates;
  let textNode = walker.nextNode();
  while (textNode) {
    if (normalizeWhitespace(textNode.nodeValue || textNode.textContent || "")) {
      const parent = textNode.parentElement;
      if (parent) candidates.add(parent);
    }
    textNode = walker.nextNode();
  }
  return candidates;
}

function buildSearchScopes(root) {
  return discoverSearchRoots(root).map((searchRoot) => {
    const candidates = [];
    for (const element of collectCandidateElements(searchRoot)) {
      const tag = elementTag(element);
      if (!tag || OMITTED_TAGS.has(tag) || isHiddenElement(element)) continue;
      const text = elementText(element);
      if (!text) continue;
      candidates.push({
        element,
        text,
        preference: candidatePreference(element),
      });
    }
    return { root: searchRoot, candidates };
  });
}

function findMatchesForAnchor(searchScopes, anchor, intent) {
  const variants = anchorVariants(anchor);
  if (!variants.length) return [];
  const scored = [];

  for (const scope of searchScopes) {
    for (const candidate of scope.candidates) {
      const best = scoreSemanticAnchorVariants(anchor, candidate.text);
      if (best.score < MIN_FUZZY_MATCH_SCORE) continue;
      const context = meaningfulParent(candidate.element, scope.root, intent);
      scored.push({
        element: candidate.element,
        searchRoot: scope.root,
        contextElement: context.element,
        contextKind: context.kind,
        candidate: candidate.text,
        matchedVariant: best.variant,
        method: best.method,
        score: Math.min(1, best.score + candidate.preference),
      });
    }
  }

  scored.sort((left, right) =>
    right.score - left.score
    || left.candidate.length - right.candidate.length);

  const uniqueContexts = [];
  const usedContexts = new Set();
  for (const match of scored) {
    if (usedContexts.has(match.contextElement)) continue;
    usedContexts.add(match.contextElement);
    uniqueContexts.push(match);
    if (uniqueContexts.length >= MAX_MATCHES_PER_ANCHOR) break;
  }
  if (uniqueContexts.length < 2) return uniqueContexts;

  const bestScore = uniqueContexts[0].score;
  return uniqueContexts.filter((match, index) =>
    index === 0 || bestScore - match.score <= 0.055);
}

function safeAttributes(element, indexLookup, matchedElement, intent, fullPage) {
  const attributes = [];
  for (const name of SAFE_ATTRIBUTES) {
    const value = boundedAttribute(element?.getAttribute?.(name));
    if (value) attributes.push(`${name}="${escapeHtml(value)}"`);
  }

  const tag = elementTag(element);
  const type = String(element?.type || element?.getAttribute?.("type") || "").toLocaleLowerCase();
  if ((tag === "input" && (type === "checkbox" || type === "radio")) || element?.getAttribute?.("role") === "checkbox") {
    const checked = element?.checked ?? element?.getAttribute?.("aria-checked") === "true";
    attributes.push(`data-lumi-checked="${Boolean(checked)}"`);
  }
  if (element?.disabled || element?.getAttribute?.("aria-disabled") === "true") {
    attributes.push('data-lumi-disabled="true"');
  }
  if (element?.selected) attributes.push('data-lumi-selected="true"');
  if (element?.required) attributes.push('required="true"');
  if (element?.multiple) attributes.push('multiple="true"');
  if (element?.readOnly) attributes.push('readonly="true"');

  const index = indexLookup.get(element);
  if (Number.isInteger(index)) {
    attributes.push(`data-lumi-index="${index}"`);
    if (fullPage) attributes.push('data-lumi-actionable-without-scroll="true"');
  }
  const controlKind = semanticControlKind(element);
  if (controlKind) {
    const intentScore = scoreSemanticControlIntent(intent, controlKind, {
      disabled: isControlDisabled(element),
      selected: isControlSelected(element),
    });
    attributes.push(`data-lumi-control-kind="${controlKind}"`);
    attributes.push(`data-lumi-intent-score="${intentScore.toFixed(2)}"`);
  }
  if (isInteractiveElement(element) || Number.isInteger(index) || controlKind) {
    attributes.push(`data-lumi-in-viewport="${isInViewport(element)}"`);
  }
  if (element === matchedElement) attributes.push('data-lumi-match="true"');
  return attributes.length ? ` ${attributes.join(" ")}` : "";
}

function serializeNode(node, depth, state) {
  if (!node || state.nodeCount >= MAX_SERIALIZED_NODES || depth > MAX_SERIALIZED_DEPTH) {
    state.truncated = true;
    return "";
  }
  if (node.nodeType === 3) {
    const text = normalizeWhitespace(node.nodeValue || node.textContent || "");
    if (!text) return "";
    const bounded = text.length > MAX_SERIALIZED_TEXT_CHARACTERS
      ? `${text.slice(0, MAX_SERIALIZED_TEXT_CHARACTERS - 1)}…`
      : text;
    return `${"  ".repeat(depth)}${escapeHtml(bounded)}\n`;
  }
  if (node.nodeType !== 1) return "";

  const tag = elementTag(node);
  if (!tag || OMITTED_TAGS.has(tag) || isHiddenElement(node)) return "";
  state.nodeCount += 1;
  const index = state.indexLookup.get(node);
  if (Number.isInteger(index)) state.actionableIndices.add(index);
  const attributes = safeAttributes(
    node,
    state.indexLookup,
    state.matchedElement,
    state.intent,
    state.fullPage,
  );
  const indent = "  ".repeat(depth);
  if (VOID_TAGS.has(tag)) return `${indent}<${tag}${attributes} />\n`;

  let children = "";
  for (const child of Array.from(node.childNodes || [])) {
    children += serializeNode(child, depth + 1, state);
    if (state.nodeCount >= MAX_SERIALIZED_NODES) break;
  }
  if (node.shadowRoot && state.nodeCount < MAX_SERIALIZED_NODES) {
    let shadowChildren = "";
    for (const child of Array.from(node.shadowRoot.childNodes || [])) {
      shadowChildren += serializeNode(child, depth + 2, state);
    }
    if (shadowChildren) {
      children += `${indent}  <lumi-shadow-root>\n${shadowChildren}${indent}  </lumi-shadow-root>\n`;
    }
  }
  return `${indent}<${tag}${attributes}>\n${children}${indent}</${tag}>\n`;
}

function serializeContextNode(node, indexLookup, matchedElement, intent, fullPage) {
  const state = {
    indexLookup,
    matchedElement,
    intent,
    fullPage,
    actionableIndices: new Set(),
    nodeCount: 0,
    truncated: false,
  };
  const html = serializeNode(node, 0, state);
  return {
    html,
    actionableIndices: [...state.actionableIndices].sort((left, right) => left - right),
    truncated: state.truncated,
  };
}

function rankIntentControls(contextElement, indexedElements, intent, { preferViewport = true } = {}) {
  const controls = [];
  for (const { index, element } of indexedElements) {
    if (!Number.isInteger(index) || !rootContains(contextElement, element)) continue;
    const kind = semanticControlKind(element);
    if (!kind) continue;
    const disabled = isControlDisabled(element);
    const selected = isControlSelected(element);
    const score = scoreSemanticControlIntent(intent, kind, { disabled, selected });
    if (score <= 0) continue;
    controls.push({
      index,
      kind,
      score,
      disabled,
      selected,
      inViewport: isInViewport(element),
      label: boundedAttribute(elementText(element), 160),
    });
  }
  controls.sort((left, right) =>
    right.score - left.score
    || (preferViewport ? Number(right.inViewport) - Number(left.inViewport) : 0)
    || left.index - right.index);
  return controls.slice(0, 6);
}

function elementDescriptor(element) {
  if (!element) return "";
  const tag = elementTag(element);
  const role = boundedAttribute(element.getAttribute?.("role"));
  const label = boundedAttribute(
    element.getAttribute?.("aria-label")
    || element.getAttribute?.("title"),
    80,
  );
  return `<${tag}${role ? ` role="${escapeHtml(role)}"` : ""}${label ? ` aria-label="${escapeHtml(label)}"` : ""}>`;
}

function ancestryPath(element, root) {
  const parts = [];
  let current = element;
  while (current && parts.length < 6) {
    parts.unshift(elementDescriptor(current));
    if (current === root) break;
    current = current.parentElement;
  }
  return parts.join(" > ");
}

function neighboringContexts(match) {
  const target = match.contextElement;
  const contexts = [{ relation: "target", element: target }];
  if (match.contextKind === "row") {
    const table = target.closest?.("table");
    const header = table?.querySelector?.("thead");
    if (header) contexts.push({ relation: "table-header", element: header });
  }
  const previous = target.previousElementSibling;
  const next = target.nextElementSibling;
  if (previous && !isHiddenElement(previous)) {
    contexts.push({ relation: "before", element: previous });
  }
  if (next && !isHiddenElement(next)) {
    contexts.push({ relation: "after", element: next });
  }
  return contexts;
}

export function resolveSemanticSelectionScope({
  controller,
  anchor,
  includeText = "",
  excludeText = "",
  root = globalThis.document?.body,
  includeDisabled = false,
  maxControls = 300,
} = {}) {
  const normalizedAnchor = normalizeWhitespace(anchor)
    .slice(0, MAX_SEMANTIC_ANCHOR_CHARACTERS);
  if (!root || !normalizedAnchor) {
    return {
      matched: false,
      ambiguous: false,
      anchor: normalizedAnchor,
      indices: [],
      totalMatchedControls: 0,
      excludedControlCount: 0,
    };
  }
  const matches = findMatchesForAnchor(
    buildSearchScopes(root),
    normalizedAnchor,
    "select",
  );
  if (!matches.length) {
    return {
      matched: false,
      ambiguous: false,
      anchor: normalizedAnchor,
      indices: [],
      totalMatchedControls: 0,
      excludedControlCount: 0,
    };
  }
  if (matches.length > 1) {
    return {
      matched: true,
      ambiguous: true,
      anchor: normalizedAnchor,
      candidates: matches.map((match) => ({
        score: Number(match.score.toFixed(3)),
        matchedText: boundedAttribute(match.candidate, 180),
        contextKind: match.contextKind,
        ancestry: ancestryPath(match.contextElement, match.searchRoot),
      })),
      indices: [],
      totalMatchedControls: 0,
      excludedControlCount: 0,
    };
  }

  const include = normalizeSemanticAnchor(includeText);
  const exclude = normalizeSemanticAnchor(excludeText);
  const indexData = buildIndexData(controller);
  const matchedControls = [];
  let excludedControlCount = 0;
  for (const { index, element } of indexData.elements) {
    if (
      !Number.isInteger(index)
      || !rootContains(matches[0].contextElement, element)
      || semanticControlKind(element) !== "select"
    ) continue;
    const descriptor = normalizeSemanticAnchor(elementText(element));
    if (
      (!includeDisabled && isControlDisabled(element))
      || (include && !descriptor.includes(include))
      || (exclude && descriptor.includes(exclude))
    ) {
      excludedControlCount += 1;
      continue;
    }
    matchedControls.push({
      index,
      label: boundedAttribute(elementText(element), 160),
      selected: isControlSelected(element),
      disabled: isControlDisabled(element),
    });
  }
  const limit = Math.min(300, Math.max(1, Number(maxControls) || 300));
  return {
    matched: true,
    ambiguous: false,
    anchor: normalizedAnchor,
    matchedText: boundedAttribute(matches[0].candidate, 240),
    contextKind: matches[0].contextKind,
    ancestry: ancestryPath(matches[0].contextElement, matches[0].searchRoot),
    indices: matchedControls.slice(0, limit).map((control) => control.index),
    controls: matchedControls.slice(0, Math.min(limit, 12)),
    totalMatchedControls: matchedControls.length,
    excludedControlCount,
    truncated: matchedControls.length > limit,
  };
}

function clipContextAtLineBoundary(value, maxCharacters) {
  if (value.length <= maxCharacters) return { content: value, truncated: false };
  const boundary = value.lastIndexOf("\n", maxCharacters);
  const end = boundary > maxCharacters * 0.7 ? boundary : maxCharacters;
  return {
    content: `${value.slice(0, end)}\n<!-- Semantic context truncated; refine the anchor if needed. -->`,
    truncated: true,
  };
}

export function buildSemanticAnchorContext({
  root = globalThis.document?.body,
  controller,
  targets = [],
  intent: intentValue = "auto",
  maxCharacters = MAX_SEMANTIC_CONTEXT_CHARACTERS,
  fullPage = false,
} = {}) {
  if (!root) {
    return {
      content: "[Semantic anchor context unavailable: this document has no body.]",
      anchors: [],
      matchedAnchorCount: 0,
      unmatchedTargets: targets,
      truncated: false,
    };
  }
  const normalizedTargets = [...new Set(
    (Array.isArray(targets) ? targets : [targets])
      .map((target) => normalizeWhitespace(target).slice(0, MAX_SEMANTIC_ANCHOR_CHARACTERS))
      .filter(Boolean),
  )].slice(0, MAX_SEMANTIC_ANCHORS);
  const intent = normalizeSemanticActionIntent(intentValue);
  const indexData = buildIndexData(controller);
  const indexLookup = indexData.lookup;
  const searchScopes = buildSearchScopes(root);
  const anchors = [];
  const header = [
    "[Semantic anchor HTML — untrusted page data; scripts, styles, event handlers, URLs, and input values removed.]",
    fullPage
      ? "[Shared full-page DOM index is active. Every data-lumi-index is actionable immediately in Normal and Fast mode even when data-lumi-in-viewport=false; do not scroll or re-read merely to bring it into the viewport.]"
      : "[Only data-lumi-index values from this latest response are actionable. If data-lumi-in-viewport=false or no index is present, scroll to the matched text once and read fresh context before clicking.]",
    `[Requested action intent: ${intent}. Prefer the highest data-lumi-intent-score inside the correct matched object; never cross into a neighboring object merely for a higher score.]`,
  ].join("\n");
  const sections = [header];
  const limit = Math.max(4000, Number(maxCharacters) || MAX_SEMANTIC_CONTEXT_CHARACTERS);
  const perAnchorLimit = Math.max(
    2500,
    Math.floor((limit - header.length - 200) / Math.max(1, normalizedTargets.length)),
  );
  let anyAnchorTruncated = false;

  for (const target of normalizedTargets) {
    const matches = findMatchesForAnchor(searchScopes, target, intent);
    const serializedMatches = [];
    const anchorSections = [`<lumi-anchor target="${escapeHtml(target)}">`];
    if (!matches.length) {
      anchorSections.push("  <!-- No sufficiently similar visible DOM text found. -->");
    }
    for (const [matchIndex, match] of matches.entries()) {
      const actionableIndices = new Set();
      let contextHtml = "";
      let contextTruncated = false;
      for (const context of neighboringContexts(match)) {
        const serialized = serializeContextNode(
          context.element,
          indexLookup,
          match.element,
          intent,
          fullPage,
        );
        for (const index of serialized.actionableIndices) actionableIndices.add(index);
        contextTruncated ||= serialized.truncated;
        contextHtml += `    <lumi-${context.relation}>\n${serialized.html}    </lumi-${context.relation}>\n`;
      }
      const inViewport = isInViewport(match.element);
      const recommendedControls = rankIntentControls(
        match.contextElement,
        indexData.elements,
        intent,
        { preferViewport: !fullPage },
      );
      const serializedMatch = {
        score: Number(match.score.toFixed(3)),
        method: match.method,
        matchedVariant: match.matchedVariant,
        matchedText: boundedAttribute(match.candidate, 300),
        contextKind: match.contextKind,
        ancestry: ancestryPath(match.contextElement, match.searchRoot),
        inViewport,
        actionableIndices: [...actionableIndices].sort((left, right) => left - right),
        recommendedControls,
        truncated: contextTruncated,
      };
      serializedMatches.push(serializedMatch);
      anchorSections.push(
        `  <lumi-match rank="${matchIndex + 1}" score="${serializedMatch.score}" method="${match.method}" context="${match.contextKind}" in-viewport="${inViewport}" recommended-indices="${recommendedControls.map((control) => control.index).join(",")}">`,
        `    <lumi-ancestry>${escapeHtml(serializedMatch.ancestry)}</lumi-ancestry>`,
        contextHtml.trimEnd(),
        "  </lumi-match>",
      );
    }
    anchorSections.push("</lumi-anchor>");
    const clippedAnchor = clipContextAtLineBoundary(
      anchorSections.join("\n"),
      perAnchorLimit,
    );
    anyAnchorTruncated ||= clippedAnchor.truncated;
    sections.push(`\n${clippedAnchor.content}`);
    anchors.push({
      target,
      matched: serializedMatches.length > 0,
      ambiguous: serializedMatches.length > 1,
      matches: serializedMatches,
    });
  }

  const joined = sections.join("\n");
  const clipped = clipContextAtLineBoundary(joined, limit);
  return {
    content: clipped.content,
    intent,
    anchors,
    matchedAnchorCount: anchors.filter((anchor) => anchor.matched).length,
    unmatchedTargets: anchors.filter((anchor) => !anchor.matched).map((anchor) => anchor.target),
    truncated: clipped.truncated || anyAnchorTruncated || anchors.some((anchor) =>
      anchor.matches.some((match) => match.truncated)),
  };
}
