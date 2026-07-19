export function createMcpSettingsController({
  elements,
  sendRuntime,
  MCP_DISABLED_TOOLS_STORAGE_KEY,
  MCP_TOOL_POLICIES_STORAGE_KEY,
}) {
let mcpServers = [];
let selectedMcpServerId = null;
let currentMcpToolAlertSignature = "";
let dismissedMcpToolAlertSignature = "";

const MCP_PERMISSION_OPTIONS = [
  { mode: "allow", label: "Always allow", icon: "\u2713" },
  { mode: "ask", label: "Ask every time", icon: "?" },
  { mode: "block", label: "Block", icon: "\u00d7" },
];

function setMcpStatus(state, message) {
  elements.mcpStatus.dataset.state = state;
  elements.mcpStatus.textContent = message;
}

function toggleMcpAddForm(shouldOpen) {
  elements.mcpAddForm.hidden = !shouldOpen;
  elements.showAddMcpButton.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) {
    requestAnimationFrame(() => elements.mcpUrlInput.focus());
    return;
  }
  elements.mcpUrlInput.value = "";
  elements.connectMcpButton.disabled = true;
  elements.connectMcpButton.dataset.busy = "";
  elements.connectMcpButton.textContent = "Connect server";
  setMcpStatus("", "");
}

function createMcpMeta(text, className = "") {
  const item = document.createElement("span");
  item.className = className;
  item.textContent = text;
  return item;
}

function getMcpServerUiState(server) {
  if (server.error || server.uiError) return "error";
  if ((server.tools || []).some((tool) => !tool.gemini?.enabled)) return "warning";
  return "connected";
}

function updateMcpToolAlert() {
  const disabledTools = mcpServers.flatMap((server) =>
    (server.tools || [])
      .filter((tool) => !tool.gemini?.enabled)
      .map((tool) => ({ server, tool })));
  currentMcpToolAlertSignature = disabledTools
    .map(({ server, tool }) => `${server.id}:${tool.name}:${tool.gemini?.errors?.join(" ") || "disabled"}`)
    .sort()
    .join("|");
  if (!disabledTools.length) dismissedMcpToolAlertSignature = "";
  const shouldShow = disabledTools.length > 0
    && currentMcpToolAlertSignature !== dismissedMcpToolAlertSignature;
  elements.mcpToolAlert.hidden = !shouldShow;
  if (!shouldShow) return;
  const schemaErrorCount = disabledTools.filter(({ tool }) => !tool.gemini?.schemaCompatible).length;
  elements.mcpToolAlertMessage.textContent = schemaErrorCount
    ? `${disabledTools.length} tool(s) are disabled; ${schemaErrorCount} have schemas Gemini cannot use. Voice, chat, and the other tools remain available.`
    : `${disabledTools.length} tool(s) are currently disabled. Voice, chat, and the other tools remain available.`;
}

function normalizeMcpPermission(mode) {
  return ["block", "allow", "ask"].includes(mode) ? mode : "allow";
}

function createMcpPermissionButton(serverId, toolName, option, selected) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mcp-permission-icon";
  button.dataset.mode = option.mode;
  button.dataset.action = "set-tool-policy";
  button.dataset.serverId = serverId;
  button.dataset.toolName = toolName;
  button.textContent = option.icon;
  button.title = option.label;
  button.setAttribute("aria-label", `${option.label} for ${toolName}`);
  button.setAttribute("aria-pressed", String(selected));
  return button;
}

function renderMcpToolsView() {
  const server = mcpServers.find((item) => item.id === selectedMcpServerId);
  if (!server) {
    selectedMcpServerId = null;
    document.body.classList.remove("is-mcp-tools-view");
    elements.settingsShell.inert = false;
    elements.mcpToolsView.inert = true;
    elements.mcpToolsView.setAttribute("aria-hidden", "true");
    elements.mcpBulkPermissionOptions.replaceChildren();
    elements.mcpToolPermissionList.replaceChildren();
    return;
  }

  const tools = Array.isArray(server.tools) ? server.tools : [];
  elements.mcpToolsViewTitle.textContent = server.serverName || "MCP server";
  elements.mcpToolsViewSubtitle.textContent = `${tools.length} ${tools.length === 1 ? "tool" : "tools"} · Choose what Lumi may use.`;

  const permissions = new Set(tools.map((tool) => normalizeMcpPermission(tool.permission)));
  const aggregateMode = permissions.size === 1 ? [...permissions][0] : "custom";
  const bulkOptions = [
    ...MCP_PERMISSION_OPTIONS,
    { mode: "custom", label: "Custom", icon: "◐" },
  ];
  const bulkButtons = bulkOptions.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mcp-bulk-option";
    button.dataset.mode = option.mode;
    if (option.mode !== "custom") button.dataset.action = "set-all-tool-policies";
    button.disabled = option.mode === "custom";
    button.setAttribute("aria-pressed", String(aggregateMode === option.mode));
    button.title = option.mode === "custom"
      ? "Tools use a mix of permissions"
      : `Set all tools to ${option.label}`;
    const icon = document.createElement("span");
    icon.className = "mcp-bulk-option-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = option.icon;
    const label = document.createElement("span");
    label.textContent = option.label;
    button.append(icon, label);
    return button;
  });
  elements.mcpBulkPermissionOptions.replaceChildren(...bulkButtons);

  const rows = tools.map((tool) => {
    const permission = normalizeMcpPermission(tool.permission);
    const row = document.createElement("article");
    row.className = "mcp-permission-row";
    row.dataset.state = tool.gemini?.enabled === true ? permission : "disabled";
    row.setAttribute("role", "listitem");

    const copy = document.createElement("div");
    copy.className = "mcp-permission-copy";
    const name = document.createElement("code");
    name.textContent = tool.name || "Unnamed tool";
    copy.append(name);
    if (tool.description) {
      const description = document.createElement("p");
      description.className = "mcp-tool-description";
      description.textContent = tool.description;
      copy.append(description);
    }
    const errors = Array.isArray(tool.gemini?.errors) ? tool.gemini.errors : [];
    if (errors.length) {
      const warning = document.createElement("p");
      warning.className = "mcp-tool-warning";
      warning.textContent = errors.join(" ");
      copy.append(warning);
    }
    const controls = document.createElement("div");
    controls.className = "mcp-permission-icons";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", `Permission for ${tool.name || "unnamed tool"}`);
    for (const option of MCP_PERMISSION_OPTIONS) {
      controls.append(createMcpPermissionButton(server.id, tool.name, option, permission === option.mode));
    }
    row.append(copy, controls);
    return row;
  });

  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "mcp-tools-empty";
    empty.textContent = "This server did not publish any tools.";
    rows.push(empty);
  }
  elements.mcpToolPermissionList.replaceChildren(...rows);
}

function openMcpToolsView(serverId) {
  if (!mcpServers.some((server) => server.id === serverId)) return;
  selectedMcpServerId = serverId;
  renderMcpToolsView();
  elements.mcpToolsView.scrollTop = 0;
  document.body.classList.add("is-mcp-tools-view");
  elements.settingsShell.inert = true;
  elements.mcpToolsView.inert = false;
  elements.backToMcpServersButton.disabled = false;
  elements.mcpToolsView.setAttribute("aria-hidden", "false");
  window.setTimeout(() => elements.backToMcpServersButton.focus(), 260);
}

function closeMcpToolsView() {
  const previousServerId = selectedMcpServerId;
  selectedMcpServerId = null;
  document.body.classList.remove("is-mcp-tools-view");
  elements.settingsShell.inert = false;
  elements.mcpToolsView.inert = true;
  elements.mcpToolsView.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    const serverRow = previousServerId
      ? elements.mcpServerList.querySelector(`[data-server-id="${CSS.escape(previousServerId)}"]`)
      : null;
    serverRow?.focus();
  }, 260);
}

function renderMcpServers() {
  const count = mcpServers.length;
  const toolCount = mcpServers.reduce((total, server) => total + (Number(server.toolCount) || 0), 0);
  elements.mcpServerCount.textContent = `${count} ${count === 1 ? "server" : "servers"} · ${toolCount} tools`;
  elements.mcpEmptyState.hidden = count > 0;
  elements.mcpServerList.replaceChildren();

  for (const server of mcpServers) {
    const item = document.createElement("article");
    const state = server.uiState || getMcpServerUiState(server);
    item.className = "mcp-server";
    item.dataset.serverId = server.id;
    item.dataset.state = state;
    item.setAttribute("role", "listitem");
    item.tabIndex = 0;
    item.setAttribute("aria-label", `Open tool permissions for ${server.serverName || "MCP server"}`);

    const icon = document.createElement("span");
    icon.className = "mcp-server-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "MCP";

    const main = document.createElement("div");
    main.className = "mcp-server-main";
    const title = document.createElement("div");
    title.className = "mcp-server-title";
    const name = document.createElement("strong");
    name.textContent = server.serverName || "MCP server";
    const status = document.createElement("span");
    status.className = "mcp-server-status";
    status.textContent = state === "connected"
      ? "Connected"
      : state === "warning" ? "Tool warning" : state === "error" ? "Error" : "Saved";
    title.append(name, status);

    const url = document.createElement("code");
    url.className = "mcp-server-url";
    url.title = server.url;
    url.textContent = server.url;

    const metadata = document.createElement("div");
    metadata.className = "mcp-server-meta";
    const tools = Array.isArray(server.tools) ? server.tools : [];
    const enabledToolCount = tools.filter((tool) => tool.gemini?.enabled).length;
    const disabledToolCount = tools.filter((tool) => !tool.gemini?.enabled).length;
    const blockedToolCount = tools.filter((tool) => tool.permission === "block").length;
    metadata.append(createMcpMeta(`${Number(server.toolCount) || 0} tools`, "mcp-meta-count"));
    if (tools.length) metadata.append(createMcpMeta(`${enabledToolCount} available`, "mcp-meta-available"));
    if (blockedToolCount) metadata.append(createMcpMeta(`${blockedToolCount} blocked`, "mcp-meta-warning"));
    if (disabledToolCount) metadata.append(createMcpMeta(`${disabledToolCount} unavailable`, "mcp-meta-warning"));

    const error = document.createElement("p");
    error.className = "mcp-server-error";
    error.hidden = !server.uiError;
    error.textContent = server.uiError || "";
    const permissionHint = document.createElement("span");
    permissionHint.className = "mcp-server-permission-hint";
    permissionHint.textContent = "Tool permissions \u2192";
    main.append(title, url, metadata, error, permissionHint);

    const actions = document.createElement("div");
    actions.className = "mcp-server-actions";
    const reconnect = document.createElement("button");
    reconnect.type = "button";
    reconnect.dataset.action = "reconnect";
    reconnect.dataset.serverId = server.id;
    reconnect.textContent = "Reconnect";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.dataset.action = "remove";
    remove.dataset.serverId = server.id;
    remove.textContent = "Remove";
    actions.append(reconnect, remove);
    item.append(icon, main, actions);
    elements.mcpServerList.append(item);
  }
  updateMcpToolAlert();
  renderMcpToolsView();
}

function setMcpServerUiState(serverId, state, error = "") {
  const server = mcpServers.find((candidate) => candidate.id === serverId);
  if (!server) return;
  server.uiState = state;
  server.uiError = error;
  renderMcpServers();
  const row = elements.mcpServerList.querySelector(`[data-server-id="${CSS.escape(serverId)}"]`);
  for (const button of row?.querySelectorAll("button") || []) button.disabled = state === "connecting";
  if (state === "connecting") row.querySelector(".mcp-server-status").textContent = "Connecting";
}

async function connectMcp(event) {
  event.preventDefault();
  const url = elements.mcpUrlInput.value.trim();
  if (!url) {
    setMcpStatus("error", "Enter an MCP server URL before connecting.");
    elements.mcpUrlInput.focus();
    return;
  }

  elements.connectMcpButton.disabled = true;
  elements.connectMcpButton.dataset.busy = "true";
  elements.connectMcpButton.textContent = "Connecting...";
  setMcpStatus("", "Running the MCP handshake and loading tools...");
  try {
    const result = await sendRuntime("mcp_add_server", { url });
    const server = { ...result, uiError: "" };
    server.uiState = getMcpServerUiState(server);
    mcpServers.push(server);
    renderMcpServers();
    toggleMcpAddForm(false);
  } catch (error) {
    setMcpStatus("error", error instanceof Error ? error.message : "Could not connect to the MCP server.");
  } finally {
    elements.connectMcpButton.dataset.busy = "";
    elements.connectMcpButton.textContent = "Connect server";
    elements.connectMcpButton.disabled = !elements.mcpUrlInput.value.trim();
  }
}

async function reconnectMcp(serverId) {
  setMcpServerUiState(serverId, "connecting");
  try {
    const result = await sendRuntime("mcp_reconnect_server", { serverId });
    const index = mcpServers.findIndex((server) => server.id === serverId);
    if (index >= 0) {
      const server = { ...result, uiError: "" };
      server.uiState = getMcpServerUiState(server);
      mcpServers[index] = server;
    }
    renderMcpServers();
  } catch (error) {
    setMcpServerUiState(
      serverId,
      "error",
      error instanceof Error ? error.message : "Could not reconnect to this MCP server.",
    );
  }
}

async function removeMcp(serverId) {
  setMcpServerUiState(serverId, "connecting");
  try {
    await sendRuntime("mcp_remove_server", { serverId });
    mcpServers = mcpServers.filter((server) => server.id !== serverId);
    renderMcpServers();
  } catch (error) {
    setMcpServerUiState(
      serverId,
      "error",
      error instanceof Error ? error.message : "Could not remove this MCP server.",
    );
  }
}

async function setMcpToolPolicy(serverId, toolName, mode, control) {
  control.disabled = true;
  try {
    await sendRuntime("mcp_set_tool_policy", { serverId, tool: toolName, mode });
    const server = mcpServers.find((item) => item.id === serverId);
    const tool = server?.tools?.find((item) => item.name === toolName);
    if (tool) tool.permission = mode;
    renderMcpServers();
  } catch (error) {
    setMcpServerUiState(
      serverId,
      "error",
      error instanceof Error ? error.message : "Could not update this MCP tool permission.",
    );
  } finally {
    control.disabled = false;
  }
}

async function setAllMcpToolPolicies(serverId, mode, control) {
  const controls = [...elements.mcpToolsView.querySelectorAll("button[data-action]")];
  for (const button of controls) button.disabled = true;
  try {
    await sendRuntime("mcp_set_server_tool_policy", { serverId, mode });
    const server = mcpServers.find((item) => item.id === serverId);
    for (const tool of server?.tools || []) tool.permission = mode;
    renderMcpServers();
  } catch (error) {
    setMcpServerUiState(
      serverId,
      "error",
      error instanceof Error ? error.message : "Could not update all MCP tool permissions.",
    );
  } finally {
    for (const button of controls) button.disabled = false;
    control.disabled = false;
  }
}

async function loadMcpServers(refresh = false) {
  const result = await sendRuntime(refresh ? "mcp_get_tools" : "mcp_inspect_tools");
  mcpServers = (result.servers || []).map((server) => {
    const item = { ...server, uiError: server.error || "" };
    item.uiState = getMcpServerUiState(item);
    return item;
  });
  renderMcpServers();
}

elements.showAddMcpButton.addEventListener("click", () => {
  toggleMcpAddForm(elements.mcpAddForm.hidden);
});
elements.cancelAddMcpButton.addEventListener("click", () => toggleMcpAddForm(false));
elements.mcpUrlInput.addEventListener("input", () => {
  elements.connectMcpButton.disabled = !elements.mcpUrlInput.value.trim()
    || elements.connectMcpButton.dataset.busy === "true";
  if (elements.mcpStatus.dataset.state === "error") setMcpStatus("", "");
});
elements.mcpAddForm.addEventListener("submit", (event) => void connectMcp(event));
elements.mcpServerList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) {
    if (button.disabled) return;
    if (button.dataset.action === "reconnect") void reconnectMcp(button.dataset.serverId);
    if (button.dataset.action === "remove") void removeMcp(button.dataset.serverId);
    return;
  }
  const serverRow = event.target.closest(".mcp-server[data-server-id]");
  if (serverRow) openMcpToolsView(serverRow.dataset.serverId);
});
elements.mcpServerList.addEventListener("keydown", (event) => {
  if (event.target.closest("button")) return;
  const serverRow = event.target.closest(".mcp-server[data-server-id]");
  if (!serverRow || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  openMcpToolsView(serverRow.dataset.serverId);
});
elements.backToMcpServersButton.addEventListener("click", closeMcpToolsView);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && selectedMcpServerId) closeMcpToolsView();
});
elements.mcpToolsView.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  if (button.dataset.action === "set-tool-policy") {
    void setMcpToolPolicy(
      button.dataset.serverId,
      button.dataset.toolName,
      button.dataset.mode,
      button,
    );
  }
  if (button.dataset.action === "set-all-tool-policies") {
    void setAllMcpToolPolicies(selectedMcpServerId, button.dataset.mode, button);
  }
});
elements.dismissMcpToolAlertButton.addEventListener("click", () => {
  dismissedMcpToolAlertSignature = currentMcpToolAlertSignature;
  elements.mcpToolAlert.hidden = true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const disabledToolsChanged = areaName === "session" && changes[MCP_DISABLED_TOOLS_STORAGE_KEY];
  const policiesChanged = areaName === "local" && changes[MCP_TOOL_POLICIES_STORAGE_KEY];
  if (!disabledToolsChanged && !policiesChanged) return;
  void loadMcpServers().catch(() => {});
});

  return {
    load: loadMcpServers,
    setStatus: setMcpStatus,
    showAddForm: toggleMcpAddForm,
  };
}
