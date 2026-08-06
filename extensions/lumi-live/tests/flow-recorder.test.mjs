import assert from "node:assert/strict";
import test from "node:test";

import {
  createFlowRecorder,
  targetDescriptor,
} from "../browser/flow-recorder.js";

function element(tag, attrs = {}, text = "") {
  const attributes = new Map(Object.entries(attrs));
  return {
    children: [],
    id: attrs.id || "",
    innerText: text,
    labels: [],
    nodeType: 1,
    parentElement: null,
    tagName: tag.toUpperCase(),
    textContent: text,
    type: attrs.type || "",
    value: attrs.value || "",
    closest(selector) {
      if (selector === "form" && this.tagName === "FORM") return this;
      if (selector === "label" && this.tagName === "LABEL") return this;
      return this.parentElement?.closest?.(selector) || null;
    },
    getAttribute(name) { return attributes.get(name) || null; },
  };
}

function append(parent, child) {
  parent.children.push(child);
  child.parentElement = parent;
}

test("button recording keeps multiple stable locators, container context, and hover context", () => {
  const originalNode = globalThis.Node;
  globalThis.Node = { ELEMENT_NODE: 1 };
  const body = element("body");
  const form = element("form", { id: "boq-form", name: "boq" });
  const actions = element("div", { id: "boq-form-actions", class: "actions sticky" });
  const button = element("button", {
    class: "ant-btn ant-btn-primary ant-btn-active css-a1b2c3",
    "data-action": "save-boq",
    type: "submit",
  }, "Save");
  const icon = element("span", { id: "save-boq-icon", class: "button-icon" });
  append(body, form);
  append(form, actions);
  append(actions, button);
  append(button, icon);
  const allElements = [body, form, actions, button, icon];
  const documentObject = {
    body,
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === ":hover") return allElements;
      if (selector.includes('data-action="save-boq"')) return [button];
      if (selector === "button[type=\"submit\"]") return [button];
      if (selector.includes("ant-btn")) return [button];
      if (selector === "#boq-form") return [form];
      if (selector === "#boq-form-actions") return [actions];
      if (selector === "#save-boq-icon") return [icon];
      if (selector.includes("#boq-form-actions")) return [button];
      return [];
    },
  };
  for (const current of allElements) current.ownerDocument = documentObject;
  button.form = form;

  try {
    const descriptor = targetDescriptor(button, { origin: icon });

    assert.equal(descriptor.name, "Save");
    assert.equal(descriptor.type, "submit");
    assert.equal(descriptor.dataAttributes["data-action"], "save-boq");
    assert.ok(descriptor.selectors.includes('[data-action="save-boq"]'));
    assert.ok(descriptor.selectors.includes('button[type="submit"]'));
    assert.deepEqual(descriptor.classNames, ["ant-btn", "ant-btn-primary"]);
    assert.equal(descriptor.semanticOrdinal, 0);
    assert.equal(descriptor.ancestors[0].elementId, "boq-form-actions");
    assert.equal(descriptor.domFingerprint.path[0].tag, "button");
    assert.deepEqual(descriptor.domFingerprint.path[0].classNames, [
      "ant-btn",
      "ant-btn-primary",
    ]);
    assert.equal(descriptor.domFingerprint.path[1].elementId, "boq-form-actions");
    assert.equal(descriptor.domFingerprint.path[2].elementId, "boq-form");
    assert.equal(descriptor.hoverTarget.elementId, "boq-form-actions");
    assert.equal(descriptor.form.elementId, "boq-form");
    assert.equal(descriptor.origin.elementId, "save-boq-icon");
  } finally {
    if (originalNode === undefined) delete globalThis.Node;
    else globalThis.Node = originalNode;
  }
});

class RecorderElement {
  constructor(tag, attrs = {}, text = "") {
    this.attributesMap = new Map(Object.entries(attrs));
    this.children = [];
    this.id = attrs.id || "";
    this.innerText = text;
    this.isConnected = true;
    this.labels = [];
    this.nodeType = 1;
    this.parentElement = null;
    this.tagName = tag.toUpperCase();
    this.textContent = text;
    this.type = attrs.type || "";
    this.value = attrs.value || "";
  }

  getAttribute(name) { return this.attributesMap.get(name) || null; }

  hasAttribute(name) { return this.attributesMap.has(name); }

  matchesSingle(selector) {
    const token = selector.trim();
    if (token.startsWith(".")) {
      const classes = String(this.getAttribute("class") || "").split(/\s+/);
      return token.slice(1).split(".").every((className) => classes.includes(className));
    }
    if (token === "label") return this.tagName === "LABEL";
    if (token === "form") return this.tagName === "FORM";
    if (token === "input") return this.tagName === "INPUT";
    if (token === "textarea") return this.tagName === "TEXTAREA";
    if (token === "select") return this.tagName === "SELECT";
    if (token === "[data-value]") return this.hasAttribute("data-value");
    const presenceAttribute = token.match(/^\[([^=*\]]+)\]$/);
    if (presenceAttribute) return this.hasAttribute(presenceAttribute[1]);
    const containsAttribute = token.match(/^\[([^=]+)\*='([^']+)'\]$/);
    if (containsAttribute) {
      return String(this.getAttribute(containsAttribute[1]) || "").includes(containsAttribute[2]);
    }
    if (token.startsWith("input[type='")) {
      return this.tagName === "INPUT" && this.type === token.match(/type='([^']+)'/)?.[1];
    }
    const attribute = token.match(/^\[([^=\]]+)='([^']+)'\]$/);
    if (attribute) return this.getAttribute(attribute[1]) === attribute[2];
    if (token.startsWith("[contenteditable]")) {
      return this.hasAttribute("contenteditable") && this.getAttribute("contenteditable") !== "false";
    }
    return false;
  }

  matches(selector) {
    return String(selector).split(",").some((token) => this.matchesSingle(token));
  }

  closest(selector) {
    const selectors = String(selector).split(",");
    if (selectors.some((token) => this.matchesSingle(token))) return this;
    for (let current = this.parentElement; current; current = current.parentElement) {
      if (selectors.some((token) => current.matchesSingle(token))) return current;
    }
    return null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (String(selector).split(",").some((token) => child.matchesSingle(token))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

class RecorderInput extends RecorderElement {
  constructor(attrs = {}) {
    super("input", attrs);
    this.files = [];
    this.multiple = attrs.multiple === "" || attrs.multiple === true;
  }
}

class RecorderSelect extends RecorderElement {}
class RecorderTextArea extends RecorderElement {}

function recorderHarness(elements) {
  const listeners = new Map();
  const body = new RecorderElement("body");
  const documentObject = {
    activeElement: null,
    body,
    title: "Recorder test",
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    getElementById(id) { return elements.find((item) => item.id === id) || null; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      if (selector === ":hover") return [];
      if (selector === "*") return elements;
      const id = selector.match(/^#(.+)$/)?.[1];
      if (id) return elements.filter((item) => item.id === id);
      const attribute = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
      if (attribute) return elements.filter((item) => item.getAttribute(attribute[1]) === attribute[2]);
      return elements.filter((item) => selector.startsWith(item.tagName.toLowerCase()));
    },
  };
  body.ownerDocument = documentObject;
  for (const item of elements) item.ownerDocument = documentObject;
  const emitted = [];
  const windowObject = {
    clearTimeout() {},
    location: { href: "https://example.test/form" },
    setTimeout(callback) { callback(); return 1; },
  };
  const recorder = createFlowRecorder({
    documentObject,
    emit(payload) { emitted.push(payload.step); },
    windowObject,
  });
  return { documentObject, emitted, listeners, recorder };
}

async function withRecorderGlobals(run) {
  const previous = {
    Element: globalThis.Element,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    Node: globalThis.Node,
  };
  globalThis.Element = RecorderElement;
  globalThis.HTMLInputElement = RecorderInput;
  globalThis.HTMLSelectElement = RecorderSelect;
  globalThis.HTMLTextAreaElement = RecorderTextArea;
  globalThis.Node = { ELEMENT_NODE: 1 };
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

test("file selection records metadata and unresolved local path variables", async () => {
  await withRecorderGlobals(async () => {
    const input = new RecorderInput({
      accept: ".pdf",
      id: "quote-file",
      type: "file",
    });
    input.files = [{
      lastModified: 1234,
      name: "quote.pdf",
      size: 2048,
      type: "application/pdf",
    }];
    const { emitted, listeners, recorder } = recorderHarness([input]);
    recorder.start("session-upload");
    listeners.get("change")({
      composedPath: () => [input],
      isTrusted: true,
      target: input,
    });
    await Promise.resolve();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].action, "upload_file");
    assert.deepEqual(emitted[0].fileVariables, ["UPLOAD_FILE_1"]);
    assert.deepEqual(emitted[0].localFilePaths, []);
    assert.equal(emitted[0].files[0].name, "quote.pdf");
    assert.equal(emitted[0].target.elementId, "quote-file");
  });
});

test("custom dropdown trigger and option become one semantic select action", async () => {
  await withRecorderGlobals(async () => {
    const trigger = new RecorderElement("div", {
      id: "status-combobox",
      role: "combobox",
    }, "Status");
    const option = new RecorderElement("div", {
      "data-value": "approved",
      id: "status-approved",
      role: "option",
    }, "Approved");
    const { emitted, listeners, recorder } = recorderHarness([trigger, option]);
    recorder.start("session-select");
    listeners.get("click")({
      button: 0,
      composedPath: () => [trigger],
      isTrusted: true,
      target: trigger,
    });
    listeners.get("click")({
      button: 0,
      composedPath: () => [option],
      isTrusted: true,
      target: option,
    });
    await Promise.resolve();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].action, "select_option");
    assert.equal(emitted[0].target.elementId, "status-combobox");
    assert.equal(emitted[0].optionTarget.elementId, "status-approved");
    assert.equal(emitted[0].value, "approved");
  });
});

test("rc-select generated ids are not saved as stable locators", async () => {
  await withRecorderGlobals(async () => {
    const option = new RecorderElement("div", {
      "aria-label": "BOQ",
      id: "rc_select_8_list_6",
      role: "option",
    }, "BOQ");
    recorderHarness([option]);
    const descriptor = targetDescriptor(option);

    assert.equal(descriptor.elementId, "");
    assert.equal(descriptor.selectors.some((selector) => selector.startsWith("#rc_select_")), false);
    assert.ok(descriptor.selectors.includes('div[aria-label="BOQ"]'));
  });
});

test("custom dropdown recording keeps the nearby field label", async () => {
  await withRecorderGlobals(async () => {
    const field = new RecorderElement("div", { class: "ant-col ant-col-6" }, "Sheet name Approval round 4");
    const trigger = new RecorderElement("div", { class: "ant-select ant-select-single" }, "Approval round 4");
    append(field, trigger);
    recorderHarness([field, trigger]);

    const descriptor = targetDescriptor(trigger);

    assert.equal(descriptor.label, "Sheet name");
    assert.equal(descriptor.hoverTarget, null);
  });
});

test("Ant Design combobox records its visible wrapper and exact stable option", async () => {
  await withRecorderGlobals(async () => {
    const field = new RecorderElement(
      "div",
      { class: "ant-col ant-col-6" },
      "Sheet name Approval round 4",
    );
    const selectRoot = new RecorderElement(
      "div",
      { class: "ant-select ant-select-single ant-select-show-search" },
      "Approval round 4",
    );
    const trigger = new RecorderInput({
      "aria-controls": "rc_select_36_list",
      "aria-expanded": "false",
      "aria-haspopup": "listbox",
      id: "rc_select_36",
      role: "combobox",
      type: "search",
    });
    const listbox = new RecorderElement("div", {
      id: "rc_select_36_list",
      role: "listbox",
    });
    const option = new RecorderElement("div", {
      class: "ant-select-item ant-select-item-option ant-select-item-option-active",
      "data-value": "BOQ",
    }, "BOQ");
    const optionContent = new RecorderElement(
      "div",
      { class: "ant-select-item-option-content" },
      "BOQ",
    );
    append(field, selectRoot);
    append(selectRoot, trigger);
    append(listbox, option);
    append(option, optionContent);
    const { emitted, listeners, recorder } = recorderHarness([
      field,
      selectRoot,
      trigger,
      listbox,
      option,
      optionContent,
    ]);

    recorder.start("session-ant-semantic-select");
    listeners.get("click")({
      button: 0,
      composedPath: () => [selectRoot, field],
      isTrusted: true,
      target: selectRoot,
    });
    listeners.get("click")({
      button: 0,
      composedPath: () => [optionContent, option, listbox],
      isTrusted: true,
      target: optionContent,
    });
    await Promise.resolve();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].action, "select_option");
    assert.equal(emitted[0].target.tag, "div");
    assert.equal(emitted[0].target.role, "");
    assert.equal(emitted[0].target.elementId, "");
    assert.equal(emitted[0].target.label, "Sheet name");
    assert.equal(emitted[0].target.classNames.includes("ant-select"), true);
    assert.equal(emitted[0].optionTarget.role, "option");
    assert.equal(emitted[0].optionTarget.name, "BOQ");
    assert.equal(emitted[0].optionTarget.label, "");
    assert.equal(emitted[0].optionTarget.text, "BOQ");
    assert.equal(emitted[0].optionTarget.classNames.includes("ant-select-item-option-active"), false);
    assert.equal(emitted[0].optionTarget.selectors.some((selector) => selector.includes("active")), false);
    assert.equal(emitted[0].value, "BOQ");
  });
});

test("field context recording works for an unknown widget with semantic DOM", async () => {
  await withRecorderGlobals(async () => {
    const field = new RecorderElement("section", {}, "Data source Quarterly report");
    const widget = new RecorderElement("div", { class: "acme-choice-widget" }, "Quarterly report");
    const semanticControl = new RecorderElement("input", { role: "combobox" });
    append(widget, semanticControl);
    append(field, widget);
    recorderHarness([field, widget, semanticControl]);

    const descriptor = targetDescriptor(widget, { action: "select_option" });

    assert.equal(descriptor.label, "Data source");
  });
});

test("Ant Design dropdown records a semantic select action from class-based markup", async () => {
  await withRecorderGlobals(async () => {
    const trigger = new RecorderElement("div", {
      class: "ant-select ant-select-single",
      id: "sheet-name-select",
    });
    const selector = new RecorderElement("div", {
      class: "ant-select-selector",
    }, "Tên trang tính");
    const option = new RecorderElement("div", {
      class: "ant-select-item ant-select-item-option",
      "data-value": "BOQ",
      id: "sheet-boq",
    }, "BOQ");
    const optionContent = new RecorderElement("div", {
      class: "ant-select-item-option-content",
    }, "BOQ");
    append(trigger, selector);
    append(option, optionContent);
    const { emitted, listeners, recorder } = recorderHarness([
      trigger,
      selector,
      option,
      optionContent,
    ]);
    recorder.start("session-ant-select");
    listeners.get("click")({
      button: 0,
      composedPath: () => [selector, trigger],
      isTrusted: true,
      target: selector,
    });
    listeners.get("click")({
      button: 0,
      composedPath: () => [optionContent, option],
      isTrusted: true,
      target: optionContent,
    });
    await Promise.resolve();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].action, "select_option");
    assert.equal(emitted[0].target.elementId, "sheet-name-select");
    assert.equal(emitted[0].optionTarget.elementId, "sheet-boq");
    assert.equal(emitted[0].optionTarget.dataAttributes["data-value"], "BOQ");
    assert.equal(emitted[0].value, "BOQ");
  });
});

test("a sibling Ant Design select does not turn a number-field change into another select", async () => {
  await withRecorderGlobals(async () => {
    const row = new RecorderElement("div", { class: "ant-row" });
    const select = new RecorderElement("div", { class: "ant-select" }, "BOQ");
    const numberInput = new RecorderInput({ type: "number" });
    numberInput.value = "116";
    append(row, select);
    append(row, numberInput);
    const { emitted, listeners, recorder } = recorderHarness([row, select, numberInput]);
    recorder.start("session-number-after-select");
    listeners.get("change")({
      composedPath: () => [numberInput, row],
      isTrusted: true,
      target: numberInput,
    });
    await Promise.resolve();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].action, "fill");
    assert.equal(emitted[0].value, "116");
    assert.notEqual(emitted[0].target.selector, "div.ant-row");
  });
});

test("dropping operating-system files records one upload action without dragstart", async () => {
  await withRecorderGlobals(async () => {
    const trigger = new RecorderElement("span", {
      class: "ant-upload ant-upload-btn",
      id: "boq-dropzone",
      role: "button",
    }, "Nhấp hoặc kéo tệp vào khu vực này để tải lên");
    const input = new RecorderInput({
      accept: ".xlsx,.xls",
      id: "boq-file-input",
      type: "file",
    });
    append(trigger, input);
    input.files = [{
      lastModified: 4567,
      name: "BOQ D1.xlsx",
      size: 4096,
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }];
    const { emitted, listeners, recorder } = recorderHarness([trigger, input]);
    recorder.start("session-drop-upload");
    listeners.get("drop")({
      composedPath: () => [trigger],
      dataTransfer: { files: input.files },
      isTrusted: true,
      target: trigger,
    });
    listeners.get("change")({
      composedPath: () => [input, trigger],
      isTrusted: true,
      target: input,
    });
    await Promise.resolve();

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].action, "upload_file");
    assert.equal(emitted[0].target.elementId, "boq-file-input");
    assert.equal(emitted[0].triggerTarget.elementId, "boq-dropzone");
    assert.equal(emitted[0].accept, ".xlsx,.xls");
    assert.equal(emitted[0].files[0].name, "BOQ D1.xlsx");
    assert.deepEqual(emitted[0].localFilePaths, []);
  });
});
