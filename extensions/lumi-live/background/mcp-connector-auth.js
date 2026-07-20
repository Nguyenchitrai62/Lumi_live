import { getMcpConnector } from "../core/mcp-connectors.js";
import { STORAGE_KEYS } from "../core/extension-config.js";

const TOKEN_EXPIRY_SKEW_MS = 60_000;
const OAUTH_REFRESH_TIMEOUT_MS = 30_000;

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export async function createPkcePair() {
  const verifier = randomBase64Url(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: encodeBase64Url(new Uint8Array(digest)),
  };
}

function safeJson(text, context) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context} returned invalid JSON.`);
  }
}

async function fetchJson(url, options = {}, context = "OAuth server") {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? safeJson(text, context) : {};
  if (!response.ok) {
    const detail = body.error_description || body.error || body.message || text;
    throw new Error(`${context} returned HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 260)}` : ""}.`);
  }
  return body;
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function uniqueUrls(urls) {
  return [...new Set(urls.filter(Boolean))];
}

async function firstJson(urls, context) {
  let latestError = null;
  for (const url of uniqueUrls(urls)) {
    try {
      return await fetchJson(url, {}, context);
    } catch (error) {
      latestError = error;
    }
  }
  throw latestError || new Error(`Could not discover ${context}.`);
}

async function discoverOAuthMetadata(serverUrl) {
  const resource = new URL(serverUrl);
  const resourcePath = resource.pathname.replace(/\/+$/g, "");
  const protectedResource = await firstJson([
    new URL(`${resourcePath}/.well-known/oauth-protected-resource`, resource.origin).href,
    new URL(`/.well-known/oauth-protected-resource${resourcePath}`, resource.origin).href,
    new URL("/.well-known/oauth-protected-resource", resource.origin).href,
  ], "MCP protected-resource metadata");
  const authServer = Array.isArray(protectedResource.authorization_servers)
    ? protectedResource.authorization_servers[0]
    : "";
  if (!authServer) throw new Error("The MCP server did not advertise an OAuth authorization server.");
  const issuer = new URL(authServer);
  const issuerPath = issuer.pathname.replace(/\/+$/g, "");
  const metadata = await firstJson([
    new URL(`${issuerPath}/.well-known/oauth-authorization-server`, issuer.origin).href,
    new URL(`/.well-known/oauth-authorization-server${issuerPath}`, issuer.origin).href,
    new URL("/.well-known/oauth-authorization-server", issuer.origin).href,
  ], "OAuth authorization-server metadata");
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error("OAuth metadata is missing its authorization or token endpoint.");
  }
  return {
    ...metadata,
    resourceScopes: Array.isArray(protectedResource.scopes_supported)
      ? protectedResource.scopes_supported.filter((scope) => typeof scope === "string" && scope)
      : [],
  };
}

async function registerDynamicClient(metadata, redirectUri, scopes = []) {
  if (!metadata.registration_endpoint) {
    throw new Error("This MCP server does not support dynamic OAuth client registration.");
  }
  const registrationRequest = {
    client_name: "Lumi Live",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  if (scopes.length) registrationRequest.scope = scopes.join(" ");
  const registration = await fetchJson(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(registrationRequest),
  }, "OAuth client registration");
  if (!registration.client_id) throw new Error("OAuth registration did not return a client ID.");
  return registration;
}

function parseOAuthCallback(callbackUrl, expectedState) {
  if (!callbackUrl) throw new Error("The OAuth window closed before authorization completed.");
  const callback = new URL(callbackUrl);
  const state = callback.searchParams.get("state");
  if (!state || state !== expectedState) {
    throw new Error("OAuth state validation failed. Please start the connection again.");
  }
  const oauthError = callback.searchParams.get("error");
  if (oauthError) {
    throw new Error(callback.searchParams.get("error_description") || `OAuth authorization failed: ${oauthError}.`);
  }
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("The OAuth provider did not return an authorization code.");
  return code;
}

function normalizeTokenResponse(body) {
  if (!body.access_token) throw new Error("OAuth token exchange did not return an access token.");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || "",
    expiresIn: Number(body.expires_in) || 3600,
  };
}

async function exchangeAuthorizationCode({
  tokenEndpoint,
  clientId,
  clientSecret = "",
  redirectUri,
  code,
  verifier,
}) {
  const parameters = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (clientSecret) parameters.set("client_secret", clientSecret);
  const response = await fetchJson(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: parameters.toString(),
  }, "MCP OAuth token exchange");
  return normalizeTokenResponse(response);
}

async function authorizeDcrConnector(connector) {
  const redirectUri = chrome.identity.getRedirectURL(`mcp-${connector.id}`);
  const metadata = await discoverOAuthMetadata(connector.endpoint);
  const scopes = metadata.resourceScopes;
  const registration = await registerDynamicClient(metadata, redirectUri, scopes);
  const { verifier, challenge } = await createPkcePair();
  const state = randomBase64Url();
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  const authorizationParameters = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: connector.endpoint,
    prompt: "consent",
  });
  if (scopes.length) authorizationParameters.set("scope", scopes.join(" "));
  authorizationUrl.search = authorizationParameters.toString();
  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    url: authorizationUrl.href,
    interactive: true,
  });
  const code = parseOAuthCallback(callbackUrl, state);
  const token = await exchangeAuthorizationCode({
    tokenEndpoint: metadata.token_endpoint,
    clientId: registration.client_id,
    clientSecret: registration.client_secret || "",
    redirectUri,
    code,
    verifier,
  });
  return {
    connectorId: connector.id,
    kind: "oauth",
    tokenEndpoint: metadata.token_endpoint,
    clientId: registration.client_id,
    clientSecret: registration.client_secret || "",
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
  };
}

export function createMcpConnectorAuth() {
  const storageKey = STORAGE_KEYS.mcpConnectorCredentials;

  async function loadAll() {
    const stored = await chrome.storage.local.get(storageKey);
    const value = stored[storageKey];
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  async function saveAll(credentials) {
    await chrome.storage.local.set({ [storageKey]: credentials });
  }

  async function getCredential(serverId) {
    const credentials = await loadAll();
    const credential = credentials[serverId];
    return credential && typeof credential === "object" ? credential : null;
  }

  async function setCredential(serverId, credential) {
    const credentials = await loadAll();
    credentials[serverId] = {
      ...credential,
      updatedAt: Date.now(),
    };
    await saveAll(credentials);
  }

  async function removeCredential(serverId) {
    const credentials = await loadAll();
    if (!Object.hasOwn(credentials, serverId)) return;
    delete credentials[serverId];
    await saveAll(credentials);
  }

  async function authorize(serverId, connectorId) {
    const connector = getMcpConnector(connectorId);
    if (!connector) throw new Error("That built-in MCP connector is not supported.");
    if (connector.auth !== "oauth-dcr") throw new Error(`${connector.name} does not use OAuth.`);
    const credential = await authorizeDcrConnector(connector);
    await setCredential(serverId, credential);
    return credential;
  }

  async function refreshOauthCredential(serverId, credential) {
    if (!credential.refreshToken) {
      throw new Error("This connector session expired. Remove it and connect again.");
    }
    const parameters = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
    });
    if (credential.clientSecret) parameters.set("client_secret", credential.clientSecret);
    const body = await fetchJson(credential.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: parameters.toString(),
    }, `${credential.connectorId || "MCP"} OAuth refresh`);
    const token = normalizeTokenResponse(body);
    const refreshed = {
      ...credential,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken || credential.refreshToken,
      expiresAt: Date.now() + token.expiresIn * 1000,
    };
    await setCredential(serverId, refreshed);
    return refreshed;
  }

  async function getAccessToken(serverId, { forceRefresh = false } = {}) {
    const credential = await getCredential(serverId);
    if (!credential || credential.kind !== "oauth") {
      throw new Error("This MCP connector is not authenticated.");
    }
    const expired = !credential.expiresAt
      || Date.now() + TOKEN_EXPIRY_SKEW_MS >= Number(credential.expiresAt);
    if (forceRefresh || expired) {
      const refreshed = await withTimeout(
        refreshOauthCredential(serverId, credential),
        OAUTH_REFRESH_TIMEOUT_MS,
        "OAuth token refresh timed out.",
      );
      return refreshed.accessToken;
    }
    return credential.accessToken;
  }

  return {
    authorize,
    getAccessToken,
    getCredential,
    removeCredential,
    setCredential,
  };
}
