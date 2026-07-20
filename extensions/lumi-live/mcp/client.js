const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 20000;

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizeMcpUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("Enter an absolute MCP URL, for example https://example.com/mcp.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP URLs must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials in the MCP URL.");
  }

  // Remote MCP traffic should be encrypted. This also preserves POST when a
  // server redirects its public http:// endpoint to https:// with a 301.
  if (url.protocol === "http:" && !isLocalHostname(url.hostname)) url.protocol = "https:";
  url.hash = "";
  return url.href;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The MCP server returned invalid JSON.");
  }
}

async function readSseMessage(response, expectedId, controller) {
  if (!response.body) throw new Error("The MCP server opened SSE without a response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];

  const consumeEvent = () => {
    if (!dataLines.length) return null;
    const message = parseJson(dataLines.join("\n"));
    dataLines = [];
    if (expectedId === undefined || message.id === expectedId) return message;
    return null;
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
    controller.abort();
  }
}

export class McpHttpClient {
  constructor(rawUrl, options = {}) {
    this.url = normalizeMcpUrl(rawUrl);
    this.getAccessToken = typeof options.getAccessToken === "function"
      ? options.getAccessToken
      : null;
    this.protocolVersion = null;
    this.sessionId = null;
    this.serverInfo = null;
    this.instructions = "";
    this.nextRequestId = 1;
  }

  async post(payload, expectedId, externalSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const headers = {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        };
        if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
        if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
        if (this.getAccessToken) {
          const accessToken = await this.getAccessToken({ forceRefresh: attempt > 0 });
          if (!accessToken) throw new Error("The MCP connector did not provide an OAuth access token.");
          headers.Authorization = `Bearer ${accessToken}`;
        }
        response = await fetch(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          redirect: "follow",
          signal: controller.signal,
        });
        if (response.status !== 401 || !this.getAccessToken || attempt > 0) break;
        await response.body?.cancel().catch(() => {});
      }
      const sessionId = response.headers.get("Mcp-Session-Id");
      if (sessionId) this.sessionId = sessionId;

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim();
        throw new Error(`MCP server returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}.`);
      }
      if (expectedId === undefined || response.status === 202 || response.status === 204) {
        await response.body?.cancel().catch(() => {});
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      const message = contentType.includes("text/event-stream")
        ? await readSseMessage(response, expectedId, controller)
        : parseJson(await response.text());
      if (message?.error) {
        throw new Error(message.error.message || `MCP error ${message.error.code || "unknown"}.`);
      }
      if (message?.id !== expectedId) throw new Error("The MCP server returned a mismatched response ID.");
      return message.result;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(timedOut
          ? "The MCP server did not respond within 20 seconds."
          : "The MCP request was cancelled by the user.");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async request(method, params = {}, options = {}) {
    const id = this.nextRequestId++;
    return this.post({ jsonrpc: "2.0", id, method, params }, id, options.signal);
  }

  async notify(method, params = {}) {
    await this.post({ jsonrpc: "2.0", method, params }, undefined);
  }

  async connect() {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Lumi Live", version: "0.0.14" },
    });
    this.protocolVersion = result?.protocolVersion || MCP_PROTOCOL_VERSION;
    this.serverInfo = result?.serverInfo || null;
    this.instructions = typeof result?.instructions === "string" ? result.instructions : "";
    await this.notify("notifications/initialized");
    return result;
  }

  async listTools() {
    const result = await this.request("tools/list");
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}, options = {}) {
    return this.request("tools/call", { name, arguments: args }, options);
  }
}
