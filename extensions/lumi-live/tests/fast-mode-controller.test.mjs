import assert from "node:assert/strict";
import test from "node:test";

import { createFastModeController } from "../side-panel/fast-mode-controller.js";

class FakeClassList {
  values = new Set();

  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    if (force) this.values.add(value);
    else this.values.delete(value);
  }
}

function fakeElement() {
  const attributes = new Map();
  return {
    classList: new FakeClassList(),
    dataset: {},
    offsetWidth: 72,
    title: "",
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
  };
}

test("keeps the user-triggered Fast engagement effect when the storage event arrives first", async () => {
  const button = fakeElement();
  const label = { textContent: "Fast" };
  button.querySelector = () => label;
  let resolvePreference;
  const preferenceResponse = new Promise((resolve) => {
    resolvePreference = resolve;
  });
  const body = fakeElement();
  const controller = createFastModeController({
    button,
    documentElement: fakeElement(),
    body,
    vtuberCard: fakeElement(),
    vtuberToggle: fakeElement(),
    transcript: fakeElement(),
    panelAudio: { setVisualAnimationsEnabled() {} },
    avatarController: { async setEnabled() {} },
    petalEmitter: { start() {}, stop() {} },
    getPetalsEnabled: () => true,
    flushTranscriptReveals() {},
    getSessionOptions: () => null,
    setSessionOptions() {},
    sendRuntime: () => preferenceResponse,
    setStatus() {},
  });

  const togglePromise = controller.toggle();
  controller.apply(true);
  resolvePreference({ fastMode: true, workspace: { title: "Lumi Workspace" } });
  await togglePromise;

  assert.equal(controller.enabled, true);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(label.textContent, "Fast on");
  assert.equal(button.classList.contains("is-engaging"), true);
  controller.dispose();
});
