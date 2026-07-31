import assert from "node:assert/strict";
import test from "node:test";

import {
  createFastWorkspace,
  FAST_WORKSPACE_COLOR,
  FAST_WORKSPACE_TITLE,
} from "../background/fast-workspace.js";

function createChromeFakes({ storedGroupId = null } = {}) {
  const tabs = new Map([
    [1, { id: 1, windowId: 7, groupId: -1, active: true, url: "https://example.com" }],
    [2, { id: 2, windowId: 7, groupId: -1, active: false, url: "https://example.org" }],
  ]);
  const groups = new Map();
  const storage = storedGroupId === null ? {} : { workspace: storedGroupId };
  let nextGroupId = 20;

  const tabsApi = {
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error("Missing tab");
      return { ...tab };
    },
    async group({ tabIds, groupId }) {
      const resolvedGroupId = Number.isInteger(groupId) ? groupId : nextGroupId++;
      const firstTab = tabs.get(tabIds[0]);
      if (!groups.has(resolvedGroupId)) {
        groups.set(resolvedGroupId, { id: resolvedGroupId, windowId: firstTab.windowId, title: "", color: "grey" });
      }
      for (const tabId of tabIds) tabs.get(tabId).groupId = resolvedGroupId;
      return resolvedGroupId;
    },
    async query(query) {
      return [...tabs.values()]
        .filter((tab) => query.groupId === undefined || tab.groupId === query.groupId)
        .map((tab) => ({ ...tab }));
    },
    async ungroup(tabIds) {
      for (const tabId of tabIds) tabs.get(tabId).groupId = -1;
    },
    async update(tabId, updates) {
      Object.assign(tabs.get(tabId), updates);
      return { ...tabs.get(tabId) };
    },
  };
  const tabGroupsApi = {
    async get(groupId) {
      const group = groups.get(groupId);
      if (!group) throw new Error("Missing group");
      return { ...group };
    },
    async query({ windowId }) {
      return [...groups.values()].filter((group) => group.windowId === windowId).map((group) => ({ ...group }));
    },
    async update(groupId, updates) {
      Object.assign(groups.get(groupId), updates);
      return { ...groups.get(groupId) };
    },
  };
  const storageArea = {
    async get(key) {
      return { [key]: storage[key] };
    },
    async set(values) {
      Object.assign(storage, values);
    },
    async remove(key) {
      delete storage[key];
    },
  };

  return { groups, storage, tabGroupsApi, tabs, tabsApi, storageArea };
}

test("creates one named yellow workspace group and reuses it for more tabs", async () => {
  const fakes = createChromeFakes();
  const workspace = createFastWorkspace({
    tabsApi: fakes.tabsApi,
    tabGroupsApi: fakes.tabGroupsApi,
    storageArea: fakes.storageArea,
    storageKey: "workspace",
  });

  await workspace.initialize();
  const firstState = await workspace.addTab(1);
  await workspace.addTab(2);

  assert.equal(FAST_WORKSPACE_TITLE, "Agent Space");
  assert.equal(firstState.groupId, 20);
  assert.equal(fakes.storage.workspace, 20);
  assert.equal(fakes.groups.get(20).title, FAST_WORKSPACE_TITLE);
  assert.equal(fakes.groups.get(20).color, FAST_WORKSPACE_COLOR);
  assert.equal(fakes.tabs.get(1).autoDiscardable, false);
  assert.equal(fakes.tabs.get(2).groupId, 20);
  assert.equal((await workspace.resolveTarget(2)).id, 2);
});

test("releases only the workspace grouping and keeps its tabs open", async () => {
  const fakes = createChromeFakes();
  const workspace = createFastWorkspace({
    tabsApi: fakes.tabsApi,
    tabGroupsApi: fakes.tabGroupsApi,
    storageArea: fakes.storageArea,
    storageKey: "workspace",
  });

  await workspace.initialize();
  await workspace.addTab(1);
  await workspace.addTab(2);
  await workspace.release();

  assert.equal(fakes.tabs.size, 2);
  assert.equal(fakes.tabs.get(1).groupId, -1);
  assert.equal(fakes.tabs.get(2).groupId, -1);
  assert.equal(fakes.storage.workspace, undefined);
  assert.equal(workspace.state().active, false);
});

test("aborts a stale lifecycle release before ungrouping tabs", async () => {
  const fakes = createChromeFakes();
  const workspace = createFastWorkspace({
    tabsApi: fakes.tabsApi,
    tabGroupsApi: fakes.tabGroupsApi,
    storageArea: fakes.storageArea,
    storageKey: "workspace",
  });

  await workspace.initialize();
  await workspace.addTab(1);
  await workspace.release({ shouldRelease: () => false });

  assert.equal(fakes.tabs.get(1).groupId, 20);
  assert.equal(fakes.storage.workspace, 20);
  assert.equal(workspace.state().active, true);
});

test("drops a stale persisted group during service-worker restore", async () => {
  const fakes = createChromeFakes({ storedGroupId: 99 });
  const workspace = createFastWorkspace({
    tabsApi: fakes.tabsApi,
    tabGroupsApi: fakes.tabGroupsApi,
    storageArea: fakes.storageArea,
    storageKey: "workspace",
  });

  await workspace.initialize();

  assert.equal(workspace.state().groupId, null);
  assert.equal(fakes.storage.workspace, undefined);
});
