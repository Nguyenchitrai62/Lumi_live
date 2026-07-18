export type JsonRecord = Record<string, unknown>;

export type McpToolPolicy = "allow" | "ask" | "block";
export type McpServerStatus = "connecting" | "connected" | "error";

export type McpTool = {
  name?: string;
  description?: string;
  inputSchema?: unknown;
};

export type StoredMcpServer = {
  id: string;
  url: string;
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
  toolCount: number;
};

export type StoredMcpPolicy = {
  serverId: string;
  toolName: string;
  mode: McpToolPolicy;
};

export type GeminiCompatibility = {
  enabled: boolean;
  parameters: JsonRecord;
  errors: string[];
  warnings: string[];
};

export type McpToolView = {
  name: string;
  description: string;
  permission: McpToolPolicy;
  gemini: GeminiCompatibility;
};

export type McpServerView = StoredMcpServer & {
  instructions: string;
  status: McpServerStatus;
  error: string;
  enabledToolCount: number;
  disabledToolCount: number;
  tools: McpToolView[];
};

export type ActiveMcpTool = {
  functionName: string;
  serverId: string;
  serverName: string;
  toolName: string;
  permission: McpToolPolicy;
};

export function isObject(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
