import assert from "node:assert/strict";
import test from "node:test";

import { createPageStateTracker } from "../browser/page-state-identity.js";

class FakeMutationObserver {
  static latest = null;

  constructor(callback) {
    this.callback = callback;
    FakeMutationObserver.latest = this;
  }

  observe() {}

  disconnect() {}

  mutate(records) {
    this.callback(records);
  }
}

test("issues monotonic state identities and rejects stale stage state", () => {
  const locationRef = { href: "https://example.test/form" };
  const tracker = createPageStateTracker({
    documentRef: { documentElement: {}, URL: locationRef.href },
    locationRef,
    MutationObserverClass: FakeMutationObserver,
    randomUUID: () => "document-one",
  });

  const first = tracker.observe();
  FakeMutationObserver.latest.mutate([{ type: "childList" }]);
  assert.throws(() => tracker.assertFresh(first.stateId), /semantic DOM changed/i);
  const second = tracker.observe();

  assert.equal(first.documentId, "document-one");
  assert.equal(second.domRevision, 1);
  assert.notEqual(first.stateId, second.stateId);
  assert.throws(() => tracker.assertFresh(first.stateId), /stale page state/i);
  assert.equal(tracker.assertFresh(second.stateId), second);
});

test("detects URL changes and disconnected remaining controls", () => {
  const locationRef = { href: "https://example.test/start" };
  const tracker = createPageStateTracker({
    documentRef: { documentElement: {}, URL: locationRef.href },
    locationRef,
    MutationObserverClass: FakeMutationObserver,
    randomUUID: () => "document-two",
  });
  const state = tracker.observe();

  assert.throws(
    () => tracker.assertDocumentStable(state, [{ isConnected: false }]),
    /replaced a remaining control/i,
  );
  locationRef.href = "https://example.test/next";
  assert.throws(() => tracker.assertFresh(state.stateId), /URL changed/i);
});

test("ignores Lumi and PageAgent visual overlay mutations", () => {
  const locationRef = { href: "https://example.test/form" };
  const tracker = createPageStateTracker({
    documentRef: { documentElement: {}, URL: locationRef.href },
    locationRef,
    MutationObserverClass: FakeMutationObserver,
    randomUUID: () => "document-three",
  });
  const state = tracker.observe();
  const visualNode = {
    nodeType: 1,
    matches: (selector) => selector.includes("#lumi-stage-progress"),
    closest: () => null,
  };

  FakeMutationObserver.latest.mutate([{
    type: "childList",
    target: { nodeType: 1, matches: () => false, closest: () => null },
    addedNodes: [visualNode],
    removedNodes: [],
  }]);

  assert.equal(tracker.assertFresh(state.stateId), state);
  assert.equal(tracker.domRevision, 0);
});
