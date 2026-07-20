import assert from "node:assert/strict";
import test from "node:test";

import { MCP_CONNECTORS, getMcpConnector } from "../core/mcp-connectors.js";
import { STORAGE_KEYS } from "../core/extension-config.js";
import { prepareGeminiMcpTool } from "../mcp/gemini-tool-schema.js";
import {
  createMcpConnectorAuth,
  createPkcePair,
} from "../background/mcp-connector-auth.js";
import { createMcpService } from "../background/mcp-service.js";
import {
  normalizeRedmineBaseUrl,
  RedmineMcpClient,
} from "../background/redmine-mcp-client.js";

test("ships the expected extension-only connector catalog", () => {
  assert.deepEqual(MCP_CONNECTORS.map((connector) => connector.id), ["notion", "redmine"]);
  const notion = getMcpConnector("notion");
  assert.equal(notion.endpoint, "https://mcp.notion.com/mcp");
  assert.equal(notion.auth, "oauth-dcr");
  assert.equal(notion.icon, "../icons/connectors/notion.svg");
  assert.equal(getMcpConnector("redmine").icon, "../icons/connectors/redmine.svg");
  assert.deepEqual(getMcpConnector("redmine").fields.map((field) => field.name), ["baseUrl", "apiKey"]);
});

test("temporarily disabled MCP servers keep their record without loading tools", async () => {
  const originalChrome = globalThis.chrome;
  const localValues = {
    [STORAGE_KEYS.mcpServers]: [{
      id: "saved-redmine",
      connectorId: "redmine",
      url: "https://redmine.example.com",
      enabled: true,
      serverName: "Saved Redmine",
      toolCount: 9,
    }],
    [STORAGE_KEYS.mcpConnectorCredentials]: {
      "saved-redmine": { kind: "redmine-api-key", apiKey: "kept-secret" },
    },
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names
            .filter((key) => Object.hasOwn(localValues, key))
            .map((key) => [key, localValues[key]]));
        },
        async set(values) {
          Object.assign(localValues, values);
        },
        async remove(key) {
          delete localValues[key];
        },
      },
      session: {
        async get() {
          return {};
        },
        async set() {},
      },
    },
  };

  try {
    const service = createMcpService();
    const disabled = await service.setMcpServerEnabled("saved-redmine", false);
    const result = await service.getConfiguredMcps(true, false);
    assert.equal(disabled.enabled, false);
    assert.equal(result.connectedCount, 0);
    assert.equal(result.servers[0].enabled, false);
    assert.equal(result.servers[0].toolCount, 9);
    assert.deepEqual(result.servers[0].tools, []);
    assert.equal(
      localValues[STORAGE_KEYS.mcpConnectorCredentials]["saved-redmine"].apiKey,
      "kept-secret",
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("creates OAuth PKCE values without exposing the verifier as the challenge", async () => {
  const { verifier, challenge } = await createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(challenge, verifier);
});

test("Notion completes the one-click DCR OAuth flow", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const localValues = {};
  const registrations = [];
  const authorizationUrls = [];

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
    if (url.pathname.endsWith("/.well-known/oauth-protected-resource")) {
      return json({ error: "not_found" }, 404);
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json({ authorization_servers: [url.origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`,
        registration_endpoint: `${url.origin}/register`,
      });
    }
    if (url.pathname === "/register") {
      registrations.push({ url: url.href, body: JSON.parse(options.body) });
      return json({ client_id: `client-${url.hostname}` });
    }
    if (url.pathname === "/token") {
      return json({
        access_token: `access-${url.hostname}`,
        refresh_token: `refresh-${url.hostname}`,
        expires_in: 3600,
      });
    }
    return json({ error: "not_found" }, 404);
  };

  globalThis.chrome = {
    identity: {
      getRedirectURL(path) {
        return `https://lumi-test.chromiumapp.org/${path}`;
      },
      async launchWebAuthFlow({ url, interactive }) {
        assert.equal(interactive, true);
        authorizationUrls.push(url);
        const authorization = new URL(url);
        return `${authorization.searchParams.get("redirect_uri")}?code=test-code&state=${authorization.searchParams.get("state")}`;
      },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: localValues[key] };
        },
        async set(values) {
          Object.assign(localValues, values);
        },
      },
    },
  };

  try {
    const auth = createMcpConnectorAuth();
    const credential = await auth.authorize("server-notion", "notion");
    assert.equal(credential.connectorId, "notion");
    assert.match(credential.accessToken, /^access-/);

    assert.equal(registrations.length, 1);
    assert.equal(authorizationUrls.length, 1);
    const connector = getMcpConnector("notion");
    const redirectUri = "https://lumi-test.chromiumapp.org/mcp-notion";
    assert.ok(registrations[0].body.redirect_uris.includes(redirectUri));
    assert.equal(new URL(authorizationUrls[0]).searchParams.get("resource"), connector.endpoint);
    assert.equal(
      localValues[STORAGE_KEYS.mcpConnectorCredentials]["server-notion"].accessToken,
      `access-${new URL(connector.endpoint).hostname}`,
    );
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("normalizes custom Redmine base URLs without leaking credentials", () => {
  assert.equal(
    normalizeRedmineBaseUrl("https://redmine.example.com/company/redmine/"),
    "https://redmine.example.com/company/redmine",
  );
  assert.throws(
    () => normalizeRedmineBaseUrl("https://user:secret@redmine.example.com"),
    /credentials/i,
  );
});

test("Redmine adapter publishes Gemini-compatible MCP tools and authenticates with the API key header", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/users/current.json")) {
      return new Response(JSON.stringify({
        user: { id: 7, firstname: "Lumi", lastname: "Tester" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ projects: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = new RedmineMcpClient("https://redmine.example.com/custom", "redmine-key");
    await client.connect();
    const tools = await client.listTools();
    assert.ok(tools.length >= 7);
    assert.ok(tools.every((tool) => prepareGeminiMcpTool(tool).enabled));
    await client.callTool("redmine_list_projects", { limit: 10 });
    assert.equal(requests[0].options.headers["X-Redmine-API-Key"], "redmine-key");
    assert.match(requests[1].url, /\/custom\/projects\.json\?limit=10&offset=0$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Redmine write tools send the expected REST payload", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ issue: { id: 42 } }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = new RedmineMcpClient("https://redmine.example.com", "redmine-key");
    const result = await client.callTool("redmine_create_issue", {
      projectId: "lumi",
      subject: "Test connector",
    });
    assert.equal(result.issue.id, 42);
    assert.equal(request.url, "https://redmine.example.com/issues.json");
    assert.equal(request.options.method, "POST");
    assert.deepEqual(JSON.parse(request.options.body), {
      issue: { project_id: "lumi", subject: "Test connector" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Redmine spent-time tool filters one day and totals the connected user's hours", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (url) => {
    requestUrl = String(url);
    return new Response(JSON.stringify({
      total_count: 2,
      offset: 0,
      limit: 100,
      time_entries: [
        {
          id: 1,
          project: { id: 10, name: "Lumi" },
          issue: { id: 20 },
          activity: { id: 9, name: "Development" },
          hours: 3.5,
          comments: "Morning",
          spent_on: "2026-07-20",
        },
        {
          id: 2,
          project: { id: 10, name: "Lumi" },
          issue: { id: 21 },
          activity: { id: 9, name: "Development" },
          hours: 4,
          comments: "Afternoon",
          spent_on: "2026-07-20",
        },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = new RedmineMcpClient("https://redmine.example.com", "redmine-key");
    const result = await client.callTool("redmine_get_spent_time", { date: "2026-07-20" });
    assert.equal(result.entryCount, 2);
    assert.equal(result.totalHours, 7.5);
    assert.equal(result.truncated, false);
    assert.equal(result.entries.length, 2);
    assert.match(requestUrl, /user_id=me/);
    assert.match(requestUrl, /from=2026-07-20/);
    assert.match(requestUrl, /to=2026-07-20/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
