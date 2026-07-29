const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const DEFAULT_TIMEOUT_MS = 15000;

export function normalizeQcServiceUrl(value) {
  const url = new URL(String(value || "http://127.0.0.1:8765").trim());
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error("Lumi QC service must use http://127.0.0.1 or http://localhost.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function websocketUrl(endpoint, runId, token) {
  const url = new URL(`${endpoint}/v1/runs/${encodeURIComponent(runId)}/events`);
  url.protocol = "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

function errorMessage(body, response) {
  return String(body?.detail || body?.error || `${response.status} ${response.statusText}`).slice(0, 1200);
}

export function createQcServiceClient({
  getEndpoint,
  getInstallationToken,
  fetchImpl = fetch,
} = {}) {
  async function request(path, {
    method = "GET",
    body,
    headers = {},
    responseType = "json",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    const endpoint = normalizeQcServiceUrl(getEndpoint());
    const installationToken = String(getInstallationToken() || "").trim();
    if (!installationToken) throw new Error("Enter the Lumi QC installation token.");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}${path}`, {
        method,
        body,
        headers: {
          "X-Lumi-Installation-Token": installationToken,
          ...headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        throw new Error(errorMessage(payload, response));
      }
      if (responseType === "blob") return response.blob();
      if (response.status === 204) return null;
      return response.json();
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Lumi QC service did not respond before the request timeout.");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const jsonRequest = (path, method, body) => request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
  });

  return {
    health: async () => {
      const endpoint = normalizeQcServiceUrl(getEndpoint());
      const response = await fetchImpl(`${endpoint}/health`);
      if (!response.ok) throw new Error("Lumi QC service health check failed.");
      return response.json();
    },
    compile: (file, referenceFile = null, allowedDomains = []) => {
      const form = new FormData();
      form.set("file", file, file.name);
      if (referenceFile) {
        form.set("reference_file", referenceFile, referenceFile.name);
      }
      form.set("allowed_domains", JSON.stringify(allowedDomains));
      return request("/v1/workbooks/compile", { method: "POST", body: form, timeoutMs: 60000 });
    },
    createPromptRun: (plan) => jsonRequest("/v1/runs/from-prompt", "POST", plan),
    compileComparison: ({
      file,
      sheet,
      headerRow,
      keyColumns,
      mappings,
      targetUrl,
      allowedDomains,
      knowledgeVersion = "",
      targetFingerprint = "",
      executionMode = "step",
    }) => {
      const form = new FormData();
      form.set("file", file, file.name);
      form.set("sheet", sheet);
      form.set("header_row", String(headerRow));
      form.set("key_columns", JSON.stringify(keyColumns));
      form.set("mappings", JSON.stringify(mappings));
      form.set("target_url", targetUrl);
      form.set("allowed_domains", JSON.stringify(allowedDomains));
      form.set("knowledge_version", knowledgeVersion);
      form.set("target_fingerprint", targetFingerprint);
      form.set("execution_mode", executionMode);
      return request("/v1/comparisons/compile", {
        method: "POST",
        body: form,
        timeoutMs: 60000,
      });
    },
    getRun: (runId) => request(`/v1/runs/${encodeURIComponent(runId)}`),
    transition: (runId, action) =>
      jsonRequest(`/v1/runs/${encodeURIComponent(runId)}/${action}`, "POST"),
    updateStepMapping: (runId, stepId, mapping) =>
      jsonRequest(
        `/v1/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/mapping`,
        "POST",
        mapping,
      ),
    beginStep: (runId, stepId) =>
      jsonRequest(
        `/v1/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/begin`,
        "POST",
      ),
    approveCriticalStep: (runId, stepId) =>
      jsonRequest(
        `/v1/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/approve`,
        "POST",
      ),
    authorizeAction: (runId, payload) =>
      jsonRequest(`/v1/runs/${encodeURIComponent(runId)}/authorize-action`, "POST", payload),
    recordStep: (runId, stepId, result) =>
      jsonRequest(
        `/v1/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/record`,
        "POST",
        result,
      ),
    appendEvent: (runId, event) =>
      jsonRequest(`/v1/runs/${encodeURIComponent(runId)}/events`, "POST", event),
    complete: (runId, body) =>
      jsonRequest(`/v1/runs/${encodeURIComponent(runId)}/complete`, "POST", body),
    block: (runId, reason) =>
      jsonRequest(`/v1/runs/${encodeURIComponent(runId)}/block`, "POST", { reason }),
    saveEvidence: (runId, body) =>
      jsonRequest(`/v1/runs/${encodeURIComponent(runId)}/evidence`, "POST", body),
    recordComparisonActual: (runId, comparisonId, body) =>
      jsonRequest(
        `/v1/runs/${encodeURIComponent(runId)}/comparisons/${encodeURIComponent(comparisonId)}/actual`,
        "POST",
        body,
      ),
    createBugDraft: (runId, body) =>
      jsonRequest(`/v1/runs/${encodeURIComponent(runId)}/bug-drafts`, "POST", body),
    listBugDrafts: (runId) =>
      request(`/v1/runs/${encodeURIComponent(runId)}/bug-drafts`),
    patchBugDraft: (runId, draftId, body) =>
      jsonRequest(
        `/v1/runs/${encodeURIComponent(runId)}/bug-drafts/${encodeURIComponent(draftId)}`,
        "PATCH",
        body,
      ),
    listSchedules: () => request("/v1/schedules"),
    createSchedule: (body) => jsonRequest("/v1/schedules", "POST", body),
    patchSchedule: (scheduleId, body) =>
      jsonRequest(`/v1/schedules/${encodeURIComponent(scheduleId)}`, "PATCH", body),
    deleteSchedule: (scheduleId) =>
      request(`/v1/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" }),
    runScheduleNow: (scheduleId) =>
      jsonRequest(`/v1/schedules/${encodeURIComponent(scheduleId)}/run-now`, "POST"),
    recordDiscovery: (observation) =>
      jsonRequest("/v1/discovery/observations", "POST", observation),
    downloadArtifact: (runId, artifact) =>
      request(
        `/v1/runs/${encodeURIComponent(runId)}/report?artifact=${encodeURIComponent(artifact)}`,
        { responseType: "blob", timeoutMs: 60000 },
      ),
    openEvents: (runId) => new WebSocket(
      websocketUrl(
        normalizeQcServiceUrl(getEndpoint()),
        runId,
        String(getInstallationToken() || "").trim(),
      ),
    ),
  };
}
