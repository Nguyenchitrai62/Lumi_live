import { STORAGE_KEYS } from "../core/extension-config.js";
import { getMcpConnector } from "../core/mcp-connectors.js";
import { prepareGeminiMcpTool } from "../mcp/gemini-tool-schema.js";
import { McpHttpClient, normalizeMcpUrl } from "../mcp/client.js";
import { createMcpConnectorAuth } from "./mcp-connector-auth.js";
import { normalizeRedmineBaseUrl, RedmineMcpClient } from "./redmine-mcp-client.js";

const MCP_URL_STORAGE_KEY = STORAGE_KEYS.legacyMcpUrl;
const MCP_SERVERS_STORAGE_KEY = STORAGE_KEYS.mcpServers;
const MCP_DISABLED_TOOLS_STORAGE_KEY = STORAGE_KEYS.mcpDisabledTools;
const MCP_TOOL_POLICIES_STORAGE_KEY = STORAGE_KEYS.mcpToolPolicies;
const DEFAULT_MCP_TOOL_POLICY = "allow";

export function createMcpService() {
  const mcpConnections = new Map();
  const activeMcpCallControllers = new Set();
  const connectorAuth = createMcpConnectorAuth();

function cancelActiveMcpCalls() {
  const controllers = [...activeMcpCallControllers];
  for (const controller of controllers) controller.abort();
  return { cancelled: controllers.length > 0, count: controllers.length };
}

function fallbackMcpServerName(url) {
  try {
    return new URL(url).hostname || "MCP server";
  } catch {
    return "MCP server";
  }
}

function normalizeMcpServerRecord(value) {
  if (!value || typeof value !== "object") return null;
  const connectorId = typeof value.connectorId === "string" && getMcpConnector(value.connectorId)
    ? value.connectorId
    : "";
  let url;
  try {
    url = connectorId === "redmine"
      ? normalizeRedmineBaseUrl(value.url)
      : normalizeMcpUrl(value.url);
  } catch {
    return null;
  }
  return {
    id: typeof value.id === "string" && value.id ? value.id : crypto.randomUUID(),
    url,
    connectorId,
    enabled: value.enabled !== false,
    serverName: typeof value.serverName === "string" && value.serverName
      ? value.serverName.slice(0, 160)
      : fallbackMcpServerName(url),
    serverVersion: typeof value.serverVersion === "string" ? value.serverVersion.slice(0, 80) : "",
    protocolVersion: typeof value.protocolVersion === "string" ? value.protocolVersion.slice(0, 40) : "",
    toolCount: Number.isInteger(value.toolCount) && value.toolCount >= 0 ? value.toolCount : 0,
  };
}

async function loadMcpServerRecords() {
  const stored = await chrome.storage.local.get([MCP_SERVERS_STORAGE_KEY, MCP_URL_STORAGE_KEY]);
  const storedList = stored[MCP_SERVERS_STORAGE_KEY];
  const source = Array.isArray(storedList) ? storedList : [];
  if (!Array.isArray(storedList) && stored[MCP_URL_STORAGE_KEY]) {
    source.push({ url: stored[MCP_URL_STORAGE_KEY] });
  }

  const records = [];
  const urls = new Set();
  const ids = new Set();
  for (const candidate of source) {
    const record = normalizeMcpServerRecord(candidate);
    if (!record || urls.has(record.url)) continue;
    while (ids.has(record.id)) record.id = crypto.randomUUID();
    urls.add(record.url);
    ids.add(record.id);
    records.push(record);
  }

  const needsMigration = !Array.isArray(storedList)
    || JSON.stringify(storedList) !== JSON.stringify(records)
    || Object.hasOwn(stored, MCP_URL_STORAGE_KEY);
  if (needsMigration) {
    await chrome.storage.local.set({ [MCP_SERVERS_STORAGE_KEY]: records });
    await chrome.storage.local.remove(MCP_URL_STORAGE_KEY);
  }
  return records;
}

async function saveMcpServerRecords(records) {
  await chrome.storage.local.set({ [MCP_SERVERS_STORAGE_KEY]: records });
  await chrome.storage.local.remove(MCP_URL_STORAGE_KEY);
}

function recordFromMcpConnection(connection) {
  return {
    id: connection.id,
    url: connection.url,
    connectorId: connection.connectorId || "",
    enabled: connection.enabled !== false,
    serverName: connection.client.serverInfo?.name || fallbackMcpServerName(connection.url),
    serverVersion: connection.client.serverInfo?.version || "",
    protocolVersion: connection.client.protocolVersion || "",
    toolCount: connection.tools.length,
  };
}

function disabledMcpToolKey(serverId, toolName) {
  return `${serverId}\u0000${toolName}`;
}

async function loadMcpToolPolicies() {
  const stored = await chrome.storage.local.get(MCP_TOOL_POLICIES_STORAGE_KEY);
  const records = Array.isArray(stored[MCP_TOOL_POLICIES_STORAGE_KEY])
    ? stored[MCP_TOOL_POLICIES_STORAGE_KEY]
    : [];
  return new Map(records
    .filter((record) => record
      && typeof record.serverId === "string"
      && typeof record.toolName === "string"
      && ["block", "allow", "ask"].includes(record.mode))
    .map((record) => [disabledMcpToolKey(record.serverId, record.toolName), record]));
}

async function saveMcpToolPolicies(policies) {
  await chrome.storage.local.set({
    [MCP_TOOL_POLICIES_STORAGE_KEY]: [...policies.values()],
  });
}

async function setMcpToolPolicy(serverId, toolName, mode) {
  if (typeof serverId !== "string" || !serverId || typeof toolName !== "string" || !toolName) {
    throw new Error("A valid MCP server and tool are required.");
  }
  if (!["block", "allow", "ask"].includes(mode)) {
    throw new Error("MCP tool permission must be block, allow, or ask.");
  }
  const policies = await loadMcpToolPolicies();
  policies.set(disabledMcpToolKey(serverId, toolName), { serverId, toolName, mode });
  await saveMcpToolPolicies(policies);
  return { serverId, toolName, mode };
}

async function setMcpServerToolPolicy(serverId, mode) {
  if (typeof serverId !== "string" || !serverId) {
    throw new Error("A valid MCP server is required.");
  }
  if (!["block", "allow", "ask"].includes(mode)) {
    throw new Error("MCP tool permission must be block, allow, or ask.");
  }
  const records = await loadMcpServerRecords();
  const record = records.find((item) => item.id === serverId);
  if (!record) throw new Error("That MCP server is no longer in your list.");
  if (record.enabled === false) {
    throw new Error("Enable this MCP server before changing its tool permissions.");
  }
  const connection = await connectMcpRecord(record);
  const policies = await loadMcpToolPolicies();
  let updatedCount = 0;
  for (const tool of connection.tools) {
    const toolName = typeof tool?.name === "string" ? tool.name : "";
    if (!toolName) continue;
    policies.set(disabledMcpToolKey(serverId, toolName), { serverId, toolName, mode });
    updatedCount += 1;
  }
  await saveMcpToolPolicies(policies);
  return { serverId, mode, updatedCount };
}

async function clearMcpToolPolicies(serverId) {
  const policies = await loadMcpToolPolicies();
  let changed = false;
  for (const [key, record] of policies) {
    if (record.serverId !== serverId) continue;
    policies.delete(key);
    changed = true;
  }
  if (changed) await saveMcpToolPolicies(policies);
}

async function loadDisabledMcpTools() {
  const stored = await chrome.storage.session.get(MCP_DISABLED_TOOLS_STORAGE_KEY);
  const records = Array.isArray(stored[MCP_DISABLED_TOOLS_STORAGE_KEY])
    ? stored[MCP_DISABLED_TOOLS_STORAGE_KEY]
    : [];
  return new Map(records
    .filter((record) => record && typeof record.serverId === "string" && typeof record.toolName === "string")
    .map((record) => [disabledMcpToolKey(record.serverId, record.toolName), record]));
}

async function saveDisabledMcpTools(disabledTools) {
  await chrome.storage.session.set({
    [MCP_DISABLED_TOOLS_STORAGE_KEY]: [...disabledTools.values()],
  });
}

async function disableMcpTool(serverId, toolName, reason, source = "manual") {
  if (typeof serverId !== "string" || !serverId || typeof toolName !== "string" || !toolName) {
    throw new Error("A valid MCP server and tool are required.");
  }
  const disabledSource = ["gemini_setup", "runtime_user", "settings"].includes(source)
    ? source
    : "manual";
  const disabledTools = await loadDisabledMcpTools();
  disabledTools.set(disabledMcpToolKey(serverId, toolName), {
    serverId,
    toolName,
    reason: String(reason || "Gemini Live rejected this tool declaration.").slice(0, 1200),
    source: disabledSource,
    disabledAt: Date.now(),
  });
  await saveDisabledMcpTools(disabledTools);
  return { disabled: true, serverId, toolName, source: disabledSource };
}

async function enableMcpTool(serverId, toolName) {
  if (typeof serverId !== "string" || !serverId || typeof toolName !== "string" || !toolName) {
    throw new Error("A valid MCP server and tool are required.");
  }
  const disabledTools = await loadDisabledMcpTools();
  disabledTools.delete(disabledMcpToolKey(serverId, toolName));
  await saveDisabledMcpTools(disabledTools);
  return { disabled: false, serverId, toolName };
}

async function clearDisabledMcpTools(serverId) {
  const disabledTools = await loadDisabledMcpTools();
  let changed = false;
  for (const [key, record] of disabledTools) {
    if (record.serverId !== serverId) continue;
    disabledTools.delete(key);
    changed = true;
  }
  if (changed) await saveDisabledMcpTools(disabledTools);
}

function serializeMcpTool(serverId, tool, disabledTools, policies) {
  const compatibility = prepareGeminiMcpTool(tool);
  const toolKey = disabledMcpToolKey(serverId, String(tool?.name || ""));
  const temporaryBlock = disabledTools.get(toolKey);
  const permission = policies.get(toolKey)?.mode || DEFAULT_MCP_TOOL_POLICY;
  return {
    name: typeof tool?.name === "string" ? tool.name : "",
    description: typeof tool?.description === "string" ? tool.description : "",
    permission,
    gemini: {
      ...compatibility,
      schemaCompatible: compatibility.enabled,
      enabled: compatibility.enabled && !temporaryBlock,
      temporary: Boolean(temporaryBlock),
      disabledSource: temporaryBlock?.source || (compatibility.enabled ? "" : "schema"),
      errors: temporaryBlock ? [temporaryBlock.reason] : compatibility.errors,
    },
  };
}

function serializeMcpConnection(
  connection,
  includeTools = false,
  disabledTools = new Map(),
  policies = new Map(),
) {
  const tools = connection.tools.map((tool) =>
    serializeMcpTool(connection.id, tool, disabledTools, policies));
  const result = {
    id: connection.id,
    url: connection.url,
    connectorId: connection.connectorId || "",
    enabled: connection.enabled !== false,
    serverName: connection.client.serverInfo?.name || "MCP server",
    serverVersion: connection.client.serverInfo?.version || "",
    protocolVersion: connection.client.protocolVersion || "",
    instructions: connection.client.instructions || "",
    toolCount: connection.tools.length,
    enabledToolCount: tools.filter((tool) => tool.gemini.enabled).length,
    disabledToolCount: tools.filter((tool) => !tool.gemini.enabled).length,
  };
  if (includeTools) result.tools = tools;
  return result;
}

async function connectMcpRecord(record, force = false) {
  const existing = mcpConnections.get(record.id);
  if (!force && existing?.url === record.url) return existing;

  let client;
  const connector = record.connectorId ? getMcpConnector(record.connectorId) : null;
  if (record.connectorId === "redmine") {
    const credential = await connectorAuth.getCredential(record.id);
    if (!credential?.apiKey) throw new Error("This Redmine connector is missing its API key. Remove it and connect again.");
    client = new RedmineMcpClient(record.url, credential.apiKey);
  } else if (connector?.auth === "oauth-dcr") {
    client = new McpHttpClient(record.url, {
      getAccessToken: (options) => connectorAuth.getAccessToken(record.id, options),
    });
  } else {
    client = new McpHttpClient(record.url);
  }
  await client.connect();
  const tools = await client.listTools();
  const connection = {
    id: record.id,
    url: record.url,
    connectorId: record.connectorId || "",
    enabled: record.enabled !== false,
    client,
    tools,
  };
  mcpConnections.set(record.id, connection);
  return connection;
}

async function addMcpServer(rawUrl) {
  const url = normalizeMcpUrl(rawUrl);
  const records = await loadMcpServerRecords();
  if (records.some((record) => record.url === url)) {
    throw new Error("This MCP server is already in your list.");
  }
  const draft = { id: crypto.randomUUID(), url, enabled: true };
  const connection = await connectMcpRecord(draft, true);
  records.push(recordFromMcpConnection(connection));
  await saveMcpServerRecords(records);
  return serializeMcpConnection(connection, true);
}

function connectorToolShouldAskByDefault(toolName) {
  return /(?:^|[._-])(?:add|archive|assign|create|delete|draft|invite|message|move|publish|remove|reply|send|set|update|write)(?:[._-]|$)/i
    .test(String(toolName || ""));
}

async function applyConnectorDefaultPolicies(connection) {
  const policies = await loadMcpToolPolicies();
  let changed = false;
  for (const tool of connection.tools) {
    const toolName = typeof tool?.name === "string" ? tool.name : "";
    if (!toolName || !connectorToolShouldAskByDefault(toolName)) continue;
    const key = disabledMcpToolKey(connection.id, toolName);
    if (policies.has(key)) continue;
    policies.set(key, { serverId: connection.id, toolName, mode: "ask" });
    changed = true;
  }
  if (changed) await saveMcpToolPolicies(policies);
  return policies;
}

async function connectMcpConnector(connectorId, config = {}) {
  const connector = getMcpConnector(connectorId);
  if (!connector) throw new Error("That built-in MCP connector is not supported.");
  const records = await loadMcpServerRecords();
  if (records.some((record) => record.connectorId === connector.id)) {
    throw new Error(`${connector.name} is already connected. Remove it before connecting another account.`);
  }
  const id = crypto.randomUUID();
  let url;
  try {
    if (connector.id === "redmine") {
      url = normalizeRedmineBaseUrl(config.baseUrl);
      const apiKey = String(config.apiKey || "").trim();
      if (!apiKey) throw new Error("Enter the Redmine API key before connecting.");
      await connectorAuth.setCredential(id, {
        connectorId: connector.id,
        kind: "redmine-api-key",
        apiKey,
      });
    } else {
      url = connector.endpoint;
      await connectorAuth.authorize(id, connector.id);
    }
    const draft = { id, url, connectorId: connector.id, enabled: true };
    const connection = await connectMcpRecord(draft, true);
    records.push(recordFromMcpConnection(connection));
    await saveMcpServerRecords(records);
    const policies = await applyConnectorDefaultPolicies(connection);
    return serializeMcpConnection(connection, true, new Map(), policies);
  } catch (error) {
    mcpConnections.delete(id);
    await connectorAuth.removeCredential(id).catch(() => {});
    throw error;
  }
}

async function listMcpServers() {
  const servers = await loadMcpServerRecords();
  return { servers, count: servers.length };
}

async function reconnectMcpServer(serverId) {
  const records = await loadMcpServerRecords();
  const index = records.findIndex((record) => record.id === serverId);
  if (index < 0) throw new Error("That MCP server is no longer in your list.");
  if (records[index].enabled === false) {
    throw new Error("Enable this MCP server before reconnecting it.");
  }
  const connection = await connectMcpRecord(records[index], true);
  await clearDisabledMcpTools(serverId);
  records[index] = recordFromMcpConnection(connection);
  await saveMcpServerRecords(records);
  return serializeMcpConnection(connection, true, new Map(), await loadMcpToolPolicies());
}

async function setMcpServerEnabled(serverId, enabled) {
  if (typeof serverId !== "string" || !serverId) {
    throw new Error("A valid MCP server is required.");
  }
  const shouldEnable = enabled === true;
  const records = await loadMcpServerRecords();
  const index = records.findIndex((record) => record.id === serverId);
  if (index < 0) throw new Error("That MCP server is no longer in your list.");

  if (!shouldEnable) {
    records[index] = { ...records[index], enabled: false };
    mcpConnections.delete(serverId);
    await saveMcpServerRecords(records);
    return {
      ...records[index],
      enabledToolCount: 0,
      disabledToolCount: records[index].toolCount,
      tools: [],
    };
  }

  records[index] = { ...records[index], enabled: true };
  await saveMcpServerRecords(records);
  try {
    const connection = await connectMcpRecord(records[index], true);
    records[index] = recordFromMcpConnection(connection);
    await saveMcpServerRecords(records);
    return serializeMcpConnection(
      connection,
      true,
      await loadDisabledMcpTools(),
      await loadMcpToolPolicies(),
    );
  } catch (error) {
    records[index] = { ...records[index], enabled: false };
    mcpConnections.delete(serverId);
    await saveMcpServerRecords(records);
    throw error;
  }
}

async function removeMcpServer(serverId) {
  const records = await loadMcpServerRecords();
  const nextRecords = records.filter((record) => record.id !== serverId);
  if (nextRecords.length === records.length) throw new Error("That MCP server is no longer in your list.");
  mcpConnections.delete(serverId);
  await connectorAuth.removeCredential(serverId);
  await clearDisabledMcpTools(serverId);
  await clearMcpToolPolicies(serverId);
  await saveMcpServerRecords(nextRecords);
  return { servers: nextRecords, count: nextRecords.length };
}

async function getConfiguredMcps(includeTools = false, force = true) {
  const records = await loadMcpServerRecords();
  if (!records.length) return { configured: false, serverCount: 0, connectedCount: 0, servers: [] };

  const states = await Promise.all(records.map(async (record) => {
    if (record.enabled === false) {
      mcpConnections.delete(record.id);
      return { record, connection: null, error: "" };
    }
    try {
      const connection = await connectMcpRecord(record, force);
      return { record: recordFromMcpConnection(connection), connection, error: "" };
    } catch (error) {
      mcpConnections.delete(record.id);
      return {
        record,
        connection: null,
        error: error instanceof Error ? error.message : "Could not connect to this MCP server.",
      };
    }
  }));

  const refreshedRecords = states.map((state) => state.record);
  if (JSON.stringify(refreshedRecords) !== JSON.stringify(records)) {
    await saveMcpServerRecords(refreshedRecords);
  }
  const disabledTools = await loadDisabledMcpTools();
  const policies = await loadMcpToolPolicies();
  return {
    configured: true,
    serverCount: records.length,
    connectedCount: states.filter((state) => state.connection).length,
    servers: states.map((state) => state.connection
      ? serializeMcpConnection(state.connection, includeTools, disabledTools, policies)
      : {
          ...state.record,
          enabledToolCount: 0,
          disabledToolCount: state.record.enabled === false ? state.record.toolCount : 0,
          tools: [],
          error: state.error,
        }),
  };
}

async function callMcpTool(serverId, tool, args, permissionGranted = false) {
  const records = await loadMcpServerRecords();
  const record = records.find((candidate) => candidate.id === serverId);
  if (!record) throw new Error("The MCP server for this tool is no longer configured.");
  if (record.enabled === false) throw new Error("This MCP server is temporarily disabled in Lumi Settings.");
  const connection = await connectMcpRecord(record);
  const candidate = connection.tools.find((item) => item.name === tool);
  if (!candidate) {
    throw new Error(`${record.serverName} does not expose tool: ${tool}`);
  }
  const policies = await loadMcpToolPolicies();
  const permission = policies.get(disabledMcpToolKey(serverId, tool))?.mode || DEFAULT_MCP_TOOL_POLICY;
  if (permission === "block") throw new Error("This MCP tool is blocked in Lumi Settings.");
  if (permission === "ask" && permissionGranted !== true) {
    throw new Error("This MCP tool requires user approval before every call.");
  }
  const disabledTools = await loadDisabledMcpTools();
  const temporaryBlock = disabledTools.get(disabledMcpToolKey(serverId, tool));
  if (temporaryBlock) throw new Error(`This MCP tool is temporarily disabled: ${temporaryBlock.reason}`);
  const compatibility = prepareGeminiMcpTool(candidate);
  if (!compatibility.enabled) throw new Error(`This MCP tool has an incompatible schema: ${compatibility.errors.join(" ")}`);
  const controller = new AbortController();
  activeMcpCallControllers.add(controller);
  try {
    return await connection.client.callTool(tool, args || {}, { signal: controller.signal });
  } finally {
    activeMcpCallControllers.delete(controller);
  }
}

  return {
    addMcpServer,
    callMcpTool,
    cancelActiveMcpCalls,
    connectMcpConnector,
    disableMcpTool,
    enableMcpTool,
    getConfiguredMcps,
    listMcpServers,
    reconnectMcpServer,
    removeMcpServer,
    setMcpServerEnabled,
    setMcpServerToolPolicy,
    setMcpToolPolicy,
  };
}
