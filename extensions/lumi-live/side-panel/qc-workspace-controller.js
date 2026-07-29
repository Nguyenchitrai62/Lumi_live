import { QC_TOOL_NAMES } from "../live/qc-tools.js";
import { createQcServiceClient, normalizeQcServiceUrl } from "./qc-service-client.js";

const ACTION_TO_BROWSER_TOOL = Object.freeze({
  navigate: ["browser_open_tab", "browser_switch_tab"],
  click: ["browser_click"],
  fill: ["browser_input_text"],
  select: ["browser_select_option", "browser_click"],
  check: ["browser_click"],
  upload: ["browser_upload_file"],
  download: ["browser_click"],
  wait: ["browser_wait_for_page_state"],
  extract: ["browser_get_page_state", "browser_find_semantic_context"],
  assert: [
    "browser_get_page_state",
    "browser_find_semantic_context",
    "browser_wait_for_page_state",
    "browser_inspect_screenshot",
  ],
  generate: ["browser_input_text"],
  login: ["browser_input_text", "browser_click"],
});

function cleanDomains(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .filter((item, index, values) => values.indexOf(item) === index);
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function runStats(run) {
  const plan = run?.plan || {};
  return {
    cases: Number(plan.stats?.test_cases || plan.test_cases?.length || 0),
    steps: Number(plan.stats?.steps || 0),
    review: Number(plan.stats?.needs_review || 0),
    highRisk: Number(plan.stats?.high_risk || 0),
  };
}

export function createQcWorkspaceController({
  elements,
  storageKeys,
  onRefineRequested = () => {},
  onRunStarted = () => {},
  onCriticalApprovalGranted = () => {},
  onComparisonRunReady = () => {},
  onSendBugDraft = async () => ({}),
  onSchedulesChanged = () => {},
  getActiveTarget = async () => null,
  getKnowledgeTarget = async () => null,
  onStatus = () => {},
  onRunChanged = () => {},
} = {}) {
  let currentRun = null;
  let approvalToken = "";
  let activeStep = null;
  let eventSocket = null;
  let discoveryEnabled = false;
  const evidencePaths = new Set();

  const client = createQcServiceClient({
    getEndpoint: () => elements.serviceUrl.value,
    getInstallationToken: () => elements.serviceToken.value,
  });

  function setStatus(message, tone = "") {
    elements.status.textContent = message;
    elements.status.dataset.tone = tone;
    onStatus(message, tone);
  }

  function closeEvents() {
    if (eventSocket?.readyState < WebSocket.CLOSING) eventSocket.close();
    eventSocket = null;
  }

  function openEvents(runId) {
    closeEvents();
    try {
      eventSocket = client.openEvents(runId);
      eventSocket.onmessage = () => {
        void refreshRun({ quiet: true });
      };
      eventSocket.onerror = () => {
        setStatus("Run event stream disconnected; controls still use HTTP.", "warning");
      };
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open run events.", "warning");
    }
  }

  function planSteps(run = currentRun) {
    return (run?.plan?.test_cases || []).flatMap((testCase) =>
      (testCase.steps || []).map((step) => ({
        ...step,
        testCaseId: testCase.id,
        testCaseTitle: testCase.title,
      })));
  }

  function renderPlan() {
    const run = currentRun;
    elements.plan.replaceChildren();
    elements.workspace.dataset.runStatus = run?.status || "none";
    if (!run) {
      elements.summary.textContent = "No workbook compiled.";
      elements.approveButton.disabled = true;
      elements.startButton.disabled = true;
      elements.pauseButton.disabled = true;
      elements.resumeButton.disabled = true;
      elements.cancelButton.disabled = true;
      elements.refineButton.disabled = true;
      elements.approveStepButton.hidden = true;
      elements.downloads.hidden = true;
      if (elements.collectComparisonButton) elements.collectComparisonButton.disabled = true;
      onRunChanged(null, { stats: runStats(null), activeStep: null });
      return;
    }
    const stats = runStats(run);
    elements.summary.textContent =
      `${stats.cases} cases · ${stats.steps} steps · ${stats.review} review · ${stats.highRisk} high risk`;
    for (const reference of run.plan.reference_workbooks || []) {
      const referenceSummary = document.createElement("p");
      referenceSummary.className = "qc-reference-summary";
      referenceSummary.textContent =
        `Reference only: ${reference.name} · ${reference.stats?.sheets || 0} sheets · `
        + `${reference.stats?.feature_rows || 0} features · `
        + `${reference.stats?.field_spec_rows || 0} field specs`;
      elements.plan.append(referenceSummary);
    }
    for (const testCase of run.plan.test_cases || []) {
      const details = document.createElement("details");
      details.className = "qc-test-case";
      const summary = document.createElement("summary");
      summary.textContent = `${testCase.id} · ${testCase.title} (${testCase.steps.length})`;
      details.append(summary);
      const list = document.createElement("ol");
      for (const step of testCase.steps || []) {
        const item = document.createElement("li");
        item.dataset.status = step.status;
        const heading = document.createElement("strong");
        heading.textContent = `${step.action} · ${step.target || step.id}`;
        const instruction = document.createElement("span");
        instruction.textContent = step.instruction;
        const expected = document.createElement("small");
        expected.textContent = step.expected
          ? `Expected: ${step.expected}`
          : "Expected result missing · needs review";
        item.append(heading, instruction, expected);
        list.append(item);
      }
      details.append(list);
      elements.plan.append(details);
    }
    elements.approveButton.disabled = run.status !== "draft" || stats.review > 0;
    elements.refineButton.disabled = run.status !== "draft" || stats.review === 0;
    elements.startButton.disabled = run.status !== "approved";
    elements.pauseButton.disabled = run.status !== "running";
    elements.resumeButton.disabled = run.status !== "paused";
    elements.cancelButton.disabled = !["approved", "running", "paused"].includes(run.status);
    elements.approveStepButton.hidden = !(
      activeStep?.risk === "high"
      && ["running", "paused"].includes(run.status)
    );
    elements.downloads.hidden = !["completed", "failed"].includes(run.status);
    if (elements.collectComparisonButton) {
      elements.collectComparisonButton.disabled = !(
        run.plan?.source_type === "workbook_compare" && run.status === "running"
      );
    }
    onRunChanged(run, { stats, activeStep });
  }

  async function saveConnection() {
    const endpoint = normalizeQcServiceUrl(elements.serviceUrl.value);
    const token = String(elements.serviceToken.value || "").trim();
    if (!token) throw new Error("Enter the Lumi QC installation token.");
    elements.serviceUrl.value = endpoint;
    await chrome.storage.local.set({
      [storageKeys.url]: endpoint,
      [storageKeys.token]: token,
      [storageKeys.domains]: elements.domains.value,
    });
  }

  async function testConnection() {
    try {
      await saveConnection();
      const health = await client.health();
      setStatus(`Local service ${health.version} is ready.`, "success");
      return health;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Local service is unavailable.", "error");
      return null;
    }
  }

  async function compileWorkbook(file, {
    referenceFile = null,
    allowedDomains = null,
  } = {}) {
    if (!file) {
      setStatus("Choose an .xlsx workbook first.", "error");
      throw new Error("Choose an .xlsx workbook first.");
    }
    try {
      if (Array.isArray(allowedDomains) && allowedDomains.length) {
        elements.domains.value = cleanDomains(allowedDomains.join(", ")).join(", ");
      }
      await saveConnection();
      setStatus("Compiling workbook into a QC run plan…");
      currentRun = await client.compile(
        file,
        referenceFile,
        cleanDomains(elements.domains.value),
      );
      approvalToken = "";
      activeStep = null;
      await chrome.storage.session.set({
        [storageKeys.activeRun]: currentRun.run_id,
        [storageKeys.approvalToken]: "",
      });
      openEvents(currentRun.run_id);
      renderPlan();
      setStatus(`Draft ${currentRun.run_id} compiled. Review the plan before approval.`, "success");
      return currentRun;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Workbook compilation failed.", "error");
      throw error;
    }
  }

  async function compile() {
    const file = elements.workbook.files?.[0];
    const referenceFile = elements.referenceWorkbook?.files?.[0] || null;
    await compileWorkbook(file, { referenceFile }).catch(() => {});
  }

  async function activateRun(run, token = "") {
    currentRun = run;
    approvalToken = String(token || "");
    activeStep = currentRun?.current_step_id
      ? planSteps(currentRun).find((step) => step.id === currentRun.current_step_id) || null
      : null;
    await chrome.storage.session.set({
      [storageKeys.activeRun]: currentRun.run_id,
      [storageKeys.approvalToken]: approvalToken,
    });
    openEvents(currentRun.run_id);
    renderPlan();
    return currentRun;
  }

  async function compileComparison() {
    const file = elements.workbook.files?.[0];
    if (!file) {
      elements.comparisonStatus.textContent = "Choose the source Excel workbook above first.";
      return;
    }
    let mappings;
    try {
      mappings = JSON.parse(elements.comparisonMappings.value || "[]");
    } catch {
      elements.comparisonStatus.textContent = "Column mapping must be valid JSON.";
      return;
    }
    const keyColumns = String(elements.comparisonKeys.value || "")
      .split(/[,;\n]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      !elements.comparisonSheet.value.trim()
      || !keyColumns.length
      || !Array.isArray(mappings)
      || !mappings.length
    ) {
      elements.comparisonStatus.textContent =
        "Sheet, at least one key column, and an approved mapping are required.";
      return;
    }
    try {
      await saveConnection();
      const target = await getActiveTarget();
      if (!target?.url) throw new Error("Open and connect the target HICAS ERP page first.");
      const knowledge = await getKnowledgeTarget(target.url);
      const run = await client.compileComparison({
        file,
        sheet: elements.comparisonSheet.value.trim(),
        headerRow: Math.max(1, Math.trunc(Number(elements.comparisonHeaderRow.value) || 1)),
        keyColumns,
        mappings,
        targetUrl: target.url,
        allowedDomains: cleanDomains(elements.domains.value),
        knowledgeVersion: knowledge?.skillVersion || "0.2.0",
        targetFingerprint: knowledge?.route?.fingerprint || "",
        executionMode: knowledge?.fastPathAllowed ? "fast_verified" : "step",
      });
      await activateRun(run);
      elements.comparisonStatus.textContent =
        `Comparison plan ${run.run_id} compiled. Review mapping/key and approve the plan.`;
      onComparisonRunReady({
        runId: run.run_id,
        comparisonId: run.plan.comparison_specs?.[0]?.id || "",
        targetUrl: target.url,
      });
    } catch (error) {
      elements.comparisonStatus.textContent =
        error instanceof Error ? error.message : "Could not compile comparison plan.";
    }
  }

  async function refreshRun({ quiet = false } = {}) {
    if (!currentRun?.run_id) return null;
    try {
      currentRun = await client.getRun(currentRun.run_id);
      renderPlan();
      return currentRun;
    } catch (error) {
      if (!quiet) setStatus(error instanceof Error ? error.message : "Could not refresh run.", "error");
      return null;
    }
  }

  async function transition(action) {
    if (!currentRun?.run_id) return;
    try {
      const result = await client.transition(currentRun.run_id, action);
      if (result.approval_token) {
        approvalToken = result.approval_token;
        await chrome.storage.session.set({
          [storageKeys.approvalToken]: approvalToken,
        });
      }
      await refreshRun({ quiet: true });
      if (action === "cancel") {
        approvalToken = "";
        await chrome.storage.session.remove(storageKeys.approvalToken);
      }
      setStatus(`Run is now ${result.status}.`, "success");
      if (action === "start") {
        onRunStarted({
          runId: currentRun.run_id,
          testCases: currentRun.plan.test_cases.length,
          steps: runStats(currentRun).steps,
          executionMode: currentRun.plan.execution_mode || "step",
          scheduled: false,
        });
      }
      return currentRun;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not ${action} run.`, "error");
      return null;
    }
  }

  function requestRefine() {
    if (!currentRun) return;
    onRefineRequested({
      runId: currentRun.run_id,
      needsReview: runStats(currentRun).review,
    });
  }

  async function approveCriticalStep() {
    if (!currentRun?.run_id || !activeStep?.id) return;
    try {
      await client.approveCriticalStep(currentRun.run_id, activeStep.id);
      elements.approveStepButton.hidden = true;
      setStatus(`High-risk step ${activeStep.id} approved for this run only.`, "success");
      onCriticalApprovalGranted({ runId: currentRun.run_id, stepId: activeStep.id });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not approve step.", "error");
    }
  }

  async function runTool(name, args) {
    if (name === QC_TOOL_NAMES.createPromptPlan) {
      const knowledge = await getKnowledgeTarget(args.targetUrl);
      currentRun = await client.createPromptRun({
        prompt: args.prompt,
        title: args.title,
        target_url: args.targetUrl,
        target_fingerprint: knowledge?.route?.fingerprint || args.targetFingerprint || "",
        knowledge_version: knowledge?.skillVersion || args.knowledgeVersion || "",
        allowed_domains: args.allowedDomains || [],
        execution_mode: (
          args.executionMode === "fast_verified" && knowledge?.fastPathAllowed
        ) ? "fast_verified" : "step",
        steps: (args.steps || []).map((step) => ({
          instruction: step.instruction,
          action: step.action,
          target: step.target || "",
          input: step.input || "",
          expected: step.expected || "",
          assertions: step.assertions || [],
          risk: step.risk || "none",
          entity_scope: step.entityScope || "none",
          skill_record: step.skillRecord || "",
          coverage_status: step.coverageStatus || "",
        })),
      });
      approvalToken = "";
      activeStep = null;
      await chrome.storage.session.set({
        [storageKeys.activeRun]: currentRun.run_id,
        [storageKeys.approvalToken]: "",
      });
      openEvents(currentRun.run_id);
      renderPlan();
      setStatus(
        `Prompt Run Plan ${currentRun.run_id} is ready. Review and approve it before execution.`,
        "warning",
      );
      return {
        created: true,
        runId: currentRun.run_id,
        status: currentRun.status,
        stats: currentRun.plan.stats,
        approvalRequired: true,
      };
    }
    if (name === QC_TOOL_NAMES.getRunPlan) {
      currentRun = await client.getRun(args.runId);
      renderPlan();
      void refreshBugDrafts();
      return {
        runId: currentRun.run_id,
        status: currentRun.status,
        plan: currentRun.plan,
        executionPolicy: "Begin one step, observe, act, stabilize, verify, then record it.",
      };
    }
    if (name === QC_TOOL_NAMES.updateStepMapping) {
      currentRun = await client.updateStepMapping(args.runId, args.stepId, {
        action: args.action,
        target: args.target || "",
        input: args.input || "",
        assertions: args.assertions || [],
        risk: args.risk,
        entity_scope: args.entityScope || "none",
      });
      renderPlan();
      return {
        updated: true,
        stepId: args.stepId,
        remainingNeedsReview: runStats(currentRun).review,
      };
    }
    if (name === QC_TOOL_NAMES.beginStep) {
      const result = await client.beginStep(args.runId, args.stepId);
      activeStep = result.step;
      renderPlan();
      if (result.requires_user_approval) {
        setStatus(`High-risk step ${args.stepId} is paused for explicit approval.`, "warning");
      }
      return result;
    }
    if (name === QC_TOOL_NAMES.recordStep) {
      const result = await client.recordStep(args.runId, args.stepId, {
        status: args.status,
        actual: args.actual || "",
        expected: args.expected || "",
        evidence: args.evidence || "",
        url: args.url || "",
        locator: args.locator || "",
        confidence: args.confidence ?? null,
        screenshot_path: evidencePaths.has(args.screenshotPath) ? args.screenshotPath : "",
        console_errors: args.consoleErrors || [],
        network_errors: args.networkErrors || [],
        retry_count: Math.trunc(args.retryCount || 0),
        timings: args.timings || {},
        execution_mode: args.executionMode || currentRun?.plan?.execution_mode || "step",
      });
      if (activeStep?.id === args.stepId) activeStep = null;
      await refreshRun({ quiet: true });
      return result;
    }
    if (name === QC_TOOL_NAMES.completeRun) {
      const result = await client.complete(args.runId, {
        status: args.status,
        summary: args.summary,
      });
      currentRun = result;
      activeStep = null;
      approvalToken = "";
      await chrome.storage.session.remove(storageKeys.approvalToken);
      renderPlan();
      return {
        completed: true,
        status: result.status,
        report: result.artifacts,
      };
    }
    if (name === QC_TOOL_NAMES.recordComparisonActual) {
      let rows;
      try {
        rows = JSON.parse(args.rowsJson);
      } catch {
        throw new Error("Comparison rowsJson must be a valid JSON array.");
      }
      if (!Array.isArray(rows)) {
        throw new Error("Comparison rowsJson must decode to an array.");
      }
      return client.recordComparisonActual(args.runId, args.comparisonId, {
        rows,
        complete: args.complete === true,
        page_count: Math.trunc(args.pageCount || 1),
        evidence: args.evidence || "",
      });
    }
    if (name === QC_TOOL_NAMES.prepareBugDraft) {
      const result = await client.createBugDraft(args.runId, {
        step_id: args.stepId || "",
        module: args.module || "",
        subject: args.subject,
        description: args.description,
        classification: args.classification,
        url: args.url || "",
        expected: args.expected || "",
        actual: args.actual || "",
        evidence: args.evidence || "",
        screenshot_path: evidencePaths.has(args.screenshotPath) ? args.screenshotPath : "",
        confidence: args.confidence ?? null,
      });
      setStatus(
        `Redmine draft prepared${result.duplicate_draft_ids?.length ? " · possible duplicate" : ""}. Review it before sending.`,
        "warning",
      );
      return {
        created: true,
        draftId: result.id,
        fingerprint: result.fingerprint,
        possibleDuplicates: result.duplicate_draft_ids || [],
        submitted: false,
      };
    }
    throw new Error(`Unsupported QC tool: ${name}`);
  }

  async function authorizeBrowserAction(actionName, args, currentUrl) {
    if (!currentRun || !["running", "paused"].includes(currentRun.status)) return null;
    if (currentRun.status === "paused") {
      throw new Error("QC policy blocked browser mutation while the run is paused.");
    }
    if (!activeStep) {
      throw new Error("QC policy requires qc_begin_step before a browser mutation.");
    }
    if (!approvalToken) {
      throw new Error("The approved QC run token is unavailable. Pause and approve a new run.");
    }
    const allowedTools = ACTION_TO_BROWSER_TOOL[activeStep.action] || [];
    if (!allowedTools.includes(actionName) && actionName !== "browser_scroll") {
      throw new Error(
        `QC policy blocked ${actionName}; active Excel step ${activeStep.id} allows ${activeStep.action}.`,
      );
    }
    const result = await client.authorizeAction(currentRun.run_id, {
      step_id: activeStep.id,
      action: actionName,
      url: currentUrl,
      approval_token: approvalToken,
      arguments: args,
    });
    if (!result.authorized) {
      if (result.reason === "critical_approval_required") {
        elements.approveStepButton.hidden = false;
        setStatus(`Approve high-risk step ${activeStep.id} to continue.`, "warning");
      }
      throw new Error(`QC action authorization denied: ${result.reason}.`);
    }
    return {
      ...args,
      ...(Object.hasOwn(args, "confirmed") || ["browser_click", "browser_upload_file"].includes(actionName)
        ? { confirmed: result.confirmed === true }
        : {}),
    };
  }

  async function recordDiscovery({ url, title, tool, args, result }) {
    if (!discoveryEnabled || !url) return;
    await client.recordDiscovery({
      url,
      title: title || "",
      tool,
      arguments: args || {},
      observation: result || {},
    }).catch(() => {});
  }

  async function recordAgentEvent({ type, phase, payload }) {
    if (
      currentRun?.status !== "running"
      || !activeStep
    ) return null;
    return client.appendEvent(currentRun.run_id, {
      type,
      phase,
      step_id: activeStep.id,
      payload: payload || {},
    });
  }

  async function blockActiveRun(reason) {
    if (!currentRun?.run_id) return null;
    if (!["approved", "running", "paused"].includes(currentRun.status)) return currentRun;
    currentRun = await client.block(currentRun.run_id, reason);
    activeStep = null;
    approvalToken = "";
    await chrome.storage.session.remove(storageKeys.approvalToken);
    renderPlan();
    return currentRun;
  }

  function mayCaptureOwnedSandboxEvidence(urlValue) {
    if (!currentRun || !activeStep) return false;
    if (!["project_create", "owned_project"].includes(activeStep.entity_scope)) return false;
    if (!String(currentRun.plan?.generated_data?.run_marker || "").trim()) return false;
    try {
      const url = new URL(urlValue);
      return (currentRun.plan?.allowed_domains || []).includes(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  async function saveTerminalEvidence(frame, urlValue) {
    if (!mayCaptureOwnedSandboxEvidence(urlValue) || !frame?.data || !frame?.mimeType) return null;
    const saved = await client.saveEvidence(currentRun.run_id, {
      step_id: activeStep.id,
      kind: "terminal_screenshot",
      mime_type: frame.mimeType,
      data_base64: frame.data,
      scope: "owned_sandbox",
      url: urlValue,
    });
    if (saved?.path) evidencePaths.add(saved.path);
    return saved;
  }

  async function download(artifact) {
    if (!currentRun?.run_id) return;
    try {
      const blob = await client.downloadArtifact(currentRun.run_id, artifact);
      const extension = artifact === "xlsx" ? "xlsx" : "html";
      downloadBlob(blob, `lumi-qc-${currentRun.run_id}.${extension}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not download report.", "error");
    }
  }

  function numericOrNull(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  async function refreshBugDrafts() {
    elements.bugDraftList.replaceChildren();
    if (!currentRun?.run_id) {
      elements.bugDraftList.textContent = "No active run.";
      return [];
    }
    try {
      const drafts = await client.listBugDrafts(currentRun.run_id);
      if (!drafts.length) {
        elements.bugDraftList.textContent = "No eligible product bug draft for this run.";
        return drafts;
      }
      for (const item of drafts) {
        const draft = item.draft || {};
        const card = document.createElement("article");
        card.className = "qc-bug-card";
        card.dataset.status = item.status;
        const title = document.createElement("strong");
        title.textContent = item.status === "submitted"
          ? `Submitted #${item.submitted_issue_id}`
          : `Draft · ${draft.classification || "failed_product"}`;
        const subject = document.createElement("input");
        subject.dataset.field = "subject";
        subject.value = draft.subject || "";
        const description = document.createElement("textarea");
        description.dataset.field = "description";
        description.rows = 8;
        description.value = draft.description || "";
        const project = document.createElement("input");
        project.dataset.field = "project_id";
        project.placeholder = "Redmine project ID";
        project.value = draft.project_id || "";
        const tracker = document.createElement("input");
        tracker.dataset.field = "tracker_id";
        tracker.type = "number";
        tracker.placeholder = "Tracker ID (optional)";
        tracker.value = draft.tracker_id || "";
        const priority = document.createElement("input");
        priority.dataset.field = "priority_id";
        priority.type = "number";
        priority.placeholder = "Priority ID (optional)";
        priority.value = draft.priority_id || "";
        const assignee = document.createElement("input");
        assignee.dataset.field = "assigned_to_id";
        assignee.type = "number";
        assignee.placeholder = "Assignee ID (optional)";
        assignee.value = draft.assigned_to_id || "";
        const meta = document.createElement("small");
        meta.textContent = `Fingerprint ${item.fingerprint} · Run ${item.run_id}`;
        const actions = document.createElement("div");
        actions.className = "qc-mini-card-actions";
        if (item.status !== "submitted") {
          const send = document.createElement("button");
          send.type = "button";
          send.textContent = "Send";
          send.addEventListener("click", () => {
            void (async () => {
              try {
                send.disabled = true;
                const patch = {
                  project_id: project.value.trim(),
                  subject: subject.value.trim(),
                  description: description.value.trim(),
                  tracker_id: numericOrNull(tracker.value),
                  priority_id: numericOrNull(priority.value),
                  assigned_to_id: numericOrNull(assignee.value),
                };
                if (!patch.project_id || !patch.subject) {
                  throw new Error("Redmine project ID and subject are required.");
                }
                const updated = await client.patchBugDraft(currentRun.run_id, item.id, patch);
                const submitted = await onSendBugDraft(updated);
                await client.patchBugDraft(currentRun.run_id, item.id, {
                  submitted_issue_id: submitted.issueId,
                  submitted_issue_url: submitted.issueUrl || "",
                });
                setStatus(`Redmine issue #${submitted.issueId} created after explicit Send.`, "success");
                await refreshBugDrafts();
              } catch (error) {
                setStatus(error instanceof Error ? error.message : "Could not send Redmine draft.", "error");
                send.disabled = false;
              }
            })();
          });
          actions.append(send);
        } else if (item.submitted_issue_url) {
          const link = document.createElement("a");
          link.href = item.submitted_issue_url;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = "Open issue";
          actions.append(link);
        }
        card.append(title, project, tracker, priority, assignee, subject, description, meta, actions);
        elements.bugDraftList.append(card);
      }
      return drafts;
    } catch (error) {
      elements.bugDraftList.textContent =
        error instanceof Error ? error.message : "Could not load Redmine drafts.";
      return [];
    }
  }

  async function refreshSchedules() {
    elements.scheduleList.replaceChildren();
    try {
      const schedules = await client.listSchedules();
      if (!schedules.length) elements.scheduleList.textContent = "No schedule configured.";
      for (const schedule of schedules) {
        const card = document.createElement("article");
        card.className = "qc-mini-card";
        const title = document.createElement("strong");
        title.textContent = schedule.name;
        const detail = document.createElement("small");
        detail.textContent =
          `${schedule.local_time} · ${schedule.timezone} · days ${schedule.days_of_week.join(", ")}`;
        const actions = document.createElement("div");
        actions.className = "qc-mini-card-actions";
        const runNow = document.createElement("button");
        runNow.type = "button";
        runNow.textContent = "Run now";
        runNow.addEventListener("click", () => {
          void (async () => {
            try {
              const result = await client.runScheduleNow(schedule.id);
              await activateRun(result.run, result.approval_token);
              onRunStarted({
                runId: currentRun.run_id,
                testCases: currentRun.plan.test_cases.length,
                steps: runStats(currentRun).steps,
                executionMode: currentRun.plan.execution_mode,
                scheduled: true,
              });
            } catch (error) {
              setStatus(error instanceof Error ? error.message : "Scheduled run could not start.", "error");
            }
          })();
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "qc-danger";
        remove.textContent = "Delete";
        remove.addEventListener("click", () => {
          if (!window.confirm(`Delete schedule "${schedule.name}"?`)) return;
          void client.deleteSchedule(schedule.id).then(refreshSchedules);
        });
        actions.append(runNow, remove);
        card.append(title, detail, actions);
        elements.scheduleList.append(card);
      }
      onSchedulesChanged(schedules);
      return schedules;
    } catch (error) {
      elements.scheduleList.textContent =
        error instanceof Error ? error.message : "Could not load schedules.";
      return [];
    }
  }

  async function createSchedule() {
    if (currentRun?.status !== "completed") {
      setStatus("Run the approved plan successfully once before scheduling it.", "warning");
      return;
    }
    const days = elements.scheduleWeekdays
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => Number(checkbox.dataset.qcWeekday));
    try {
      await client.createSchedule({
        name: elements.scheduleName.value.trim() || `LUMI ${currentRun.run_id.slice(0, 8)}`,
        template_run_id: currentRun.run_id,
        local_time: elements.scheduleTime.value || "08:00",
        days_of_week: days,
        timezone: "Asia/Bangkok",
        enabled: true,
      });
      setStatus("Daily schedule created from the successfully completed run.", "success");
      await refreshSchedules();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create schedule.", "error");
    }
  }

  async function initialize() {
    const stored = await chrome.storage.local.get([
      storageKeys.url,
      storageKeys.token,
      storageKeys.domains,
      storageKeys.discovery,
    ]);
    elements.serviceUrl.value = stored[storageKeys.url] || "http://127.0.0.1:8765";
    elements.serviceToken.value = stored[storageKeys.token] || "";
    elements.domains.value = stored[storageKeys.domains] || "";
    discoveryEnabled = stored[storageKeys.discovery] === true;
    elements.discovery.checked = discoveryEnabled;
    const sessionStored = await chrome.storage.session.get([
      storageKeys.activeRun,
      storageKeys.approvalToken,
    ]);
    const activeRunId = String(sessionStored[storageKeys.activeRun] || "").trim();
    approvalToken = String(sessionStored[storageKeys.approvalToken] || "").trim();
    if (activeRunId && elements.serviceToken.value) {
      try {
        currentRun = await client.getRun(activeRunId);
        if (currentRun.current_step_id) {
          activeStep = planSteps(currentRun).find(
            (step) => step.id === currentRun.current_step_id,
          ) || null;
        }
        if (["completed", "failed", "blocked", "cancelled"].includes(currentRun.status)) {
          approvalToken = "";
          await chrome.storage.session.remove(storageKeys.approvalToken);
        } else {
          openEvents(activeRunId);
        }
      } catch {
        currentRun = null;
        activeStep = null;
      }
    }
    renderPlan();
    if (elements.serviceToken.value) {
      void refreshSchedules();
      if (currentRun) void refreshBugDrafts();
    }
  }

  elements.connectButton.addEventListener("click", () => void testConnection());
  elements.compileButton.addEventListener("click", () => void compile());
  elements.compileComparisonButton.addEventListener("click", () => void compileComparison());
  elements.collectComparisonButton.addEventListener("click", () => {
    if (!currentRun || currentRun.plan?.source_type !== "workbook_compare") return;
    onComparisonRunReady({
      runId: currentRun.run_id,
      comparisonId: currentRun.plan.comparison_specs?.[0]?.id || "",
      targetUrl: currentRun.plan.comparison_specs?.[0]?.target_url || "",
      execute: true,
    });
  });
  elements.createScheduleButton.addEventListener("click", () => void createSchedule());
  elements.refreshSchedulesButton.addEventListener("click", () => void refreshSchedules());
  elements.refreshBugDraftsButton.addEventListener("click", () => void refreshBugDrafts());
  elements.refineButton.addEventListener("click", requestRefine);
  elements.approveButton.addEventListener("click", () => void transition("approve"));
  elements.startButton.addEventListener("click", () => void transition("start"));
  elements.pauseButton.addEventListener("click", () => void transition("pause"));
  elements.resumeButton.addEventListener("click", () => void transition("resume"));
  elements.cancelButton.addEventListener("click", () => void transition("cancel"));
  elements.approveStepButton.addEventListener("click", () => void approveCriticalStep());
  elements.downloadExcel.addEventListener("click", () => void download("xlsx"));
  elements.downloadHtml.addEventListener("click", () => void download("html"));
  elements.discovery.addEventListener("change", async () => {
    discoveryEnabled = elements.discovery.checked;
    await chrome.storage.local.set({ [storageKeys.discovery]: discoveryEnabled });
    setStatus(`Discovery Mode ${discoveryEnabled ? "enabled" : "disabled"}.`, "success");
  });

  return {
    initialize,
    compileWorkbook,
    testConnection,
    transitionRun: transition,
    requestRefine,
    approveCriticalStep,
    downloadArtifact: download,
    runTool,
    authorizeBrowserAction,
    recordAgentEvent,
    recordDiscovery,
    blockActiveRun,
    mayCaptureOwnedSandboxEvidence,
    saveTerminalEvidence,
    listBugDrafts: () => currentRun?.run_id
      ? client.listBugDrafts(currentRun.run_id)
      : Promise.resolve([]),
    patchBugDraft: (draftId, value) => {
      if (!currentRun?.run_id) throw new Error("No active QC run.");
      return client.patchBugDraft(currentRun.run_id, draftId, value);
    },
    listSchedules: () => client.listSchedules(),
    createSchedule: (value) => client.createSchedule(value),
    patchSchedule: (scheduleId, value) => client.patchSchedule(scheduleId, value),
    deleteSchedule: (scheduleId) => client.deleteSchedule(scheduleId),
    runScheduleNow: (scheduleId) => client.runScheduleNow(scheduleId),
    activateScheduledRun: async (result, { execute = true } = {}) => {
      await activateRun(result.run, result.approval_token);
      if (execute) {
        onRunStarted({
          runId: currentRun.run_id,
          testCases: currentRun.plan.test_cases.length,
          steps: runStats(currentRun).steps,
          executionMode: currentRun.plan.execution_mode || "step",
          scheduled: true,
        });
      }
      return currentRun;
    },
    refreshRun,
    get activeRun() {
      return currentRun;
    },
    get activeStep() {
      return activeStep;
    },
  };
}
