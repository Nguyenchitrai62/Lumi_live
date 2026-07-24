import assert from "node:assert/strict";
import test from "node:test";

import {
  collectWindowOpenCallsInPage,
  findWindowOpenNewTabUrl,
  installWindowOpenProbeInPage,
  resolveNewTabUrl,
  selectNewlyOpenedTab,
  watchForNewTabCreation,
} from "../browser/new-tab-navigation.js";

test("captures window.open calls and restores the page function", () => {
  const probeKey = "__test_window_open_probe__";
  const originalWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    open(url, target) {
      calls.push({ url, target });
      return { url, target };
    },
  };
  const originalOpen = globalThis.window.open;

  try {
    assert.equal(installWindowOpenProbeInPage(probeKey, "click-1"), true);
    assert.deepEqual(globalThis.window.open("/report", "_blank"), {
      url: "/report",
      target: "_blank",
    });
    assert.deepEqual(collectWindowOpenCallsInPage(probeKey, "click-1"), [
      { url: "/report", target: "_blank" },
    ]);
    assert.equal(globalThis.window.open, originalOpen);
    assert.deepEqual(calls, [{ url: "/report", target: "_blank" }]);
  } finally {
    delete globalThis[probeKey];
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("does not overwrite a page replacement left after an interrupted probe", () => {
  const probeKey = "__test_stale_window_open_probe__";
  const originalWindow = globalThis.window;
  globalThis.window = { open: () => "original" };

  try {
    assert.equal(installWindowOpenProbeInPage(probeKey, "click-1"), true);
    const pageReplacement = () => "page replacement";
    globalThis.window.open = pageReplacement;
    assert.equal(installWindowOpenProbeInPage(probeKey, "click-2"), true);
    assert.equal(globalThis.window.open("/report", "_blank"), "page replacement");
    collectWindowOpenCallsInPage(probeKey, "click-2");
    assert.equal(globalThis.window.open, pageReplacement);
  } finally {
    delete globalThis[probeKey];
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("resolves safe relative popup destinations and rejects script URLs", () => {
  assert.equal(
    resolveNewTabUrl("/reports/42", "https://example.test/dashboard"),
    "https://example.test/reports/42",
  );
  assert.equal(
    resolveNewTabUrl("javascript:alert(1)", "https://example.test/"),
    null,
  );
  assert.equal(
    resolveNewTabUrl("data:text/html,unsafe", "https://example.test/"),
    null,
  );
  assert.equal(
    resolveNewTabUrl("file:///C:/private.txt", "https://example.test/"),
    null,
  );
  assert.equal(
    resolveNewTabUrl("file:///C:/reports/42", "file:///C:/dashboard/index.html"),
    "file:///C:/reports/42",
  );
  assert.equal(
    resolveNewTabUrl("https://user:password@example.test/", "https://example.test/"),
    null,
  );
});

test("finds a window.open destination only when it targets a new context", () => {
  assert.equal(
    findWindowOpenNewTabUrl([
      { url: "/same", target: "_self" },
      { url: "/popup", target: "_blank" },
    ], "https://example.test/start"),
    "https://example.test/popup",
  );
  assert.equal(
    findWindowOpenNewTabUrl([{ url: "/top", target: "_top" }], "https://example.test/"),
    null,
  );
});

test("prefers a new tab opened by the clicked source tab", () => {
  const sourceTab = { id: 7, windowId: 2 };
  const selected = selectNewlyOpenedTab(
    new Set([7, 8]),
    [
      { id: 7, windowId: 2, active: false },
      { id: 9, windowId: 2, active: true },
      { id: 10, windowId: 3, openerTabId: 7, active: false },
    ],
    sourceTab,
  );
  assert.equal(selected.id, 10);
});

test("follows a single popup window even when Chrome omits its opener", () => {
  const selected = selectNewlyOpenedTab(
    new Set([7]),
    [
      { id: 7, windowId: 2, active: true },
      { id: 11, windowId: 4, active: true, pendingUrl: "https://example.test/report" },
    ],
    { id: 7, windowId: 2 },
  );
  assert.equal(selected.id, 11);
});

test("does not follow an ambiguous tab opened independently in the same window", () => {
  const selected = selectNewlyOpenedTab(
    new Set([7]),
    [
      { id: 12, windowId: 2, active: true },
      { id: 13, windowId: 2, active: false },
    ],
    { id: 7, windowId: 2 },
  );
  assert.equal(selected, null);
});

test("waits for a tab created asynchronously after the click returns", async () => {
  const listeners = new Set();
  const watcher = watchForNewTabCreation({
    tabsApi: {
      onCreated: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
      },
    },
    beforeTabIds: new Set([7]),
    sourceTab: { id: 7, windowId: 2 },
    timeoutMs: 100,
  });

  setTimeout(() => {
    for (const listener of listeners) {
      listener({ id: 12, windowId: 2, openerTabId: 7 });
    }
  }, 10);

  assert.equal((await watcher.promise).id, 12);
  assert.equal(listeners.size, 0);
});

test("defers a popup without opener metadata until the watcher can prove it is unique", async () => {
  const listeners = new Set();
  const watcher = watchForNewTabCreation({
    tabsApi: {
      onCreated: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
      },
    },
    beforeTabIds: new Set([7]),
    sourceTab: { id: 7, windowId: 2 },
    timeoutMs: 20,
  });

  for (const listener of listeners) {
    listener({ id: 14, windowId: 3, active: true });
  }

  assert.equal((await watcher.promise).id, 14);
  assert.equal(listeners.size, 0);
});
