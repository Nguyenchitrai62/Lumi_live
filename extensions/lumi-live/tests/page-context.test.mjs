import assert from "node:assert/strict";
import test from "node:test";

import {
  buildObservationSnapshot,
  buildPageMap,
  diffObservationSnapshots,
} from "../browser/page-context.js";

function control({
  tagName = "INPUT",
  type = "text",
  label = "",
  checked,
  value = "",
  disabled = false,
} = {}) {
  const attributes = new Map([
    ["aria-label", label],
    ["type", type],
  ]);
  return {
    tagName,
    type,
    value,
    checked,
    disabled,
    isContentEditable: false,
    labels: [],
    ownerDocument: { getElementById: () => null },
    textContent: label,
    getAttribute(name) {
      return attributes.get(name) || null;
    },
  };
}

function controller(entries) {
  return {
    selectorMap: new Map(
      entries.map(([index, element]) => [index, { ref: element }]),
    ),
  };
}

const documentRef = {
  URL: "https://example.test/form",
  title: "Example form",
  querySelectorAll(selector) {
    if (selector === "form") return [{}];
    if (selector === "dialog, [role='dialog']") return [];
    return [{ textContent: "Permissions", getAttribute: () => null }];
  },
};

test("builds a compact page map from the shared full-page index", () => {
  const pageController = controller([
    [1, control({ label: "Name", value: "Ada" })],
    [2, control({ label: "Admin", type: "checkbox", checked: true })],
    [3, control({ tagName: "BUTTON", type: "button", label: "Save", disabled: true })],
  ]);
  const map = buildPageMap({ controller: pageController, documentRef });

  assert.equal(map.interactiveCount, 3);
  assert.equal(map.forms, 1);
  assert.equal(map.controlCounts.input, 1);
  assert.equal(map.controlCounts.selection, 1);
  assert.equal(map.controlCounts.activation, 1);
  assert.equal(map.controlCounts.selected, 1);
  assert.equal(map.controlCounts.disabled, 1);
  assert.deepEqual(map.sections, ["Permissions"]);
});

test("reports only changed controls between consecutive observations", () => {
  const checkbox = control({ label: "Admin", type: "checkbox", checked: false });
  const pageController = controller([[2, checkbox]]);
  const first = buildObservationSnapshot({
    controller: pageController,
    content: "Admin unchecked",
    state: { stateId: "one", documentId: "doc", url: documentRef.URL },
    documentRef,
  });
  checkbox.checked = true;
  const second = buildObservationSnapshot({
    controller: pageController,
    content: "Admin checked",
    state: { stateId: "two", documentId: "doc", url: documentRef.URL },
    documentRef,
  });
  const delta = diffObservationSnapshots(first, second);

  assert.equal(delta.kind, "delta");
  assert.equal(delta.contentChanged, true);
  assert.equal(delta.changedControls.length, 1);
  assert.equal(delta.changedControls[0].index, 2);
  assert.equal(delta.changedControls[0].selected, true);
});
