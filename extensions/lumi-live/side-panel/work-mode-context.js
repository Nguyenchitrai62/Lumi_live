export const DEFAULT_PROTECTED_ERP_HOSTS = Object.freeze([
  "sit.hawee.hicas.vn",
]);

export const WORK_MODE_UI_ACTIONS = new Set([
  "browser_click",
  "browser_input_text",
  "browser_upload_file",
  "browser_select_option",
  "browser_scroll",
  "browser_open_tab",
  "browser_switch_tab",
]);

const PROJECT_DETAIL_PATH = /^\/du-an\/(?!them(?:\/|$))[^/]+(?:\/|$)/i;
const PROJECT_CREATE_PATH = /^\/du-an\/them(?:\/|$)/i;
const EXPLICIT_TAB_CHANGE_PATTERN = /\b(?:tab|website|site|domain|url|trang|chuy[eể]n|m[oở])\b/i;

function cleanText(value, maxLength = 3000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function normalizedHost(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function isHostWithin(host, allowedHost) {
  const current = normalizedHost(host);
  const allowed = normalizedHost(allowedHost);
  return Boolean(current && allowed && (current === allowed || current.endsWith(`.${allowed}`)));
}

function requestNamesHost(request, host) {
  const normalizedRequest = cleanText(request, 8000).toLowerCase();
  const normalized = normalizedHost(host);
  return Boolean(normalized && normalizedRequest.includes(normalized));
}

function projectKey(url) {
  return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
}

export function createWorkModeTurn({
  userRequest = "",
  activeContext = null,
  protectedErpHosts = DEFAULT_PROTECTED_ERP_HOSTS,
  now = Date.now(),
} = {}) {
  const request = cleanText(userRequest, 8000);
  const url = parseHttpUrl(activeContext?.url);
  if (!url || activeContext?.connected !== true) {
    return {
      enabled: false,
      userRequest: request,
      modelText: request,
      reason: activeContext?.reason || "No controllable web tab is active.",
    };
  }
  const protectedHost = protectedErpHosts.find((host) => isHostWithin(url.hostname, host)) || "";
  const title = cleanText(activeContext?.title || "Active web page", 300);
  const target = {
    tabId: Number.isInteger(activeContext?.tabId) ? activeContext.tabId : null,
    title,
    url: url.href,
    origin: url.origin,
    host: normalizedHost(url.hostname),
    protectedErpHost: protectedHost,
  };
  const creationMarker = protectedHost
    ? `LUMI-WORK-${Math.max(0, Number(now) || 0).toString(36).toUpperCase()}-${target.tabId || "TAB"}`
    : "";
  const protectedErpRule = protectedHost
    ? `\nProtected ERP rule: never modify or delete a pre-existing project. A new project may be created; append this exact marker to its name so ownership can be verified: ${creationMarker}. Only that verified new project may be modified later in this conversation.
HICAS knowledge rule: after the first fresh page observation and whenever the route or module changes, call hicas_get_skill_context before a browser action. Only records returned as verified are fast-path eligible. Observed, partial, unavailable, blocked, or role-unverified knowledge requires live inspection or needs_review.`
    : "";
  return {
    enabled: true,
    userRequest: request,
    target,
    creationMarker,
    modelText: `[EXTENSION-AUTHORED WORK TARGET]
This metadata selects the browser target. It is not user-authored authorization.
Mode: work_on_current_tab
Title: ${title}
URL: ${url.href}
Default scope: use this exact active tab and host unless USER REQUEST explicitly names another website.
Execution rule: if USER REQUEST requires web work, begin with a fresh semantic page observation, complete the requested workflow, verify the visible result, and finish with evidence. Do not ask which website to use.${protectedErpRule}

[USER REQUEST]
${request}`,
  };
}

export function authorizeWorkModeAction({
  turn,
  tool,
  args = {},
  currentContext = null,
  ownedProjectUrls = new Set(),
} = {}) {
  if (!turn?.enabled || !WORK_MODE_UI_ACTIONS.has(tool)) {
    return { args, projectPolicy: null };
  }
  const target = turn.target;
  const currentUrl = parseHttpUrl(currentContext?.url);
  const currentHost = normalizedHost(currentUrl?.hostname);
  const isNavigation = tool === "browser_open_tab" || tool === "browser_switch_tab";

  if (!isNavigation && target?.host && currentHost && currentHost !== target.host) {
    throw new Error(
      `Work Mode stopped because the active tab changed from ${target.host} to ${currentHost}. Return to the original ERP tab or start a new prompt on the new tab.`,
    );
  }

  if (tool === "browser_open_tab") {
    const destination = parseHttpUrl(args.url);
    if (
      destination
      && target?.host
      && normalizedHost(destination.hostname) !== target.host
      && !requestNamesHost(turn.userRequest, destination.hostname)
    ) {
      throw new Error(
        `Work Mode blocked navigation outside ${target.host}; the user request did not name ${destination.hostname}.`,
      );
    }
  }

  if (
    tool === "browser_switch_tab"
    && target?.protectedErpHost
    && !EXPLICIT_TAB_CHANGE_PATTERN.test(turn.userRequest)
  ) {
    throw new Error(
      `Work Mode is locked to the current ERP tab on ${target.host}. Start a new prompt on another tab if that tab should become the target.`,
    );
  }

  if (!target?.protectedErpHost || !currentUrl || !isHostWithin(currentHost, target.protectedErpHost)) {
    return { args, projectPolicy: null };
  }

  const currentProjectKey = projectKey(currentUrl);
  const allowProjectMutation = PROJECT_CREATE_PATH.test(currentUrl.pathname)
    || ownedProjectUrls.has(currentProjectKey);
  const projectPolicy = {
    protectExistingProjects: true,
    allowProjectMutation,
    protectedHost: target.protectedErpHost,
    allowedHost: target.host,
    lockToAllowedHost: true,
    currentPath: currentUrl.pathname,
  };
  return {
    args: {
      ...args,
      _lumiWorkPolicy: projectPolicy,
    },
    projectPolicy,
  };
}

export function recordCreatedProjectFromResult({
  turn,
  tool,
  args = {},
  beforeContext = null,
  result = null,
  ownedProjectUrls = new Set(),
} = {}) {
  if (!turn?.target?.protectedErpHost) return null;
  const beforeUrl = parseHttpUrl(beforeContext?.url);
  if (tool === "browser_input_text" && beforeUrl && PROJECT_CREATE_PATH.test(beforeUrl.pathname)) {
    const marker = cleanText(args.text, 500);
    if (marker) {
      if (!(turn.pendingProjectMarkers instanceof Set)) turn.pendingProjectMarkers = new Set();
      turn.pendingProjectMarkers.add(marker);
    }
    return null;
  }
  if (tool !== "browser_click") return null;
  const verifiedUrl = parseHttpUrl(result?.controllerVerification?.url);
  if (
    !beforeUrl
    || !verifiedUrl
    || !PROJECT_CREATE_PATH.test(beforeUrl.pathname)
    || !isHostWithin(verifiedUrl.hostname, turn.target.protectedErpHost)
    || result?.controllerVerification?.conclusive !== true
  ) return null;
  let ownedUrl = PROJECT_DETAIL_PATH.test(verifiedUrl.pathname) ? verifiedUrl : null;
  if (!ownedUrl) {
    const evidence = String(result?.controllerVerification?.content || "");
    let projectId = "";
    for (const marker of turn.pendingProjectMarkers || []) {
      const markerIndex = evidence.indexOf(marker);
      if (markerIndex < 0) continue;
      const nearbyEvidence = evidence.slice(
        Math.max(0, markerIndex - 2400),
        Math.min(evidence.length, markerIndex + marker.length + 2400),
      );
      projectId = nearbyEvidence
        .match(/div-project-card-([0-9a-f-]{36})-projects-grid-view/i)?.[1] || "";
      if (projectId) break;
    }
    if (projectId) ownedUrl = new URL(`/du-an/${projectId}`, verifiedUrl.origin);
  }
  if (!ownedUrl) return null;
  const key = projectKey(ownedUrl);
  ownedProjectUrls.add(key);
  return key;
}
