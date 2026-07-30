function parseHicasUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("Enter an absolute Hicas URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Hicas URLs must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Do not put Hicas credentials in the URL.");
  }
  return url;
}

export function normalizeHicasMcpUrl(rawUrl) {
  const url = parseHicasUrl(rawUrl);
  return new URL("/mcp", `${url.origin}/`).href;
}

export function buildHicasMcpUrl(rawUrl, rawMcpKey) {
  const mcpKey = String(rawMcpKey || "").trim();
  if (!mcpKey) throw new Error("Enter the Hicas MCP key before connecting.");
  const endpoint = new URL(normalizeHicasMcpUrl(rawUrl));
  endpoint.searchParams.set("MCP_KEY", mcpKey);
  return endpoint.href;
}
