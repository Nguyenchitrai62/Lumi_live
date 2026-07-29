export const FAST_WORKSPACE_TITLE = "Agent Space";
export const FAST_WORKSPACE_COLOR = "yellow";

function validId(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function createFastWorkspace({
  tabsApi = chrome.tabs,
  tabGroupsApi = chrome.tabGroups,
  storageArea = chrome.storage.session,
  storageKey = "lumiFastWorkspaceGroupId",
} = {}) {
  let groupId = null;

  async function persist(nextGroupId) {
    groupId = validId(nextGroupId);
    if (groupId === null) await storageArea.remove(storageKey);
    else await storageArea.set({ [storageKey]: groupId });
  }

  async function getGroup(candidateGroupId = groupId) {
    const normalizedGroupId = validId(candidateGroupId);
    if (normalizedGroupId === null) return null;
    try {
      return await tabGroupsApi.get(normalizedGroupId);
    } catch {
      if (normalizedGroupId === groupId) await persist(null);
      return null;
    }
  }

  async function initialize() {
    const stored = await storageArea.get(storageKey);
    groupId = validId(stored[storageKey]);
    if (groupId !== null && !await getGroup(groupId)) await persist(null);
    return state();
  }

  async function findNamedGroup(windowId) {
    const groups = await tabGroupsApi.query({ windowId }).catch(() => []);
    return groups.find((group) => group.title === FAST_WORKSPACE_TITLE) || null;
  }

  async function addTab(tabId) {
    const tab = await tabsApi.get(tabId);
    if (!Number.isInteger(tab?.id) || !Number.isInteger(tab.windowId)) {
      throw new Error("Fast workspace requires a valid Chrome tab.");
    }

    let group = await getGroup();
    if (group && group.windowId !== tab.windowId) {
      throw new Error("Fast workspace tabs must stay in the same Chrome window.");
    }
    if (!group) group = await findNamedGroup(tab.windowId);

    const nextGroupId = await tabsApi.group({
      tabIds: [tab.id],
      ...(group?.id !== undefined ? { groupId: group.id } : {}),
    });
    await tabGroupsApi.update(nextGroupId, {
      title: FAST_WORKSPACE_TITLE,
      color: FAST_WORKSPACE_COLOR,
      collapsed: false,
    });
    await tabsApi.update(tab.id, { autoDiscardable: false }).catch(() => {});
    await persist(nextGroupId);
    return state({ windowId: tab.windowId });
  }

  async function containsTab(tabId) {
    if (groupId === null || !Number.isInteger(tabId)) return false;
    try {
      const tab = await tabsApi.get(tabId);
      return tab.groupId === groupId;
    } catch {
      return false;
    }
  }

  async function listTabs() {
    if (!await getGroup()) return [];
    return tabsApi.query({ groupId }).catch(() => []);
  }

  async function resolveTarget(preferredTabId = null) {
    if (Number.isInteger(preferredTabId) && await containsTab(preferredTabId)) {
      try {
        return await tabsApi.get(preferredTabId);
      } catch {
        // Fall through to another tab in the workspace.
      }
    }
    const tabs = await listTabs();
    return tabs.find((tab) => Number.isInteger(tab.id)) || null;
  }

  async function release() {
    const tabs = await listTabs();
    const tabIds = tabs.map((tab) => tab.id).filter(Number.isInteger);
    if (tabIds.length) await tabsApi.ungroup(tabIds).catch(() => {});
    await persist(null);
    return state();
  }

  function state(overrides = {}) {
    return {
      active: groupId !== null,
      groupId,
      title: FAST_WORKSPACE_TITLE,
      color: FAST_WORKSPACE_COLOR,
      ...overrides,
    };
  }

  return Object.freeze({
    addTab,
    containsTab,
    getGroup,
    initialize,
    listTabs,
    release,
    resolveTarget,
    state,
  });
}
