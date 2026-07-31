import {
  appendRecordedStep,
  MAX_RECORDED_FLOWS,
  normalizeRecordedFlow,
  normalizeRecordedFlows,
} from "../core/recorded-flows.js";

function clone(value) {
  return value === null || value === undefined
    ? value
    : JSON.parse(JSON.stringify(value));
}

function createDraft({ sessionId, tabId, startUrl, startTitle }) {
  const now = Date.now();
  return {
    sessionId,
    tabId,
    recording: true,
    dirty: true,
    flowId: "",
    name: `Recorded flow ${new Date(now).toLocaleString()}`,
    startUrl: String(startUrl || ""),
    startTitle: String(startTitle || ""),
    steps: [],
    startedAt: now,
    updatedAt: now,
  };
}

export function createRecordedFlowService({
  localStorageArea,
  sessionStorageArea,
  flowsStorageKey,
  draftStorageKey,
}) {
  let draft = null;

  async function persistDraft() {
    if (!draft) {
      await sessionStorageArea.remove(draftStorageKey);
      return;
    }
    await sessionStorageArea.set({ [draftStorageKey]: draft });
  }

  async function initialize() {
    const stored = await sessionStorageArea.get(draftStorageKey);
    const candidate = stored[draftStorageKey];
    if (candidate && typeof candidate === "object" && Array.isArray(candidate.steps)) {
      draft = {
        ...candidate,
        recording: candidate.recording === true,
        steps: candidate.steps.map((step, index) => ({
          ...step,
          id: String(step?.id || `restored-step-${index + 1}`),
        })),
      };
    }
    return snapshot();
  }

  function snapshot() {
    return clone(draft);
  }

  function isRecordingTab(tabId) {
    return Boolean(draft?.recording && draft.tabId === tabId);
  }

  function sessionId() {
    return draft?.sessionId || "";
  }

  async function start(details) {
    draft = createDraft(details);
    await persistDraft();
    return snapshot();
  }

  async function persistCurrentFlow({ preserveRecording = true } = {}) {
    if (!draft) return { flow: null, flows: await list(), draft: null };
    const flows = await list();
    if (!draft.steps.length) {
      const next = draft.flowId
        ? flows.filter((candidate) => candidate.id !== draft.flowId)
        : flows;
      if (next.length !== flows.length) {
        await localStorageArea.set({ [flowsStorageKey]: next });
      }
      draft.flowId = "";
      draft.dirty = false;
      await persistDraft();
      return { flow: null, flows: next, draft: snapshot() };
    }
    const existing = flows.find((flow) => flow.id === draft.flowId);
    const now = Date.now();
    const flow = normalizeRecordedFlow({
      id: existing?.id || undefined,
      name: draft.name,
      startUrl: draft.startUrl,
      startTitle: draft.startTitle,
      steps: draft.steps,
      createdAt: existing?.createdAt || draft.startedAt || now,
      updatedAt: now,
    });
    const next = [
      flow,
      ...flows.filter((candidate) => candidate.id !== flow.id),
    ].slice(0, MAX_RECORDED_FLOWS);
    await localStorageArea.set({ [flowsStorageKey]: next });
    draft = {
      ...draft,
      flowId: flow.id,
      name: flow.name,
      recording: preserveRecording ? draft.recording : false,
      dirty: false,
      updatedAt: now,
    };
    await persistDraft();
    return { flow, flows: next, draft: snapshot() };
  }

  async function stop() {
    if (!draft) return null;
    draft.recording = false;
    draft.updatedAt = Date.now();
    await persistDraft();
    await persistCurrentFlow();
    return snapshot();
  }

  async function append(rawStep) {
    if (!draft?.recording) return snapshot();
    const steps = appendRecordedStep(draft.steps, rawStep);
    if (JSON.stringify(steps) === JSON.stringify(draft.steps)) return snapshot();
    draft.steps = steps;
    draft.dirty = true;
    draft.updatedAt = Date.now();
    await persistDraft();
    await persistCurrentFlow();
    return snapshot();
  }

  async function recordNavigation({ url, title }) {
    if (!draft?.recording || !url || draft.startUrl === url && !draft.steps.length) return snapshot();
    const previous = draft.steps.at(-1);
    const now = Date.now();
    if (
      previous
      && (
        previous.action === "navigate"
        && (previous.value === url || previous.url === url)
        || previous.resultUrl === url
      )
    ) return snapshot();
    if (
      previous
      && ["click", "select_option", "set_checked"].includes(previous.action)
      && now - previous.recordedAt < 6000
    ) {
      previous.resultUrl = String(url);
      draft.updatedAt = now;
      await persistDraft();
      await persistCurrentFlow();
      return snapshot();
    }
    return append({
      action: "navigate",
      target: { tag: "page", name: String(title || url) },
      value: String(url),
      url: String(url),
      title: String(title || ""),
      recordedAt: now,
    });
  }

  async function updateDraft({
    name,
    stepId,
    prompt,
    move,
    remove,
  }) {
    if (!draft) throw new Error("There is no recorded flow draft to update.");
    if (name !== undefined) draft.name = String(name).trim().slice(0, 120);
    if (stepId) {
      const index = draft.steps.findIndex((step) => step.id === stepId);
      if (index < 0) throw new Error("That recorded step is no longer available.");
      if (remove === true) {
        draft.steps.splice(index, 1);
      } else {
        if (prompt !== undefined) {
          draft.steps[index].prompt = String(prompt).trim().slice(0, 1200);
        }
        if (move === "up" && index > 0) {
          [draft.steps[index - 1], draft.steps[index]] = [draft.steps[index], draft.steps[index - 1]];
        } else if (move === "down" && index < draft.steps.length - 1) {
          [draft.steps[index + 1], draft.steps[index]] = [draft.steps[index], draft.steps[index + 1]];
        }
      }
    }
    draft.dirty = true;
    draft.updatedAt = Date.now();
    await persistDraft();
    await persistCurrentFlow();
    return snapshot();
  }

  async function list() {
    const stored = await localStorageArea.get(flowsStorageKey);
    return normalizeRecordedFlows(stored[flowsStorageKey]);
  }

  async function saveDraft() {
    if (!draft) throw new Error("Record or open a flow before saving.");
    if (!draft.steps.length) throw new Error("Record at least one step before saving this flow.");
    return persistCurrentFlow({ preserveRecording: false });
  }

  async function load(flowId) {
    const flow = (await list()).find((candidate) => candidate.id === flowId);
    if (!flow) throw new Error("That saved flow no longer exists.");
    draft = {
      sessionId: "",
      tabId: null,
      recording: false,
      dirty: false,
      flowId: flow.id,
      name: flow.name,
      startUrl: flow.startUrl,
      startTitle: flow.startTitle,
      steps: clone(flow.steps),
      startedAt: flow.createdAt,
      updatedAt: flow.updatedAt,
    };
    await persistDraft();
    return snapshot();
  }

  async function remove(flowId) {
    const flows = (await list()).filter((candidate) => candidate.id !== flowId);
    await localStorageArea.set({ [flowsStorageKey]: flows });
    if (draft?.flowId === flowId) {
      draft = null;
      await persistDraft();
    }
    return flows;
  }

  async function clearDraft() {
    draft = null;
    await persistDraft();
    return null;
  }

  return {
    append,
    clearDraft,
    initialize,
    isRecordingTab,
    list,
    load,
    recordNavigation,
    remove,
    saveDraft,
    sessionId,
    snapshot,
    start,
    stop,
    updateDraft,
  };
}
