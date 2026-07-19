import assert from "node:assert/strict";
import test from "node:test";

import { McpHttpClient } from "./mcp-client.js";

test("aborts an active MCP tool request when the user cancels", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

  try {
    const client = new McpHttpClient("http://localhost:3100/mcp");
    const controller = new AbortController();
    const request = client.callTool("slow_tool", {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, /cancelled by the user/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
