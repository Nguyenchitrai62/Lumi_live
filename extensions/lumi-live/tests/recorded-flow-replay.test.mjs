import assert from "node:assert/strict";
import test from "node:test";

import {
  executeRecordedFlowStep,
  findRecordedTarget,
  scoreRecordedTargetCandidate,
  waitForRecordedTarget,
} from "../browser/recorded-flow-replay.js";

function fakeElement({
  attrs = {},
  checked = false,
  clickToggles = true,
  disabled = false,
  onDispatch = null,
  parent = null,
  tag = "button",
  text = "",
  value = "",
  visible = true,
} = {}) {
  const attributes = new Map(Object.entries(attrs));
  const events = [];
  return {
    checked,
    clickToggles,
    disabled,
    events,
    id: attrs.id || "",
    innerText: text,
    isConnected: true,
    labels: [],
    name: attrs.name || "",
    parentElement: parent,
    tagName: tag.toUpperCase(),
    textContent: text,
    type: attrs.type || "",
    value,
    visibleForTest: visible,
    click() {
      if (this.clickToggles && String(this.type).toLowerCase() === "checkbox") {
        this.checked = !this.checked;
      }
      events.push({ type: "click" });
    },
    closest() { return null; },
    dispatchEvent(event) {
      events.push(event);
      onDispatch?.(event, this);
      return true;
    },
    focus() {},
    getAttribute(name) { return attributes.get(name) || null; },
    hasAttribute(name) { return attributes.has(name); },
    getBoundingClientRect() {
      return visible
        ? { height: 30, width: 120, x: 10, y: 20 }
        : { height: 0, width: 0, x: 10, y: 20 };
    },
  };
}

function fakeDocument(elements) {
  const documentObject = {
    getElementById(id) {
      return elements.find((element) => element.id === id) || null;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      if (selector === "*") return elements;
      if (selector.startsWith("label[for=")) return [];
      const attributeMatch = selector.match(/(?:^|\[)([a-z0-9_.:-]+)="([^"]*)"\]/i);
      if (attributeMatch) {
        const [, name, value] = attributeMatch;
        return elements.filter((element) => element.getAttribute(name) === value);
      }
      if (selector === "#old-dynamic-id") return [];
      if (selector.includes("button") || selector.includes("[role]")) return elements;
      return [];
    },
  };
  for (const element of elements) element.ownerDocument = documentObject;
  return documentObject;
}

function fakeWindow() {
  return {
    Event: class {
      constructor(type, options) {
        this.type = type;
        this.bubbles = options?.bubbles === true;
      }
    },
    getComputedStyle(element) {
      return element.visibleForTest
        ? { display: "block", pointerEvents: "auto", visibility: "visible" }
        : { display: "none", pointerEvents: "none", visibility: "hidden" };
    },
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback) { callback(); },
  };
}

test("direct target lookup prioritizes a recorded stable element id", () => {
  const wrong = fakeElement({ attrs: { id: "cancel" }, text: "Cancel" });
  const target = fakeElement({ attrs: { id: "save-project" }, text: "Save project" });
  const documentObject = fakeDocument([wrong, target]);

  const match = findRecordedTarget({
    elementId: "save-project",
    name: "Save project",
    selector: "#save-project",
    tag: "button",
  }, { documentObject });

  assert.equal(match.element, target);
  assert.equal(match.strategy, "elementId");
});

test("direct target lookup falls back to semantic identity when a recorded id changed", () => {
  const wrong = fakeElement({ attrs: { id: "other" }, text: "Cancel" });
  const target = fakeElement({ attrs: { id: "generated-842" }, text: "Continue" });
  const documentObject = fakeDocument([wrong, target]);

  const match = findRecordedTarget({
    elementId: "old-dynamic-id",
    name: "Continue",
    selector: "#old-dynamic-id",
    tag: "button",
  }, { documentObject });

  assert.equal(match.element, target);
  assert.equal(match.strategy, "semantic");
});

test("a recycled framework-generated id cannot override a mismatched accessible name", () => {
  const recycled = fakeElement({ attrs: { id: "react-select-2" }, text: "Assignee" });
  const target = fakeElement({ attrs: { id: "react-select-8" }, text: "Project" });
  const documentObject = fakeDocument([recycled, target]);

  const match = findRecordedTarget({
    elementId: "react-select-2",
    name: "Project",
    selector: "#react-select-2",
    tag: "button",
  }, { documentObject });

  assert.equal(match.element, target);
  assert.equal(match.strategy, "semantic");
});

test("target waiting skips a hidden duplicate and uses the visible matching control", async () => {
  const hidden = fakeElement({
    attrs: { "data-testid": "save-project" },
    text: "Save project",
    visible: false,
  });
  const visible = fakeElement({
    attrs: { "data-testid": "save-project" },
    text: "Save project",
  });
  const documentObject = fakeDocument([hidden, visible]);

  const match = await waitForRecordedTarget({
    name: "Save project",
    testId: "save-project",
    tag: "button",
  }, {
    documentObject,
    windowObject: fakeWindow(),
  });

  assert.equal(match.element, visible);
  assert.equal(match.strategy, "testId");
});

test("exact target waiting avoids the full DOM and semantic scans on the fast path", async () => {
  const target = fakeElement({ attrs: { id: "fast-save" }, text: "Save" });
  const documentObject = fakeDocument([target]);
  const queriedSelectors = [];
  const querySelectorAll = documentObject.querySelectorAll.bind(documentObject);
  documentObject.querySelectorAll = (selector) => {
    queriedSelectors.push(selector);
    return querySelectorAll(selector);
  };

  const match = await waitForRecordedTarget({
    elementId: "fast-save",
    tag: "button",
  }, {
    documentObject,
    windowObject: fakeWindow(),
  });

  assert.equal(match.element, target);
  assert.equal(queriedSelectors.includes("*"), false);
  assert.equal(queriedSelectors.some((selector) => selector.includes("button, input")), false);
  assert.deepEqual(
    queriedSelectors.filter((selector) => !selector.startsWith("label[for=")),
    ['[id="fast-save"]'],
  );
});

test("direct replay refuses a required button that remains disabled", async () => {
  const nextButton = fakeElement({
    attrs: { type: "button" },
    disabled: true,
    text: "Tiếp theo",
  });
  const documentObject = fakeDocument([nextButton]);

  await assert.rejects(
    executeRecordedFlowStep({
      action: "click",
      target: {
        name: "Tiếp theo",
        tag: "button",
        type: "button",
      },
    }, {
      confirmed: true,
      documentObject,
      timeoutMs: 500,
      windowObject: fakeWindow(),
    }),
    /did not become visible, enabled, and stable/,
  );
  assert.deepEqual(nextButton.events, []);
});

test("direct replay never falls back from a disabled exact target to another enabled button", async () => {
  const nextButton = fakeElement({
    attrs: { id: "next-step", type: "button" },
    disabled: true,
    text: "Tiếp theo",
  });
  const cancelButton = fakeElement({
    attrs: { id: "cancel", type: "button" },
    text: "Huỷ bỏ",
  });
  const documentObject = fakeDocument([nextButton, cancelButton]);

  await assert.rejects(
    executeRecordedFlowStep({
      action: "click",
      target: {
        elementId: "next-step",
        name: "Tiếp theo",
        selector: "#next-step",
        tag: "button",
        type: "button",
      },
    }, {
      confirmed: true,
      documentObject,
      timeoutMs: 2000,
      windowObject: fakeWindow(),
    }),
    /did not become visible, enabled, and stable/,
  );
  assert.deepEqual(nextButton.events, []);
  assert.deepEqual(cancelButton.events, []);
});

test("direct target lookup uses an additional recorded data locator when the primary selector changed", () => {
  const wrong = fakeElement({ attrs: { "data-action": "cancel" }, text: "Save" });
  const target = fakeElement({ attrs: { "data-action": "save-boq" }, text: "Save" });
  const documentObject = fakeDocument([wrong, target]);

  const match = findRecordedTarget({
    dataAttributes: { "data-action": "save-boq" },
    name: "Save",
    selector: "#stale-save-button",
    selectors: ["#stale-save-button", '[data-action="save-boq"]'],
    tag: "button",
  }, { documentObject });

  assert.equal(match.element, target);
  assert.equal(match.strategy, "data:data-action");
});

test("direct target lookup uses recorded ancestor context to disambiguate duplicate buttons", () => {
  const footer = fakeElement({ attrs: { id: "page-footer" }, tag: "div" });
  const toolbar = fakeElement({ attrs: { id: "boq-form-actions" }, tag: "div" });
  const wrong = fakeElement({ parent: footer, text: "Save" });
  const target = fakeElement({ parent: toolbar, text: "Save" });
  const documentObject = fakeDocument([footer, toolbar, wrong, target]);

  const match = findRecordedTarget({
    ancestors: [{ elementId: "boq-form-actions", tag: "div" }],
    name: "Save",
    tag: "button",
  }, { documentObject });

  assert.equal(match.element, target);
  assert.ok(match.score > scoreRecordedTargetCandidate({ name: "Save", tag: "button" }, wrong));
});

test("direct target lookup can recover the button from a recorded child origin id", () => {
  const button = fakeElement({ text: "" });
  const icon = fakeElement({ attrs: { id: "save-boq-icon" }, parent: button, tag: "span" });
  const documentObject = fakeDocument([button, icon]);

  const match = findRecordedTarget({
    name: "",
    origin: { elementId: "save-boq-icon", selector: "#save-boq-icon", tag: "span" },
    tag: "button",
  }, { documentObject });

  assert.equal(match.element, button);
  assert.equal(match.strategy, "origin");
});

test("target waiting replays recorded hover context before looking for a mounted button", async () => {
  const elements = [];
  const target = fakeElement({ attrs: { "data-action": "save-row" }, text: "Save row" });
  const hoverContainer = fakeElement({
    attrs: { id: "boq-row-1" },
    onDispatch(event) {
      if (event.type === "mouseover" && !elements.includes(target)) elements.push(target);
    },
    tag: "div",
  });
  elements.push(hoverContainer);
  const documentObject = fakeDocument(elements);

  const match = await waitForRecordedTarget({
    dataAttributes: { "data-action": "save-row" },
    hoverTarget: { elementId: "boq-row-1", selector: "#boq-row-1", tag: "div" },
    name: "Save row",
    tag: "button",
  }, {
    documentObject,
    timeoutMs: 1000,
    windowObject: fakeWindow(),
  });

  assert.equal(match.element, target);
  assert.ok(hoverContainer.events.some((event) => event.type === "mouseover"));
});

test("direct replay waits for an exact target to become enabled after page hydration", async () => {
  const nextButton = fakeElement({
    attrs: { id: "next-step", type: "button" },
    disabled: true,
    text: "Next",
  });
  const documentObject = fakeDocument([nextButton]);
  const windowObject = fakeWindow();
  let waitCount = 0;
  windowObject.setTimeout = (callback) => {
    waitCount += 1;
    if (waitCount === 20) nextButton.disabled = false;
    callback();
  };

  const result = await executeRecordedFlowStep({
    action: "click",
    target: {
      elementId: "next-step",
      name: "Next",
      selector: "#next-step",
      tag: "button",
      type: "button",
    },
  }, {
    confirmed: true,
    documentObject,
    timeoutMs: 2000,
    windowObject,
  });

  assert.equal(result.success, true);
  assert.ok(waitCount >= 20);
  assert.deepEqual(nextButton.events.map((event) => event.type), ["click"]);
});

test("direct replay refuses a recorded child inside a disabled button", async () => {
  const nextButton = fakeElement({
    attrs: { disabled: "", type: "button" },
    disabled: true,
    text: "Tiếp theo",
  });
  const nextLabel = fakeElement({
    attrs: { id: "next-label" },
    parent: nextButton,
    tag: "span",
    text: "Tiếp theo",
  });
  const documentObject = fakeDocument([nextLabel, nextButton]);

  await assert.rejects(
    executeRecordedFlowStep({
      action: "click",
      target: {
        elementId: "next-label",
        name: "Tiếp theo",
        selector: "#next-label",
        tag: "span",
      },
    }, {
      confirmed: true,
      documentObject,
      timeoutMs: 500,
      windowObject: fakeWindow(),
    }),
    /did not become visible, enabled, and stable/,
  );
  assert.deepEqual(nextLabel.events, []);
  assert.deepEqual(nextButton.events, []);
});

test("direct replay fills a matched input and dispatches framework-compatible events", async () => {
  const input = fakeElement({
    attrs: { id: "project-name", name: "project_name", type: "text" },
    tag: "input",
  });
  const documentObject = fakeDocument([input]);

  const result = await executeRecordedFlowStep({
    action: "fill",
    target: {
      elementId: "project-name",
      inputName: "project_name",
      selector: "#project-name",
      tag: "input",
      type: "text",
    },
    value: "QC direct replay",
  }, {
    documentObject,
    windowObject: fakeWindow(),
  });

  assert.equal(result.success, true);
  assert.equal(result.locatorStrategy, "elementId");
  assert.equal(input.value, "QC direct replay");
  assert.deepEqual(input.events.map((event) => event.type), ["input", "change"]);
});

test("direct replay toggles a checkbox in either direction and verifies the result", async () => {
  const checkbox = fakeElement({
    attrs: { id: "project-active", type: "checkbox" },
    checked: true,
    tag: "input",
  });
  const documentObject = fakeDocument([checkbox]);

  const result = await executeRecordedFlowStep({
    action: "set_checked",
    target: {
      elementId: "project-active",
      selector: "#project-active",
      tag: "input",
      type: "checkbox",
    },
    value: false,
  }, {
    documentObject,
    windowObject: fakeWindow(),
  });

  assert.equal(result.success, true);
  assert.equal(checkbox.checked, false);
  assert.deepEqual(checkbox.events.map((event) => event.type), ["click"]);
});

test("direct replay fails instead of reporting success when a checkbox rejects the change", async () => {
  const checkbox = fakeElement({
    attrs: { id: "locked-setting", type: "checkbox" },
    checked: false,
    clickToggles: false,
    tag: "input",
  });
  const documentObject = fakeDocument([checkbox]);

  await assert.rejects(
    executeRecordedFlowStep({
      action: "set_checked",
      target: {
        elementId: "locked-setting",
        selector: "#locked-setting",
        tag: "input",
        type: "checkbox",
      },
      value: true,
    }, {
      documentObject,
      windowObject: fakeWindow(),
    }),
    /could not be checked/,
  );
});
