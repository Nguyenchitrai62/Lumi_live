const MAX_PAGE_MAP_SECTIONS = 16;
const MAX_SNAPSHOT_CONTROLS = 600;
const MAX_DELTA_CONTROLS = 48;

function compactText(value, maxLength = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function hashPageContext(value) {
  const input = String(value || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function controlKind(element) {
  const tag = String(element?.tagName || "").toLowerCase();
  const role = String(element?.getAttribute?.("role") || "").toLowerCase();
  const type = String(element?.type || element?.getAttribute?.("type") || "").toLowerCase();
  if (
    ["checkbox", "radio", "switch"].includes(role)
    || (tag === "input" && ["checkbox", "radio"].includes(type))
  ) return "selection";
  if (tag === "select" || ["combobox", "listbox", "option"].includes(role)) return "choice";
  if (
    tag === "textarea"
    || role === "textbox"
    || element?.isContentEditable
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
  ) return "input";
  return "activation";
}

function selectedState(element) {
  if (typeof element?.checked === "boolean") return element.checked;
  if (typeof element?.selected === "boolean") return element.selected;
  for (const name of ["aria-checked", "aria-pressed", "aria-selected"]) {
    const value = element?.getAttribute?.(name);
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function controlLabel(element) {
  const ownerDocument = element?.ownerDocument;
  const referenced = (name) => String(element?.getAttribute?.(name) || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => ownerDocument?.getElementById?.(id)?.textContent || "")
    .join(" ");
  return compactText([
    element?.getAttribute?.("aria-label"),
    referenced("aria-labelledby"),
    Array.from(element?.labels || [], (label) => label.textContent || "").join(" "),
    element?.getAttribute?.("placeholder"),
    element?.getAttribute?.("title"),
    element?.getAttribute?.("name"),
    element?.textContent,
  ].filter(Boolean).join(" "));
}

function controlState(index, element) {
  const kind = controlKind(element);
  const value = kind === "input"
    ? compactText(element?.isContentEditable ? element?.innerText : element?.value, 180)
    : kind === "choice"
      ? compactText(element?.selectedOptions?.[0]?.textContent || element?.value, 180)
      : "";
  const state = {
    index: Number(index),
    kind,
    label: controlLabel(element),
    selected: selectedState(element),
    disabled: Boolean(
      element?.disabled || element?.getAttribute?.("aria-disabled") === "true"
    ),
    value,
  };
  return {
    ...state,
    fingerprint: hashPageContext(JSON.stringify(state)),
  };
}

function indexedControls(controller) {
  const controls = [];
  for (const [index, node] of controller?.selectorMap?.entries?.() || []) {
    if (!node?.ref || !Number.isInteger(Number(index))) continue;
    controls.push(controlState(Number(index), node.ref));
    if (controls.length >= MAX_SNAPSHOT_CONTROLS) break;
  }
  return controls;
}

export function buildPageMap({
  controller,
  documentRef = globalThis.document,
} = {}) {
  const controls = indexedControls(controller);
  const counts = {
    activation: 0,
    choice: 0,
    input: 0,
    selection: 0,
    disabled: 0,
    selected: 0,
  };
  for (const control of controls) {
    counts[control.kind] = (counts[control.kind] || 0) + 1;
    if (control.disabled) counts.disabled += 1;
    if (control.selected === true) counts.selected += 1;
  }
  const sections = Array.from(
    documentRef?.querySelectorAll?.(
      "h1, h2, h3, legend, [role='dialog'][aria-label], section[aria-label], form[aria-label]",
    ) || [],
  )
    .map((element) => compactText(
      element.getAttribute?.("aria-label") || element.textContent,
      100,
    ))
    .filter(Boolean)
    .slice(0, MAX_PAGE_MAP_SECTIONS);
  return {
    interactiveCount: controls.length,
    truncatedInteractiveIndex: controls.length >= MAX_SNAPSHOT_CONTROLS,
    forms: Number(documentRef?.querySelectorAll?.("form")?.length || 0),
    dialogs: Number(documentRef?.querySelectorAll?.("dialog, [role='dialog']")?.length || 0),
    sections,
    controlCounts: counts,
  };
}

export function buildObservationSnapshot({
  controller,
  content = "",
  state = {},
  documentRef = globalThis.document,
} = {}) {
  const controls = indexedControls(controller);
  const pageMap = buildPageMap({ controller, documentRef });
  return {
    stateId: state.stateId || "",
    documentId: state.documentId || "",
    domRevision: Number(state.domRevision) || 0,
    url: String(state.url || documentRef?.URL || ""),
    title: compactText(documentRef?.title, 180),
    contentFingerprint: hashPageContext(content),
    pageMap,
    controls,
  };
}

export function diffObservationSnapshots(previous, current) {
  if (!previous) {
    return {
      kind: "initial",
      urlChanged: false,
      titleChanged: false,
      contentChanged: true,
      controlCountDelta: current?.pageMap?.interactiveCount || 0,
      changedControls: [],
      truncated: false,
    };
  }
  const before = new Map(
    (previous.controls || []).map((control) => [control.index, control]),
  );
  const after = new Map(
    (current?.controls || []).map((control) => [control.index, control]),
  );
  const changedControls = [];
  for (const [index, nextControl] of after) {
    const priorControl = before.get(index);
    if (!priorControl || priorControl.fingerprint !== nextControl.fingerprint) {
      changedControls.push({
        index,
        kind: nextControl.kind,
        label: nextControl.label,
        change: priorControl ? "updated" : "added",
        selected: nextControl.selected,
        disabled: nextControl.disabled,
      });
    }
  }
  for (const [index, priorControl] of before) {
    if (!after.has(index)) {
      changedControls.push({
        index,
        kind: priorControl.kind,
        label: priorControl.label,
        change: "removed",
      });
    }
  }
  return {
    kind: "delta",
    fromStateId: previous.stateId || "",
    urlChanged: previous.url !== current?.url,
    titleChanged: previous.title !== current?.title,
    contentChanged: previous.contentFingerprint !== current?.contentFingerprint,
    controlCountDelta: (current?.pageMap?.interactiveCount || 0)
      - (previous.pageMap?.interactiveCount || 0),
    changedControls: changedControls.slice(0, MAX_DELTA_CONTROLS),
    truncated: changedControls.length > MAX_DELTA_CONTROLS,
  };
}
