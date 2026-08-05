import {
  appendRecordedStep,
  MAX_RECORDED_FLOWS,
  normalizeRecordedFlow,
  normalizeRecordedFlows,
  parseRecordedFlowsImport,
  recordedFlowNameKey,
} from "../core/recorded-flows.js";

function clone(value) {
  return value === null || value === undefined
    ? value
    : JSON.parse(JSON.stringify(value));
}

function uniqueImportedFlowId(usedIds) {
  let id = "";
  do {
    const suffix = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    id = `flow-import-${suffix}`;
  } while (usedIds.has(id));
  return id;
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

  async function previewImport(value) {
    const importedFlows = parseRecordedFlowsImport(value);
    return {
      importedFlows,
      savedFlows: await list(),
    };
  }

  async function importFlows(value, resolutions) {
    const importedFlows = parseRecordedFlowsImport(value);
    const currentFlows = await list();
    const importedById = new Map(importedFlows.map((flow) => [flow.id, flow]));
    const currentById = new Map(currentFlows.map((flow) => [flow.id, flow]));
    const selectedResolutions = Array.isArray(resolutions) ? resolutions : [];
    if (!selectedResolutions.length) throw new Error("Select at least one reviewed flow to import.");

    const usedImportedIds = new Set();
    const usedFlowIds = new Set(currentById.keys());
    const occupiedNames = new Set(currentFlows.map((flow) => recordedFlowNameKey(flow.name)));
    const overwrittenFlowIds = new Set();
    const selectedFlows = [];
    let addedCount = 0;
    let updatedCount = 0;

    for (const resolution of selectedResolutions) {
      const importedFlowId = String(resolution?.flowId || "");
      const importedFlow = importedById.get(importedFlowId);
      if (!importedFlow || usedImportedIds.has(importedFlowId)) {
        throw new Error("The import review contains an invalid or duplicate flow selection.");
      }
      usedImportedIds.add(importedFlowId);

      if (resolution.action === "overwrite") {
        const existingFlow = currentById.get(String(resolution.existingFlowId || ""));
        if (!existingFlow || overwrittenFlowIds.has(existingFlow.id)) {
          throw new Error("Choose a valid saved flow to overwrite for every name conflict.");
        }
        if (recordedFlowNameKey(existingFlow.name) !== recordedFlowNameKey(importedFlow.name)) {
          throw new Error("A flow can only overwrite a saved flow with the same name.");
        }
        overwrittenFlowIds.add(existingFlow.id);
        selectedFlows.push(normalizeRecordedFlow({
          ...importedFlow,
          id: existingFlow.id,
          name: existingFlow.name,
          createdAt: existingFlow.createdAt,
          updatedAt: Date.now(),
        }));
        updatedCount += 1;
        continue;
      }

      if (resolution.action !== "add" && resolution.action !== "rename") {
        throw new Error("Choose Add, Overwrite, or Rename for every selected flow.");
      }

      const requestedName = resolution.action === "rename"
        ? String(resolution.name || "").trim()
        : importedFlow.name;
      const normalized = normalizeRecordedFlow({ ...importedFlow, name: requestedName });
      const nameKey = recordedFlowNameKey(normalized.name);
      if (!requestedName || occupiedNames.has(nameKey)) {
        throw new Error(`Resolve the duplicate flow name “${normalized.name || importedFlow.name}” before importing.`);
      }
      occupiedNames.add(nameKey);
      if (usedFlowIds.has(normalized.id)) normalized.id = uniqueImportedFlowId(usedFlowIds);
      usedFlowIds.add(normalized.id);
      selectedFlows.push(normalized);
      addedCount += 1;
    }

    const retainedFlows = currentFlows.filter((flow) => !overwrittenFlowIds.has(flow.id));
    if (selectedFlows.length + retainedFlows.length > MAX_RECORDED_FLOWS) {
      throw new Error(`Importing these flows would exceed the ${MAX_RECORDED_FLOWS}-flow limit.`);
    }
    const flows = normalizeRecordedFlows([...selectedFlows, ...retainedFlows]);
    await localStorageArea.set({ [flowsStorageKey]: flows });
    return {
      addedCount,
      flows,
      importedCount: selectedFlows.length,
      updatedCount,
    };
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
    importFlows,
    initialize,
    isRecordingTab,
    list,
    load,
    previewImport,
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
