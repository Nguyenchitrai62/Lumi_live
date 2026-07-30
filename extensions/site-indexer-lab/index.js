import {
  buildCapabilityMarkdown,
  INDEX_STORAGE_KEY,
  RUN_STORAGE_KEY,
  safeFilename,
} from "./core.js";

const MESSAGE_SCOPE = "site-capability-indexer-lab";
const elements = {
  form: document.querySelector("#indexForm"),
  websiteUrl: document.querySelector("#websiteUrl"),
  maxStates: document.querySelector("#maxStates"),
  maxDepth: document.querySelector("#maxDepth"),
  settleMs: document.querySelector("#settleMs"),
  workerCount: document.querySelector("#workerCount"),
  keepTabOpen: document.querySelector("#keepTabOpen"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  runCard: document.querySelector("#runCard"),
  statusLabel: document.querySelector("#statusLabel"),
  statusDetail: document.querySelector("#statusDetail"),
  queueBadge: document.querySelector("#queueBadge"),
  progressTrack: document.querySelector("#progressTrack"),
  progressBar: document.querySelector("#progressBar"),
  currentUrl: document.querySelector("#currentUrl"),
  errorList: document.querySelector("#errorList"),
  resultSection: document.querySelector("#resultSection"),
  resultTitle: document.querySelector("#resultTitle"),
  resultMeta: document.querySelector("#resultMeta"),
  downloadButton: document.querySelector("#downloadButton"),
  clearButton: document.querySelector("#clearButton"),
  screenMetric: document.querySelector("#screenMetric"),
  transitionMetric: document.querySelector("#transitionMetric"),
  featureMetric: document.querySelector("#featureMetric"),
  blockedMetric: document.querySelector("#blockedMetric"),
  screenList: document.querySelector("#screenList"),
  transitionList: document.querySelector("#transitionList"),
  markdownPreview: document.querySelector("#markdownPreview"),
  viewTabs: [...document.querySelectorAll("[data-view]")],
  viewPanels: [...document.querySelectorAll("[data-panel]")],
};

let currentResult = null;
let currentView = "screens";
let currentRunStatus = "idle";
let lastResultSignature = "";
let lastRunSignature = "";
let keepAlivePort = null;

function connectKeepAlive() {
  if (keepAlivePort) return;
  const port = chrome.runtime.connect({ name: "site-indexer-dashboard" });
  keepAlivePort = port;
  port.onDisconnect.addListener(() => {
    if (keepAlivePort === port) keepAlivePort = null;
  });
}

connectKeepAlive();
const keepAliveTimerId = setInterval(() => {
  connectKeepAlive();
  try {
    keepAlivePort?.postMessage({ type: "keep_alive", at: Date.now() });
  } catch {
    keepAlivePort = null;
  }
}, 20000);

async function sendCommand(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    scope: MESSAGE_SCOPE,
    type,
    ...payload,
  });
  if (!response?.success) {
    throw new Error(response?.error || "Không thể gửi lệnh tới crawler.");
  }
  return response;
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function formatDuration(startedAt, completedAt) {
  const milliseconds = Math.max(
    0,
    new Date(completedAt || startedAt).getTime() - new Date(startedAt).getTime(),
  );
  if (!Number.isFinite(milliseconds)) return "";
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} giây`;
  return `${Math.floor(seconds / 60)} phút ${Math.round(seconds % 60)} giây`;
}

function statusCopy(status) {
  const copies = {
    running: ["Đang lập chỉ mục", "Crawler đang mở và phân tích các trạng thái an toàn."],
    completed: ["Đã hoàn tất", "Capability index đã được lưu trên thiết bị này."],
    stopped: ["Đã dừng", "Kết quả một phần vẫn được giữ lại để xem và tải xuống."],
    error: ["Có lỗi khi lập chỉ mục", "Xem chi tiết bên dưới và thử lại với phạm vi nhỏ hơn."],
  };
  return copies[status] || ["Sẵn sàng", "Nhập URL để tạo capability index đầu tiên."];
}

function renderRun(state) {
  const status = state?.status || "idle";
  const signature = [
    state?.id || "",
    status,
    state?.updatedAt || "",
    state?.queuedStates || 0,
    state?.activeWorkers || 0,
    state?.errors?.length || 0,
  ].join("|");
  if (signature === lastRunSignature) return;
  lastRunSignature = signature;
  const previousStatus = currentRunStatus;
  currentRunStatus = status;
  const [label, fallbackDetail] = statusCopy(status);
  elements.runCard.dataset.status = status;
  elements.statusLabel.textContent = label;
  elements.statusDetail.textContent = state?.currentAction || fallbackDetail;
  elements.currentUrl.textContent = state?.currentUrl || "Chưa có URL đang quét";
  elements.currentUrl.title = state?.currentUrl || "";
  const workerCount = state?.workerCount || 0;
  const activeWorkers = state?.activeWorkers || 0;
  elements.queueBadge.textContent = workerCount
    ? `${state?.queuedStates || 0} chờ · ${activeWorkers}/${workerCount} worker`
    : `${state?.queuedStates || 0} trong hàng đợi`;
  const maximum = Math.max(1, state?.maxStates || 1);
  const progress = Math.min(100, Math.round(((state?.scannedStates || 0) / maximum) * 100));
  elements.progressBar.style.width = `${progress}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(progress));
  const running = status === "running";
  elements.startButton.disabled = running;
  elements.stopButton.disabled = !running;
  elements.websiteUrl.disabled = running;
  elements.maxStates.disabled = running;
  elements.maxDepth.disabled = running;
  elements.settleMs.disabled = running;
  elements.workerCount.disabled = running;
  elements.keepTabOpen.disabled = running;
  elements.downloadButton.disabled = running;

  const errors = state?.errors || [];
  elements.errorList.hidden = errors.length === 0;
  elements.errorList.replaceChildren();
  for (const error of errors) {
    const paragraph = document.createElement("p");
    paragraph.textContent = error.context
      ? `${error.context}: ${error.message}`
      : error.message;
    elements.errorList.append(paragraph);
  }
  if (previousStatus !== status && currentView === "markdown") {
    renderActiveView();
  }
}

function createTag(text) {
  const span = document.createElement("span");
  span.className = "feature-tag";
  span.textContent = text;
  return span;
}

function renderScreens(screens) {
  elements.screenList.replaceChildren();
  for (const screen of screens) {
    const details = document.createElement("details");
    details.className = "screen-card";
    const summary = document.createElement("summary");
    const id = document.createElement("span");
    id.className = "screen-id";
    id.textContent = screen.id;
    const title = document.createElement("span");
    title.className = "screen-title";
    title.textContent = screen.title || screen.route;
    const route = document.createElement("span");
    route.className = "screen-route";
    route.textContent = screen.route;
    summary.append(id, title, route);

    const body = document.createElement("div");
    body.className = "screen-body";
    const discovery = document.createElement("p");
    discovery.className = "muted-copy";
    const scanTime = Number.isFinite(screen.scanDurationMs)
      ? ` · ${(screen.scanDurationMs / 1000).toFixed(1)} giây · ${screen.workerId || "worker"}`
      : "";
    discovery.textContent =
      `Phát hiện qua “${screen.discoveredVia}” · depth ${screen.depth}${scanTime} · fingerprint ${screen.fingerprint}`;
    body.append(discovery);

    const featureHeading = document.createElement("h3");
    featureHeading.textContent = "Tính năng an toàn đã phát hiện";
    const tags = document.createElement("div");
    tags.className = "tag-list";
    const featureNames = [...new Set([
      ...(screen.safeActions || []).map((action) => action.name),
      ...(screen.forms || []).map((form) => form.name || "Form"),
    ].filter(Boolean))];
    for (const feature of featureNames.slice(0, 40)) tags.append(createTag(feature));
    if (!featureNames.length) tags.append(createTag("Không có action read-only"));
    body.append(featureHeading, tags);

    if (screen.forms?.length) {
      const formHeading = document.createElement("h3");
      formHeading.textContent = "Form và trường dữ liệu";
      const formCopy = document.createElement("p");
      formCopy.className = "muted-copy";
      formCopy.textContent = screen.forms.map((form) => {
        const fields = (form.fields || [])
          .map((field) => field.label || field.name || field.type)
          .filter(Boolean)
          .join(", ");
        return `${form.name}: ${fields}`;
      }).join(" · ");
      body.append(formHeading, formCopy);
    }

    const safety = document.createElement("p");
    safety.className = "muted-copy";
    safety.textContent =
      `${screen.blockedActionCount || 0} control được ghi nhận nhưng không click vì chưa phân loại an toàn.`;
    body.append(safety);
    details.append(summary, body);
    elements.screenList.append(details);
  }
}

function renderTransitions(transitions) {
  elements.transitionList.replaceChildren();
  if (!transitions.length) {
    const empty = document.createElement("p");
    empty.className = "muted-copy";
    empty.textContent = "Chưa có luồng chuyển trạng thái nào được lập bản đồ.";
    elements.transitionList.append(empty);
    return;
  }
  for (const transition of transitions) {
    const row = document.createElement("article");
    row.className = "transition-row";
    const from = document.createElement("strong");
    from.textContent = transition.from;
    const action = document.createElement("span");
    action.className = "transition-action";
    action.textContent = transition.action;
    const to = document.createElement("strong");
    to.textContent = transition.to || "unresolved";
    row.append(from, action, to);
    elements.transitionList.append(row);
  }
}

function renderResult(result) {
  currentResult = result;
  elements.resultSection.hidden = !result?.screens?.length;
  if (!result?.screens?.length) return;
  const screens = result.screens || [];
  const transitions = (result.transitions || [])
    .filter((transition) => transition.from !== transition.to);
  const signature = [
    result.updatedAt || "",
    screens.length,
    transitions.length,
    result.noOpActionCount || 0,
    result.prunedActionCount || 0,
  ].join("|");
  if (signature === lastResultSignature) return;
  lastResultSignature = signature;
  const safeFeatures = screens.reduce(
    (total, screen) => total + (screen.safeActions?.length || 0) + (screen.forms?.length || 0),
    0,
  );
  const blocked = screens.reduce(
    (total, screen) => total + (screen.blockedActionCount || 0),
    0,
  );
  elements.resultTitle.textContent = result.siteTitle || "Capability index";
  const buildDuration = result.completedAt
    ? formatDuration(result.startedAt, result.completedAt)
    : "";
  elements.resultMeta.textContent =
    `${result.origin} · cập nhật ${formatDate(result.updatedAt || result.startedAt)}`
    + (buildDuration ? ` · hoàn thành trong ${buildDuration}` : "")
    + ` · ${result.noOpActionCount || 0} no-op`
    + ` · ${result.prunedActionCount || 0} nhánh lặp đã bỏ`;
  elements.screenMetric.textContent = String(screens.length);
  elements.transitionMetric.textContent = String(transitions.length);
  elements.featureMetric.textContent = String(safeFeatures);
  elements.blockedMetric.textContent = String(blocked);
  renderActiveView();
}

function renderActiveView() {
  if (!currentResult?.screens?.length) return;
  if (currentView === "screens") {
    renderScreens(currentResult.screens || []);
    return;
  }
  if (currentView === "transitions") {
    renderTransitions(
      (currentResult.transitions || [])
        .filter((transition) => transition.from !== transition.to),
    );
    return;
  }
  if (currentRunStatus === "running") {
    elements.markdownPreview.textContent =
      "Markdown sẽ được tạo khi crawler hoàn tất để không làm chậm quá trình lập chỉ mục.";
    return;
  }
  elements.markdownPreview.textContent = buildCapabilityMarkdown(currentResult);
}

function setView(view) {
  currentView = view;
  for (const tab of elements.viewTabs) {
    const active = tab.dataset.view === view;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const panel of elements.viewPanels) {
    panel.hidden = panel.dataset.panel !== view;
  }
  renderActiveView();
}

function downloadMarkdown() {
  if (!currentResult) return;
  const markdown = buildCapabilityMarkdown(currentResult);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `${safeFilename(currentResult.siteTitle || currentResult.origin)}-${date}.md`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadStoredState() {
  const stored = await chrome.storage.local.get([INDEX_STORAGE_KEY, RUN_STORAGE_KEY]);
  renderRun(stored[RUN_STORAGE_KEY] || null);
  renderResult(stored[INDEX_STORAGE_KEY] || null);
  if (stored[INDEX_STORAGE_KEY]?.startUrl && !elements.websiteUrl.value) {
    elements.websiteUrl.value = stored[INDEX_STORAGE_KEY].startUrl;
  }
  if (stored[INDEX_STORAGE_KEY]?.workerCount) {
    elements.workerCount.value = String(stored[INDEX_STORAGE_KEY].workerCount);
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await sendCommand("start", {
      url: elements.websiteUrl.value,
      options: {
        maxStates: elements.maxStates.value,
        maxDepth: elements.maxDepth.value,
        settleMs: elements.settleMs.value,
        workerCount: elements.workerCount.value,
        keepTabOpen: elements.keepTabOpen.checked,
      },
    });
    await loadStoredState();
  } catch (error) {
    renderRun({
      status: "error",
      currentAction: error instanceof Error ? error.message : "Không thể bắt đầu crawler.",
      errors: [],
    });
  }
});

elements.stopButton.addEventListener("click", async () => {
  await sendCommand("stop").catch(() => {});
  await loadStoredState();
});

elements.clearButton.addEventListener("click", async () => {
  if (!confirm("Xóa capability index đang lưu trên thiết bị này?")) return;
  try {
    await sendCommand("clear");
    currentResult = null;
    lastResultSignature = "";
    lastRunSignature = "";
    elements.resultSection.hidden = true;
    renderRun(null);
  } catch (error) {
    renderRun({
      status: "error",
      currentAction: error instanceof Error ? error.message : "Không thể xóa dữ liệu.",
      errors: [],
    });
  }
});

elements.downloadButton.addEventListener("click", downloadMarkdown);
for (const tab of elements.viewTabs) {
  tab.addEventListener("click", () => setView(tab.dataset.view));
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.scope !== MESSAGE_SCOPE || message.type !== "run_update") return;
  renderRun(message.state);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[RUN_STORAGE_KEY]) renderRun(changes[RUN_STORAGE_KEY].newValue || null);
  if (changes[INDEX_STORAGE_KEY]) renderResult(changes[INDEX_STORAGE_KEY].newValue || null);
});

void loadStoredState();

window.addEventListener("unload", () => {
  clearInterval(keepAliveTimerId);
  keepAlivePort?.disconnect();
});
