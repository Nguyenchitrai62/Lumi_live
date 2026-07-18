import { isObject, type JsonRecord, type McpTool } from "./types";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_REQUEST_TIMEOUT_MS = 22000;

export function normalizeMcpUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("Enter an absolute MCP URL, for example https://example.com/mcp.");
  }

  if (url.protocol !== "https:") {
    throw new Error(
      "The web app supports public HTTPS MCP endpoints. Use the extension or a secure gateway for local MCP servers.",
    );
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials in the MCP URL.");
  }

  url.hash = "";
  return url.href;
}

function parseJson(text: string) {
  try {
    return JSON.parse(text) as JsonRecord;
  } catch {
    throw new Error("The MCP server returned invalid JSON.");
  }
}

async function readSseMessage(response: Response, expectedId: number) {
  if (!response.body) throw new Error("The MCP server opened SSE without a response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const consumeEvent = () => {
    if (!dataLines.length) return null;
    const message = parseJson(dataLines.join("\n"));
    dataLines = [];
    return message.id === expectedId ? message : null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : lines.pop() || "";

      for (const line of lines) {
        if (!line) {
          const message = consumeEvent();
          if (message) return message;
          continue;
        }
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }

      if (done) {
        if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
        const message = consumeEvent();
        if (message) return message;
        throw new Error("The MCP SSE stream ended before the requested response arrived.");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class McpHttpClient {
  readonly url: string;
  protocolVersion: string | null = null;
  sessionId: string | null = null;
  serverInfo: { name?: string; version?: string } | null = null;
  instructions = "";
  private nextRequestId = 1;

  constructor(rawUrl: string) {
    this.url = normalizeMcpUrl(rawUrl);
  }

  private async post(payload: JsonRecord, expectedId?: number) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), MCP_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: this.url,
          payload,
          protocolVersion: this.protocolVersion,
          sessionId: this.sessionId,
        }),
        signal: controller.signal,
      });

      const sessionId = response.headers.get("Mcp-Session-Id");
      if (sessionId) this.sessionId = sessionId;

      if (!response.ok) {
        const rawDetail = await response.text().catch(() => "");
        let detail = rawDetail;
        try {
          const parsedDetail = JSON.parse(rawDetail) as unknown;
          if (isObject(parsedDetail) && typeof parsedDetail.error === "string") {
            detail = parsedDetail.error;
          }
        } catch {
          // Keep the upstream text when the response is not JSON.
        }
        detail = detail.replace(/\s+/g, " ").trim();
        throw new Error(
          `MCP connection failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 260)}` : ""}.`,
        );
      }
      if (expectedId === undefined || response.status === 202 || response.status === 204) {
        await response.body?.cancel().catch(() => {});
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      const message = contentType.includes("text/event-stream")
        ? await readSseMessage(response, expectedId)
        : parseJson(await response.text());

      if (isObject(message.error)) {
        throw new Error(
          typeof message.error.message === "string"
            ? message.error.message
            : `MCP error ${String(message.error.code || "unknown")}.`,
        );
      }
      if (message.id !== expectedId) {
        throw new Error("The MCP server returned a mismatched response ID.");
      }
      return message.result;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("The MCP server did not respond within 22 seconds.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async request(method: string, params: JsonRecord = {}) {
    const id = this.nextRequestId++;
    return this.post({ jsonrpc: "2.0", id, method, params }, id);
  }

  async notify(method: string, params: JsonRecord = {}) {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  async connect() {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Lumi Live Web", version: "0.2.0" },
    });
    const normalizedResult = isObject(result) ? result : {};
    this.protocolVersion = typeof normalizedResult.protocolVersion === "string"
      ? normalizedResult.protocolVersion
      : MCP_PROTOCOL_VERSION;
    this.serverInfo = isObject(normalizedResult.serverInfo)
      ? {
          name: typeof normalizedResult.serverInfo.name === "string"
            ? normalizedResult.serverInfo.name
            : undefined,
          version: typeof normalizedResult.serverInfo.version === "string"
            ? normalizedResult.serverInfo.version
            : undefined,
        }
      : null;
    this.instructions = typeof normalizedResult.instructions === "string"
      ? normalizedResult.instructions
      : "";
    await this.notify("notifications/initialized");
    return normalizedResult;
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list");
    return isObject(result) && Array.isArray(result.tools) ? result.tools : [];
  }

  async callTool(name: string, args: JsonRecord = {}) {
    return this.request("tools/call", { name, arguments: args });
  }
}
