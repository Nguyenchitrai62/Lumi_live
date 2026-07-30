export const INDEX_STORAGE_KEY = "siteCapabilityIndexerLastResult";
export const RUN_STORAGE_KEY = "siteCapabilityIndexerRun";

const DANGEROUS_ACTION_PATTERN = new RegExp([
  "\\bdelete\\b",
  "\\bremove\\b",
  "\\berase\\b",
  "\\bdestroy\\b",
  "\\barchive\\b",
  "\\bsubmit\\b",
  "\\bsave\\b",
  "\\bpublish\\b",
  "\\bsend\\b",
  "\\bpay\\b",
  "\\bbuy\\b",
  "\\bpurchase\\b",
  "\\bcheckout\\b",
  "\\border\\b",
  "\\btransfer\\b",
  "\\bapprove\\b",
  "\\bconfirm\\b",
  "\\binstall\\b",
  "\\bconnect\\b",
  "\\bdisconnect\\b",
  "\\blog\\s*out\\b",
  "\\bsign\\s*out\\b",
  "\\bstart\\b",
  "\\brun\\b",
  "\\bexecute\\b",
  "\\bcreate\\b",
  "\\bnew\\b",
  "\\badd\\b",
  "\\bupload\\b",
  "\\bdownload\\b",
  "\\bimport\\b",
  "\\bexport\\b",
  "x[oó]a",
  "g[uử]i",
  "\\blưu\\b",
  "\\bthanh\\s*to[aá]n\\b",
  "đăng\\s*xuất",
  "tạo",
  "\\bth[eê]m\\b",
  "tải\\s*(l[eê]n|xuống)",
].join("|"), "iu");

const SAFE_DISCLOSURE_PATTERN = new RegExp([
  "\\bmenu\\b",
  "\\bmore\\b",
  "\\bdetails?\\b",
  "\\bview\\b",
  "\\bshow\\b",
  "\\bhide\\b",
  "\\bexpand\\b",
  "\\bcollapse\\b",
  "\\bfilter\\b",
  "\\bsettings?\\b",
  "\\bpreferences?\\b",
  "\\bhelp\\b",
  "\\babout\\b",
  "\\bnext\\b",
  "\\bprevious\\b",
  "\\bback\\b",
  "\\bclose\\b",
  "\\bm[eê]nu\\b",
  "\\bxem\\b",
  "chi\\s*tiết",
  "mở",
  "\\bđ[oó]ng\\b",
  "hiện",
  "ẩn",
  "\\blọc\\b",
  "\\bc[aà]i\\s*đặt\\b",
  "trợ\\s*giúp",
  "tiếp",
  "trước",
].join("|"), "iu");

export function normalizeText(value, maxLength = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeScanUrl(value) {
  const clean = String(value || "").trim();
  if (!clean) throw new Error("Enter a website URL.");
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(clean) ? clean : `https://${clean}`);
  } catch {
    throw new Error("Enter a valid http, https, or file URL.");
  }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
    throw new Error("Only http, https, and file URLs can be indexed.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }
  return parsed.href;
}

export function canonicalizePageUrl(value) {
  const parsed = new URL(normalizeScanUrl(value));
  parsed.hash = parsed.hash === "#" ? "" : parsed.hash;
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$|mc_)/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  return parsed.href;
}

export function sameSiteOrigin(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    if (leftUrl.protocol === "file:" && rightUrl.protocol === "file:") return true;
    return leftUrl.origin === rightUrl.origin;
  } catch {
    return false;
  }
}

export function actionSafety(action, rootUrl) {
  const primaryLabel = normalizeText([
    action?.name,
    action?.title,
    action?.href,
  ].filter(Boolean).join(" "), 600);
  const riskLabel = normalizeText([
    primaryLabel,
    action?.context,
  ].filter(Boolean).join(" "), 600);
  if (!action || action.disabled) {
    return { safe: false, category: "blocked", reason: "disabled" };
  }
  if (["submit", "reset", "image"].includes(action.type) || action.formAction) {
    return { safe: false, category: "blocked", reason: "form submission" };
  }
  if (action.download) {
    return { safe: false, category: "blocked", reason: "file download" };
  }
  if (DANGEROUS_ACTION_PATTERN.test(riskLabel)) {
    return { safe: false, category: "blocked", reason: "potential side effect" };
  }
  if (action.href) {
    let href;
    try {
      href = new URL(action.href, rootUrl);
    } catch {
      return { safe: false, category: "blocked", reason: "invalid destination" };
    }
    if (!["http:", "https:", "file:"].includes(href.protocol)) {
      return { safe: false, category: "blocked", reason: "unsupported destination" };
    }
    if (!sameSiteOrigin(href.href, rootUrl)) {
      return { safe: false, category: "blocked", reason: "external destination" };
    }
    return {
      safe: true,
      category: "navigation",
      reason: "same-origin navigation",
      destination: canonicalizePageUrl(href.href),
    };
  }
  if (
    action.tag === "summary"
    || action.role === "tab"
    || typeof action.expanded === "boolean"
    || action.hasPopup
    || SAFE_DISCLOSURE_PATTERN.test(primaryLabel)
  ) {
    return { safe: true, category: "disclosure", reason: "read-only UI state" };
  }
  return { safe: false, category: "blocked", reason: "unclassified button" };
}

export function hashText(value) {
  const text = String(value || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function stateFingerprint(snapshot) {
  const localActionNames = (snapshot?.actions || [])
    .filter((action) => !action.href)
    .map((action) => [
      action.role,
      normalizeText(action.name, 80),
      typeof action.expanded === "boolean" ? `expanded:${action.expanded}` : "",
    ].join(":"))
    .sort()
    .slice(0, 120)
    .join("|");
  const headings = (snapshot?.headings || [])
    .map((heading) => `${heading.level}:${normalizeText(heading.text, 100)}`)
    .join("|");
  const dialogs = (snapshot?.dialogs || [])
    .map((dialog) => normalizeText(dialog, 120))
    .sort()
    .join("|");
  const signals = snapshot?.stateSignals || {};
  const selected = (signals.selected || [])
    .map((value) => normalizeText(value, 120))
    .sort()
    .join("|");
  const expanded = (signals.expanded || [])
    .map((value) => normalizeText(value, 120))
    .sort()
    .join("|");
  const tableHeaders = (signals.tableHeaders || [])
    .map((value) => normalizeText(value, 120))
    .sort()
    .join("|");
  return hashText([
    canonicalizePageUrl(snapshot.url),
    normalizeText(snapshot.title),
    headings,
    dialogs,
    selected,
    expanded,
    tableHeaders,
    signals.mainTextHash || "",
    signals.formSchemaHash || "",
    localActionNames,
  ].join("\n"));
}

export function queueFingerprint(item) {
  return hashText([
    canonicalizePageUrl(item.baseUrl),
    ...(item.actionPath || []).map((action) => action.key),
  ].join("\n"));
}

export function safeFilename(value) {
  return normalizeText(value, 80)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "site-capability-index";
}

function markdownCell(value) {
  return normalizeText(value, 300).replace(/\|/g, "\\|");
}

function exportActionKey(action) {
  return action.semanticKey || [
    action.category || "",
    action.role || "",
    normalizeText(action.name, 160).toLowerCase(),
    action.destination || "",
  ].join("|");
}

function uniqueActions(actions = []) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = exportActionKey(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sharedActionKeys(screens) {
  const counts = new Map();
  for (const screen of screens) {
    const screenKeys = new Set();
    for (const action of uniqueActions(screen.safeActions)) {
      const key = exportActionKey(action);
      if (screenKeys.has(key)) continue;
      screenKeys.add(key);
      const current = counts.get(key) || { action, count: 0 };
      current.count += 1;
      counts.set(key, current);
    }
  }
  const threshold = Math.max(2, Math.ceil(screens.length * 0.6));
  return new Map(
    [...counts].filter(([, value]) => value.count >= threshold),
  );
}

function appendCompactActions(lines, actions) {
  const groups = new Map();
  for (const action of uniqueActions(actions)) {
    const groupKey = action.category === "navigation"
      ? `navigation|${exportActionKey(action)}`
      : `${action.category}|${action.role || "control"}|${action.family || ""}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(action);
  }
  for (const group of groups.values()) {
    if (group.length > 12 && group[0].category !== "navigation") {
      const names = [...new Set(group.map((action) => normalizeText(action.name, 100)))];
      const visibleNames = names.slice(0, 12);
      const remaining = Math.max(0, names.length - visibleNames.length);
      const suffix = remaining ? `; … +${remaining} controls` : "";
      lines.push(
        `- collection/${group[0].role || "control"} (${group.length}): ${visibleNames.join("; ")}${suffix}`,
      );
      continue;
    }
    for (const action of group) {
      const suffix = action.destination ? ` → ${action.destination}` : "";
      lines.push(`- ${action.category}: ${normalizeText(action.name)}${suffix}`);
    }
  }
}

function formatDurationMs(value) {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function buildCapabilityMarkdown(index) {
  if (!index?.screens?.length) return "# Site capability index\n\nNo screens were indexed.\n";
  const screens = index.screens;
  const sharedActions = sharedActionKeys(screens);
  const transitions = [];
  const transitionKeys = new Set();
  for (const transition of index.transitions || []) {
    if (!transition?.from || transition.from === transition.to) continue;
    const key = [
      transition.from,
      transition.to || "",
      normalizeText(transition.action, 160).toLowerCase(),
    ].join("|");
    if (transitionKeys.has(key)) continue;
    transitionKeys.add(key);
    transitions.push(transition);
  }
  const routeGroups = new Map();
  for (const screen of screens) {
    const route = screen.route || screen.url;
    if (!routeGroups.has(route)) routeGroups.set(route, []);
    routeGroups.get(route).push(screen);
  }
  const lines = [
    `# ${normalizeText(index.siteTitle) || "Site capability index"}`,
    "",
    `- Origin: ${index.origin}`,
    `- Start URL: ${index.startUrl}`,
    `- Generated: ${index.completedAt || index.updatedAt || index.startedAt}`,
    `- Build duration: ${formatDurationMs(
      Math.max(
        0,
        new Date(index.completedAt || index.updatedAt || index.startedAt).getTime()
          - new Date(index.startedAt).getTime(),
      ),
    )}`,
    `- Average job time: ${formatDurationMs(
      (index.totalJobDurationMs || 0) / Math.max(1, index.processedJobCount || screens.length),
    )}`,
    `- Routes indexed: ${routeGroups.size}`,
    `- UI states indexed: ${screens.length}`,
    `- Transitions mapped: ${transitions.length}`,
    `- Parallel workers: ${index.workerCount || 1}`,
    `- No-op actions skipped: ${index.noOpActionCount || 0}`,
    `- Repeated branches pruned: ${index.prunedActionCount || 0}`,
    `- Build mode: deterministic code only (no LLM)`,
    "",
    "## Shared capabilities",
    "",
  ];

  if (sharedActions.size) {
    appendCompactActions(
      lines,
      [...sharedActions.values()].map((value) => value.action),
    );
  } else {
    lines.push("No capabilities were common to most screens.");
  }

  lines.push(
    "",
    "## Route map",
    "",
    "| States | Route | Screen | Local features |",
    "| --- | --- | --- | --- |",
  );

  for (const [route, routeScreens] of routeGroups) {
    const localFeatures = [];
    for (const screen of routeScreens) {
      for (const action of uniqueActions(screen.safeActions)) {
        if (!sharedActions.has(exportActionKey(action))) localFeatures.push(action.name);
      }
      for (const form of screen.forms || []) localFeatures.push(form.name || "Form");
    }
    const features = [...new Set(localFeatures.filter(Boolean))];
    const stateIds = routeScreens.map((screen) => screen.id).join(", ");
    const titles = [...new Set(routeScreens.map((screen) => screen.title).filter(Boolean))];
    lines.push(
      `| ${stateIds} | ${markdownCell(route)} | ${markdownCell(titles.join(" / "))} | ${markdownCell(features.slice(0, 8).join(", "))} |`,
    );
  }

  const slowestScreens = [...screens]
    .filter((screen) => Number.isFinite(screen.scanDurationMs))
    .sort((left, right) => right.scanDurationMs - left.scanDurationMs)
    .slice(0, 5);
  if (slowestScreens.length) {
    lines.push(
      "",
      "## Slowest scans",
      "",
      "| Time | Worker | Route |",
      "| --- | --- | --- |",
    );
    for (const screen of slowestScreens) {
      lines.push(
        `| ${formatDurationMs(screen.scanDurationMs)} | ${screen.workerId || "worker"} | ${markdownCell(screen.route || screen.url)} |`,
      );
    }
  }

  lines.push("", "## UI states", "");
  for (const screen of screens) {
    lines.push(
      `### ${screen.id} — ${normalizeText(screen.title) || screen.route}`,
      "",
      `- URL: ${screen.url}`,
      `- Route: ${screen.route}`,
      `- State fingerprint: \`${screen.fingerprint}\``,
      `- Discovery depth: ${screen.depth}`,
    );
    if (Number.isFinite(screen.scanDurationMs)) {
      lines.push(
        `- Scan: ${formatDurationMs(screen.scanDurationMs)} on ${screen.workerId || "worker"}`,
      );
    }
    if (screen.discoveredVia) {
      lines.push(`- Discovered via: ${normalizeText(screen.discoveredVia)}`);
    }
    if (screen.headings?.length) {
      lines.push("", "Headings:", "");
      for (const heading of screen.headings) {
        lines.push(`- H${heading.level}: ${normalizeText(heading.text)}`);
      }
    }
    const stateSignals = [
      ...(screen.selectedStates || []).map((value) => `selected: ${value}`),
      ...(screen.expandedStates || []).map((value) => `expanded: ${value}`),
    ];
    if (stateSignals.length) {
      lines.push("", `State signals: ${normalizeText(stateSignals.join("; "), 600)}`);
    }
    if (screen.tableHeaders?.length) {
      lines.push(
        "",
        `Table columns: ${normalizeText([...new Set(screen.tableHeaders)].join(", "), 600)}`,
      );
    }
    const localActions = uniqueActions(screen.safeActions)
      .filter((action) => !sharedActions.has(exportActionKey(action)));
    if (localActions.length) {
      lines.push("", "Screen-specific capabilities:", "");
      appendCompactActions(lines, localActions);
    }
    if (screen.forms?.length) {
      lines.push("", "Forms and fields:", "");
      for (const form of screen.forms) {
        const fields = (form.fields || [])
          .map((field) => `${field.label || field.name || field.type} (${field.type})`)
          .join(", ");
        lines.push(`- ${normalizeText(form.name) || "Form"}: ${normalizeText(fields, 500)}`);
      }
    }
    if (screen.blockedActionCount) {
      lines.push(
        "",
        `Safety note: ${screen.blockedActionCount} unclassified or potentially consequential controls were recorded but not clicked.`,
      );
    }
    lines.push("");
  }

  lines.push("## Transitions", "");
  if (!transitions.length) {
    lines.push("No transitions were mapped.");
  } else {
    for (const transition of transitions) {
      lines.push(
        `- ${transition.from} -- ${normalizeText(transition.action)} --> ${transition.to || "unresolved"}`,
      );
    }
  }

  lines.push(
    "",
    "## Usage guidance",
    "",
    "This index is a navigation aid, not a source of live element references. Re-scan the current page immediately before every action and verify the page again afterward.",
    "",
  );
  return `${lines.join("\n")}\n`;
}
