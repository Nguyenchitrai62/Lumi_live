import assert from "node:assert/strict";
import test from "node:test";

import { targetDescriptor } from "../browser/flow-recorder.js";

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
    class: "ant-btn ant-btn-primary css-a1b2c3",
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
    assert.equal(descriptor.hoverTarget.elementId, "boq-form-actions");
    assert.equal(descriptor.form.elementId, "boq-form");
    assert.equal(descriptor.origin.elementId, "save-boq-icon");
  } finally {
    if (originalNode === undefined) delete globalThis.Node;
    else globalThis.Node = originalNode;
  }
});
