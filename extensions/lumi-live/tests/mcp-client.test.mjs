import assert from "node:assert/strict";
import test from "node:test";

import { McpHttpClient } from "../mcp/client.js";

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

test("adds a bearer token to authenticated MCP requests", async () => {
  const originalFetch = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.Authorization;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = new McpHttpClient("https://mcp.example.com/mcp", {
      getAccessToken: async () => "access-token",
    });
    assert.deepEqual(await client.callTool("test_tool"), { ok: true });
    assert.equal(authorization, "Bearer access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshes an authenticated MCP token once after HTTP 401", async () => {
  const originalFetch = globalThis.fetch;
  const refreshFlags = [];
  let requestCount = 0;
  globalThis.fetch = async (_url, options) => {
    requestCount += 1;
    if (requestCount === 1) return new Response("", { status: 401 });
    assert.equal(options.headers.Authorization, "Bearer fresh-token");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { retried: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = new McpHttpClient("https://mcp.example.com/mcp", {
      getAccessToken: async ({ forceRefresh }) => {
        refreshFlags.push(forceRefresh);
        return forceRefresh ? "fresh-token" : "expired-token";
      },
    });
    assert.deepEqual(await client.callTool("test_tool"), { retried: true });
    assert.deepEqual(refreshFlags, [false, true]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
