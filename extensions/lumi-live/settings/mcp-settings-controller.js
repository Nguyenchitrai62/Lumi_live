import { MCP_CONNECTORS } from "../core/mcp-connectors.js";

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
let connectorModalReturnFocus = null;

const MCP_PERMISSION_OPTIONS = [
  { mode: "allow", label: "Always allow", icon: "\u2713" },
  { mode: "ask", label: "Ask every time", icon: "?" },
  { mode: "block", label: "Block", icon: "\u00d7" },
];
const DEFAULT_MCP_ICON = "../icons/connectors/mcp.svg";

function setMcpIcon(container, src = DEFAULT_MCP_ICON) {
  const image = document.createElement("img");
  image.src = src;
  image.alt = "";
  image.loading = "eager";
  image.decoding = "async";
  container.replaceChildren(image);
}

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

function createMcpEnableToggle(server) {
  const label = document.createElement("label");
  label.className = "toggle-switch mcp-enable-toggle";
  label.title = server.enabled === false
    ? "Enable without reconnecting"
    : "Temporarily exclude from new agent sessions";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = server.enabled !== false;
  input.dataset.action = "toggle-server";
  input.dataset.serverId = server.id;
  input.setAttribute("aria-label", `${input.checked ? "Disable" : "Enable"} ${server.serverName || "MCP server"}`);
  const track = document.createElement("span");
  track.setAttribute("aria-hidden", "true");
  const accessible = document.createElement("span");
  accessible.className = "sr-only";
  accessible.textContent = input.checked ? "Enabled" : "Disabled";
  label.append(input, track, accessible);
  return label;
}

function renderMcpConnectors() {
  const availableConnectors = MCP_CONNECTORS.filter((connector) =>
    !mcpServers.some((server) => server.connectorId === connector.id));
  elements.mcpConnectorCatalog.hidden = availableConnectors.length === 0;
  const rows = availableConnectors.map((connector) => {
    const row = document.createElement("article");
    row.className = "mcp-connector";

    const mark = document.createElement("span");
    mark.className = "mcp-connector-mark";
    mark.setAttribute("aria-hidden", "true");
    setMcpIcon(mark, connector.icon);

    const copy = document.createElement("div");
    copy.className = "mcp-connector-copy";
    const heading = document.createElement("div");
    heading.className = "mcp-connector-heading";
    const name = document.createElement("strong");
    name.textContent = connector.name;
    const badge = document.createElement("span");
    badge.className = "mcp-connector-badge";
    badge.textContent = connector.id === "redmine" ? "URL + API key" : "Secure sign-in";
    heading.append(name, badge);

    const description = document.createElement("p");
    description.className = "mcp-connector-description";
    description.textContent = connector.description;
    copy.append(heading, description);

    const actions = document.createElement("div");
    actions.className = "mcp-connector-actions";
    const connect = document.createElement("button");
    connect.type = "button";
    connect.className = "primary mcp-connector-action";
    connect.dataset.action = "open-connector";
    connect.dataset.connectorId = connector.id;
    connect.textContent = "Connect";
    actions.append(connect);
    row.append(mark, copy, actions);
    return row;
  });
  elements.mcpConnectorList.replaceChildren(...rows);
}

function setConnectorModalStatus(state, message) {
  elements.mcpConnectorModalStatus.dataset.state = state;
  elements.mcpConnectorModalStatus.textContent = message;
}

function setConnectorRowStatus(row, state, message) {
  let status = row.querySelector(".mcp-connector-status");
  if (!status) {
    status = document.createElement("p");
    status.className = "mcp-connector-status";
    status.setAttribute("role", "status");
    row.querySelector(".mcp-connector-copy")?.append(status);
  }
  status.dataset.state = state;
  status.textContent = message;
}

function closeConnectorModal({ restoreFocus = true } = {}) {
  if (elements.confirmConnectorButton.dataset.busy === "true") return;
  elements.mcpConnectorModal.hidden = true;
  document.body.classList.remove("is-mcp-connector-modal-open");
  elements.settingsShell.inert = false;
  elements.mcpConnectorModalFields.replaceChildren();
  setConnectorModalStatus("", "");
  if (restoreFocus) connectorModalReturnFocus?.focus();
  connectorModalReturnFocus = null;
}

function openRedmineModal(returnFocus) {
  const connector = MCP_CONNECTORS.find((item) => item.id === "redmine");
  if (!connector || mcpServers.some((server) => server.connectorId === connector.id)) return;
  connectorModalReturnFocus = returnFocus || document.activeElement;
  elements.mcpConnectorModalFields.replaceChildren();

  for (const field of connector.fields) {
    const label = document.createElement("label");
    label.textContent = field.label;
    const input = document.createElement("input");
    input.type = field.type;
    input.placeholder = field.placeholder;
    input.autocomplete = field.autocomplete;
    input.spellcheck = false;
    input.required = true;
    input.name = field.name;
    label.append(input);
    elements.mcpConnectorModalFields.append(label);
  }

  elements.confirmConnectorButton.disabled = false;
  elements.cancelConnectorModalButton.disabled = false;
  elements.confirmConnectorButton.dataset.busy = "";
  setConnectorModalStatus("", "");
  elements.mcpConnectorModal.hidden = false;
  document.body.classList.add("is-mcp-connector-modal-open");
  elements.settingsShell.inert = true;
  requestAnimationFrame(() => {
    const firstInput = elements.mcpConnectorModalFields.querySelector("input");
    (firstInput || elements.confirmConnectorButton).focus();
  });
}

function getMcpServerUiState(server) {
  if (server.enabled === false) return "disabled";
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
  if (!mcpServers.some((server) => server.id === serverId && server.enabled !== false)) return;
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
  const enabledCount = mcpServers.filter((server) => server.enabled !== false).length;
  const toolCount = mcpServers
    .filter((server) => server.enabled !== false)
    .reduce((total, server) => total + (Number(server.toolCount) || 0), 0);
  elements.mcpServerCount.textContent = `${enabledCount}/${count} enabled · ${toolCount} active tools`;
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
    item.setAttribute("aria-label", server.enabled === false
      ? `${server.serverName || "MCP server"} is temporarily disabled`
      : `Open tool permissions for ${server.serverName || "MCP server"}`);

    const icon = document.createElement("span");
    icon.className = "mcp-server-icon";
    icon.setAttribute("aria-hidden", "true");
    const connector = MCP_CONNECTORS.find((candidate) => candidate.id === server.connectorId);
    setMcpIcon(icon, connector?.icon || DEFAULT_MCP_ICON);

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
      : state === "warning"
        ? "Tool warning"
        : state === "error" ? "Error" : state === "disabled" ? "Disabled" : "Saved";
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
    if (server.enabled === false) {
      metadata.append(createMcpMeta("Excluded from new agent sessions", "mcp-meta-disabled"));
    } else if (tools.length) {
      metadata.append(createMcpMeta(`${enabledToolCount} available`, "mcp-meta-available"));
    }
    if (blockedToolCount) metadata.append(createMcpMeta(`${blockedToolCount} blocked`, "mcp-meta-warning"));
    if (disabledToolCount) metadata.append(createMcpMeta(`${disabledToolCount} unavailable`, "mcp-meta-warning"));

    const error = document.createElement("p");
    error.className = "mcp-server-error";
    error.hidden = !server.uiError;
    error.textContent = server.uiError || "";
    const permissionHint = document.createElement("span");
    permissionHint.className = "mcp-server-permission-hint";
    permissionHint.textContent = server.enabled === false
      ? "Credentials kept · enable anytime"
      : "Tool permissions \u2192";
    main.append(title, url, metadata, error, permissionHint);

    const actions = document.createElement("div");
    actions.className = "mcp-server-actions";
    actions.append(createMcpEnableToggle(server));
    const reconnect = document.createElement("button");
    reconnect.type = "button";
    reconnect.dataset.action = "reconnect";
    reconnect.dataset.serverId = server.id;
    reconnect.disabled = server.enabled === false;
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
  renderMcpConnectors();
}

function setMcpServerUiState(serverId, state, error = "") {
  const server = mcpServers.find((candidate) => candidate.id === serverId);
  if (!server) return;
  server.uiState = state;
  server.uiError = error;
  renderMcpServers();
  const row = elements.mcpServerList.querySelector(`[data-server-id="${CSS.escape(serverId)}"]`);
  for (const button of row?.querySelectorAll("button") || []) button.disabled = state === "connecting";
  for (const input of row?.querySelectorAll("input") || []) input.disabled = state === "connecting";
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

async function connectRedmine(event) {
  event.preventDefault();
  const connector = MCP_CONNECTORS.find((item) => item.id === "redmine");
  if (!connector) return;
  const config = Object.fromEntries(
    [...new FormData(elements.mcpConnectorModalForm)]
      .map(([name, value]) => [name, String(value).trim()]),
  );
  elements.confirmConnectorButton.disabled = true;
  elements.cancelConnectorModalButton.disabled = true;
  elements.confirmConnectorButton.dataset.busy = "true";
  elements.confirmConnectorButton.textContent = "Checking Redmine...";
  setConnectorModalStatus("", "Validating the URL and API key...");
  try {
    const result = await sendRuntime("mcp_connect_connector", {
      connectorId: connector.id,
      config,
    });
    const server = { ...result, uiError: "" };
    server.uiState = getMcpServerUiState(server);
    mcpServers.push(server);
    renderMcpServers();
    elements.confirmConnectorButton.dataset.busy = "";
    closeConnectorModal({ restoreFocus: false });
  } catch (error) {
    elements.confirmConnectorButton.disabled = false;
    elements.cancelConnectorModalButton.disabled = false;
    elements.confirmConnectorButton.dataset.busy = "";
    elements.confirmConnectorButton.textContent = "Connect Redmine";
    setConnectorModalStatus(
      "error",
      error instanceof Error ? error.message : `Could not connect ${connector.name}.`,
    );
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

async function connectNotion(button) {
  const connector = MCP_CONNECTORS.find((item) => item.id === "notion");
  const row = button.closest(".mcp-connector");
  if (!connector || !row) return;
  button.disabled = true;
  button.dataset.busy = "true";
  button.textContent = "Opening sign in...";
  row.dataset.state = "connecting";
  setConnectorRowStatus(row, "", `Sign in to ${connector.name} in the secure Chrome window.`);
  try {
    const result = await sendRuntime("mcp_connect_connector", { connectorId: connector.id });
    const server = { ...result, uiError: "" };
    server.uiState = getMcpServerUiState(server);
    mcpServers.push(server);
    renderMcpServers();
  } catch (error) {
    button.disabled = false;
    button.dataset.busy = "";
    button.textContent = "Connect";
    row.dataset.state = "error";
    setConnectorRowStatus(
      row,
      "error",
      error instanceof Error ? error.message : `Could not connect ${connector.name}.`,
    );
  }
}

async function toggleMcpServer(serverId, enabled, control) {
  const current = mcpServers.find((server) => server.id === serverId);
  if (!current) return;
  const previousEnabled = current.enabled !== false;
  control.disabled = true;
  try {
    const result = await sendRuntime("mcp_set_server_enabled", { serverId, enabled });
    const index = mcpServers.findIndex((server) => server.id === serverId);
    if (index >= 0) {
      const server = { ...result, uiError: "" };
      server.uiState = getMcpServerUiState(server);
      mcpServers[index] = server;
    }
    renderMcpServers();
  } catch (error) {
    current.enabled = enabled ? false : previousEnabled;
    current.uiState = getMcpServerUiState(current);
    current.uiError = error instanceof Error
      ? error.message
      : "Could not change this MCP server state.";
    renderMcpServers();
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
elements.mcpConnectorList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  if (button.dataset.action === "open-connector") {
    const connector = MCP_CONNECTORS.find((item) => item.id === button.dataset.connectorId);
    if (connector?.id === "redmine") openRedmineModal(button);
    else if (connector?.id === "notion") void connectNotion(button);
  }
});
elements.mcpConnectorModalForm.addEventListener("input", () => {
  if (elements.mcpConnectorModalStatus.dataset.state === "error") {
    setConnectorModalStatus("", "");
  }
});
elements.mcpConnectorModalForm.addEventListener("submit", (event) => void connectRedmine(event));
elements.cancelConnectorModalButton.addEventListener("click", () => closeConnectorModal());
elements.mcpConnectorModal.addEventListener("click", (event) => {
  if (event.target === elements.mcpConnectorModal) closeConnectorModal();
});
elements.mcpServerList.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-action='toggle-server']");
  if (!input) return;
  void toggleMcpServer(input.dataset.serverId, input.checked, input);
});
elements.mcpServerList.addEventListener("click", (event) => {
  if (event.target.closest(".mcp-enable-toggle")) return;
  const button = event.target.closest("button[data-action]");
  if (button) {
    if (button.disabled) return;
    if (button.dataset.action === "reconnect") void reconnectMcp(button.dataset.serverId);
    if (button.dataset.action === "remove") void removeMcp(button.dataset.serverId);
    return;
  }
  const serverRow = event.target.closest(".mcp-server[data-server-id]");
  const server = mcpServers.find((item) => item.id === serverRow?.dataset.serverId);
  if (server?.enabled !== false) openMcpToolsView(server.id);
});
elements.mcpServerList.addEventListener("keydown", (event) => {
  if (event.target.closest("button, .mcp-enable-toggle")) return;
  const serverRow = event.target.closest(".mcp-server[data-server-id]");
  if (!serverRow || !["Enter", " "].includes(event.key)) return;
  const server = mcpServers.find((item) => item.id === serverRow.dataset.serverId);
  if (server?.enabled === false) return;
  event.preventDefault();
  openMcpToolsView(serverRow.dataset.serverId);
});
elements.backToMcpServersButton.addEventListener("click", closeMcpToolsView);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!elements.mcpConnectorModal.hidden) closeConnectorModal();
  else if (selectedMcpServerId) closeMcpToolsView();
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
