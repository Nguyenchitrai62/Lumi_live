export function createMcpPanelController({
  elements,
  getActiveMcpTools,
  getPendingToolCallIds,
  maxToolResponseChars,
  rememberCancelledToolCall,
  sendRuntime,
}) {
  const mcpActivityCards = new Map();
  const promptedMcpToolFailures = new Set();
  const pendingMcpPermissionPrompts = new Map();
  const mcpToolNoticeQueue = [];
  const mcpToolNoticeKeys = new Set();
  let currentMcpToolNotice = null;

function renderCurrentMcpToolNotice() {
  const notice = currentMcpToolNotice;
  elements.mcpToolNotice.hidden = !notice;
  if (!notice) return;
  elements.mcpToolNoticeTitle.textContent = notice.title;
  elements.mcpToolNoticeMessage.textContent = notice.message;
  elements.mcpToolNoticePrimary.textContent = notice.primaryLabel || "OK";
  elements.mcpToolNoticeSecondary.textContent = notice.secondaryLabel || "";
  elements.mcpToolNoticeSecondary.hidden = !notice.secondaryLabel;
  elements.mcpToolNoticeTertiary.textContent = notice.tertiaryLabel || "";
  elements.mcpToolNoticeTertiary.hidden = !notice.tertiaryLabel;
}

function showNextMcpToolNotice() {
  if (currentMcpToolNotice || !mcpToolNoticeQueue.length) return;
  currentMcpToolNotice = mcpToolNoticeQueue.shift();
  renderCurrentMcpToolNotice();
  currentMcpToolNotice.onShow?.();
}

function queueMcpToolNotice(notice) {
  const key = notice.key || `${notice.title}:${notice.message}`;
  if (mcpToolNoticeKeys.has(key)) return;
  mcpToolNoticeKeys.add(key);
  mcpToolNoticeQueue.push({ ...notice, key });
  showNextMcpToolNotice();
}

function dismissCurrentMcpToolNotice() {
  if (currentMcpToolNotice) mcpToolNoticeKeys.delete(currentMcpToolNotice.key);
  currentMcpToolNotice = null;
  renderCurrentMcpToolNotice();
  queueMicrotask(showNextMcpToolNotice);
}

function removeMcpToolNotice(key) {
  if (currentMcpToolNotice?.key === key) {
    mcpToolNoticeKeys.delete(key);
    currentMcpToolNotice = null;
    renderCurrentMcpToolNotice();
    queueMicrotask(showNextMcpToolNotice);
    return;
  }
  const index = mcpToolNoticeQueue.findIndex((notice) => notice.key === key);
  if (index >= 0) mcpToolNoticeQueue.splice(index, 1);
  mcpToolNoticeKeys.delete(key);
}

async function handleMcpToolNoticeAction(action) {
  const notice = currentMcpToolNotice;
  if (!notice) return;
  elements.mcpToolNoticePrimary.disabled = true;
  elements.mcpToolNoticeSecondary.disabled = true;
  elements.mcpToolNoticeTertiary.disabled = true;
  try {
    const callback = action === "primary"
      ? notice.onPrimary
      : action === "secondary" ? notice.onSecondary : notice.onTertiary;
    if (callback) await callback();
    dismissCurrentMcpToolNotice();
  } catch (error) {
    notice.title = "Could not update MCP tool";
    notice.message = error instanceof Error ? error.message : "The tool state could not be changed.";
    notice.primaryLabel = "OK";
    notice.secondaryLabel = "";
    notice.tertiaryLabel = "";
    notice.onPrimary = null;
    notice.onSecondary = null;
    notice.onTertiary = null;
    renderCurrentMcpToolNotice();
  } finally {
    elements.mcpToolNoticePrimary.disabled = false;
    elements.mcpToolNoticeSecondary.disabled = false;
    elements.mcpToolNoticeTertiary.disabled = false;
  }
}

function notifyInvalidMcpSchemas(mcpInfo) {
  for (const server of mcpInfo?.servers || []) {
    if (!server.error) continue;
    queueMcpToolNotice({
      key: `server-connect:${server.id}:${server.error}`,
      title: `MCP server unavailable: ${server.serverName || "MCP server"}`,
      message: `${String(server.error).slice(0, 300)} Its tools were skipped; voice, chat, and tools from other servers will continue normally.`,
      primaryLabel: "OK",
    });
  }
  const invalidTools = (mcpInfo?.servers || []).flatMap((server) =>
    (server.tools || [])
      .filter((tool) => !tool.gemini?.enabled && tool.gemini?.disabledSource === "schema")
      .map((tool) => `${server.serverName || "MCP server"} / ${tool.name || "unnamed tool"}`));
  if (!invalidTools.length) return;
  const visibleNames = invalidTools.slice(0, 3).join(", ");
  const remaining = invalidTools.length > 3 ? ` and ${invalidTools.length - 3} more` : "";
  queueMcpToolNotice({
    key: `invalid-schemas:${invalidTools.join("|")}`,
    title: `${invalidTools.length} incompatible MCP tool${invalidTools.length === 1 ? "" : "s"} disabled`,
    message: `${visibleNames}${remaining} cannot be declared safely to Gemini. Lumi disabled only those tools; voice, chat, and other tools will continue normally.`,
    primaryLabel: "OK",
  });
}

function promptToDisableFailedMcpTool(tool, error) {
  const message = error instanceof Error ? error.message : "MCP tool call failed.";
  if (error?.name === "McpPermissionDeniedError"
    || /temporarily disabled|disabled for the rest of this session|blocked in Lumi Settings|requires user approval/i.test(message)) return;
  const key = `${tool.serverId}\u0000${tool.toolName}`;
  if (promptedMcpToolFailures.has(key)) return;
  promptedMcpToolFailures.add(key);
  queueMcpToolNotice({
    key: `runtime-failure:${key}`,
    title: `MCP tool failed: ${tool.toolName}`,
    message: `${tool.serverName} returned an error: ${message.slice(0, 260)} Block this tool persistently in Settings?`,
    primaryLabel: "Block tool",
    secondaryLabel: "Keep enabled",
    onPrimary: async () => {
      await sendRuntime("mcp_set_tool_policy", {
        serverId: tool.serverId,
        tool: tool.toolName,
        mode: "block",
      });
      tool.permission = "block";
      tool.disabled = true;
    },
  });
}

function requestMcpToolPermission(tool, args, callId) {
  const noticeKey = `tool-permission:${callId}`;
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    const finish = (allowed, fromAction = false) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      pendingMcpPermissionPrompts.delete(noticeKey);
      if (!fromAction) removeMcpToolNotice(noticeKey);
      resolve(allowed);
    };
    pendingMcpPermissionPrompts.set(noticeKey, () => finish(false));
    queueMcpToolNotice({
      key: noticeKey,
      title: `Allow MCP tool: ${tool.toolName}?`,
      message: `${tool.serverName} wants to run this tool with: ${formatMcpActivityValue(args).slice(0, 260)}`,
      primaryLabel: "Allow once",
      secondaryLabel: "Deny",
      tertiaryLabel: "Always allow",
      onShow: () => {
        const activity = mcpActivityCards.get(callId);
        if (activity) {
          activity.root.dataset.state = "waiting";
          activity.status.textContent = "Awaiting approval";
        }
        timeoutId = setTimeout(() => finish(false), 45000);
      },
      onPrimary: () => {
        const activity = mcpActivityCards.get(callId);
        if (activity) {
          activity.root.dataset.state = "running";
          activity.status.textContent = "Running";
        }
        finish(true, true);
      },
      onSecondary: () => finish(false, true),
      onTertiary: async () => {
        await sendRuntime("mcp_set_tool_policy", {
          serverId: tool.serverId,
          tool: tool.toolName,
          mode: "allow",
        });
        tool.permission = "allow";
        const activity = mcpActivityCards.get(callId);
        if (activity) {
          activity.root.dataset.state = "running";
          activity.status.textContent = "Running · Always allowed";
        }
        finish(true, true);
      },
    });
  });
}

function cancelPendingMcpPermissionPrompts() {
  for (const cancel of [...pendingMcpPermissionPrompts.values()]) cancel();
  pendingMcpPermissionPrompts.clear();
}

function applyMcpToolPolicies(records) {
  const policies = new Map((Array.isArray(records) ? records : [])
    .filter((record) => record
      && typeof record.serverId === "string"
      && typeof record.toolName === "string"
      && ["block", "allow", "ask"].includes(record.mode))
    .map((record) => [`${record.serverId}\u0000${record.toolName}`, record.mode]));
  for (const tool of getActiveMcpTools().values()) {
    tool.permission = policies.get(`${tool.serverId}\u0000${tool.toolName}`) || "allow";
  }
}

function normalizeMcpToolResult(result) {
  let normalized;
  if (!result || typeof result !== "object") normalized = { result };
  else if (Object.hasOwn(result, "structuredContent")) {
    normalized = { isError: result.isError === true, data: result.structuredContent };
  } else {
    normalized = {
      isError: result.isError === true,
      content: Array.isArray(result.content) ? result.content : result,
    };
  }

  const serialized = JSON.stringify(normalized);
  if (serialized.length <= maxToolResponseChars) return normalized;
  return {
    isError: normalized.isError === true,
    truncated: true,
    message: "The MCP result exceeded Lumi's safe Live API payload limit and was truncated.",
    content: serialized.slice(0, maxToolResponseChars),
  };
}

function formatMcpActivityValue(value) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (!text) return "No data returned.";
  const limit = 24000;
  return text.length > limit ? `${text.slice(0, limit)}\n\n... UI preview truncated ...` : text;
}

function formatMcpDuration(milliseconds) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function createMcpActivityCard(callId, tool, args) {
  const root = document.createElement("details");
  root.className = "mcp-activity";
  root.dataset.state = "running";

  const summary = document.createElement("summary");
  const icon = document.createElement("span");
  icon.className = "mcp-activity-icon";
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "mcp-activity-copy";
  const label = document.createElement("small");
  label.textContent = tool.activityLabel || "MCP TOOL";
  const name = document.createElement("strong");
  name.textContent = tool.toolName;
  copy.append(label, name);
  const status = document.createElement("span");
  status.className = "mcp-activity-status";
  status.setAttribute("role", "status");
  status.textContent = "Running";
  const chevron = document.createElement("span");
  chevron.className = "mcp-activity-chevron";
  chevron.setAttribute("aria-hidden", "true");
  summary.append(icon, copy, status, chevron);

  const body = document.createElement("div");
  body.className = "mcp-activity-body";
  const metadata = document.createElement("dl");
  metadata.className = "mcp-activity-meta";
  for (const [term, value] of [
    ["Server", tool.serverName],
    ["Started", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })],
    ["Duration", "Running"],
  ]) {
    const item = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    item.append(dt, dd);
    metadata.append(item);
  }

  const argsSection = document.createElement("section");
  const argsLabel = document.createElement("span");
  argsLabel.textContent = "Arguments";
  const argsPre = document.createElement("pre");
  argsPre.textContent = formatMcpActivityValue(args || {});
  argsSection.append(argsLabel, argsPre);

  const resultSection = document.createElement("section");
  resultSection.hidden = true;
  const resultLabel = document.createElement("span");
  resultLabel.textContent = "Result";
  const resultPre = document.createElement("pre");
  resultSection.append(resultLabel, resultPre);
  body.append(metadata, argsSection, resultSection);
  root.append(summary, body);
  elements.transcript.append(root);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;

  const activity = {
    root,
    status,
    duration: metadata.querySelector("div:last-child dd"),
    resultSection,
    resultLabel,
    resultPre,
    startedAt: Date.now(),
  };
  mcpActivityCards.set(callId, activity);
  return activity;
}

function finishMcpActivity(callId, state, value) {
  const activity = mcpActivityCards.get(callId);
  if (!activity) return;
  const labels = { completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
  activity.root.dataset.state = state;
  activity.status.textContent = labels[state] || state;
  activity.duration.textContent = formatMcpDuration(Date.now() - activity.startedAt);
  activity.resultLabel.textContent = state === "failed" ? "Error" : state === "cancelled" ? "Cancellation" : "Result";
  activity.resultPre.textContent = formatMcpActivityValue(value);
  activity.resultSection.hidden = false;
  mcpActivityCards.delete(callId);
}

function cancelPendingMcpActivities(message = "Gemini cancelled this tool call because the current turn was interrupted.") {
  for (const id of getPendingToolCallIds()) {
    rememberCancelledToolCall(id);
    finishMcpActivity(id, "cancelled", message);
  }
}

  return {
    applyMcpToolPolicies,
    cancelPendingMcpActivities,
    cancelPendingMcpPermissionPrompts,
    createMcpActivityCard,
    finishMcpActivity,
    handleMcpToolNoticeAction,
    normalizeMcpToolResult,
    notifyInvalidMcpSchemas,
    promptToDisableFailedMcpTool,
    requestMcpToolPermission,
    resetSessionFailures: () => promptedMcpToolFailures.clear(),
  };
}
