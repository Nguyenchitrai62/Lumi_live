import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;
const ALLOWED_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "tools/call",
]);

class McpProxyInputError extends Error {}

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
  );
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8")
    || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")
    || normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

function isPrivateAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

async function validateMcpUrl(rawUrl: unknown) {
  let url: URL;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw new McpProxyInputError("The MCP URL is invalid.");
  }
  if (url.protocol !== "https:") {
    throw new McpProxyInputError("The web app only connects to public HTTPS MCP endpoints.");
  }
  if (url.username || url.password) {
    throw new McpProxyInputError("Credentials are not allowed inside an MCP URL.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
  ) {
    throw new McpProxyInputError("Local and private MCP endpoints are not available from the hosted web app.");
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((record) => isPrivateAddress(record.address))) {
    throw new McpProxyInputError("The MCP hostname must resolve only to public internet addresses.");
  }
  url.hash = "";
  return url;
}

function checkSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.split(",")[0].trim();
  } catch {
    return false;
  }
}

async function readLimitedResponse(response: Response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error("The MCP response exceeded the 2 MB web limit.");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function createLimitedResponseStream(
  body: ReadableStream<Uint8Array>,
  abortController: AbortController,
  timeoutId: ReturnType<typeof setTimeout>,
) {
  const reader = body.getReader();
  let total = 0;
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          finish();
          abortController.abort();
          await reader.cancel("MCP response exceeded the web limit").catch(() => {});
          controller.error(new Error("The MCP response exceeded the 2 MB web limit."));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      abortController.abort();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

export async function POST(request: Request) {
  if (!checkSameOrigin(request)) {
    return Response.json({ error: "Cross-origin MCP proxy requests are not allowed." }, { status: 403 });
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "The MCP request exceeded the 128 KB web limit." }, { status: 413 });
  }

  let body: {
    url?: unknown;
    payload?: unknown;
    protocolVersion?: unknown;
    sessionId?: unknown;
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "The MCP proxy request must be valid JSON." }, { status: 400 });
  }

  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
    return Response.json({ error: "A valid MCP JSON-RPC payload is required." }, { status: 400 });
  }
  const payload = body.payload as Record<string, unknown>;
  if (payload.jsonrpc !== "2.0" || typeof payload.method !== "string" || !ALLOWED_METHODS.has(payload.method)) {
    return Response.json({ error: "That MCP JSON-RPC method is not allowed by the web proxy." }, { status: 400 });
  }

  try {
    const url = await validateMcpUrl(body.url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let streamOwnsTimeout = false;
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    });
    if (typeof body.protocolVersion === "string" && body.protocolVersion) {
      headers.set("MCP-Protocol-Version", body.protocolVersion.slice(0, 80));
    }
    if (typeof body.sessionId === "string" && body.sessionId) {
      headers.set("Mcp-Session-Id", body.sessionId.slice(0, 500));
    }

    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: controller.signal,
        cache: "no-store",
      });

      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => {});
        return Response.json(
          { error: "The MCP endpoint redirected. Install its final public HTTPS URL instead." },
          { status: 400 },
        );
      }

      const contentType = upstream.headers.get("content-type") || "application/json";
      const responseHeaders = new Headers({
        "Cache-Control": "no-store",
        "Content-Type": contentType,
      });
      const sessionId = upstream.headers.get("Mcp-Session-Id");
      if (sessionId) responseHeaders.set("Mcp-Session-Id", sessionId);

      if (contentType.includes("text/event-stream") && upstream.body) {
        streamOwnsTimeout = true;
        return new Response(createLimitedResponseStream(upstream.body, controller, timeoutId), {
          status: upstream.status,
          headers: responseHeaders,
        });
      }

      const responseBody = await readLimitedResponse(upstream);
      return new Response(responseBody.byteLength ? responseBody : null, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } finally {
      if (!streamOwnsTimeout) clearTimeout(timeoutId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The MCP request failed.";
    const status = error instanceof McpProxyInputError
      ? 400
      : error instanceof DOMException && error.name === "AbortError" ? 504 : 502;
    return Response.json({ error: message.slice(0, 500) }, { status });
  }
}
