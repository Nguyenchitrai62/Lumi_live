import { HICAS_SKILL_TOOL_NAME } from "../live/hicas-tools.js";

const INDEX_URL = globalThis.chrome?.runtime?.getURL
  ? chrome.runtime.getURL("skills/hicas-erp-qc/runtime-index.json")
  : "skills/hicas-erp-qc/runtime-index.json";
const MAX_CONTEXT_CHARS = 12000;
const MAX_RESPONSE_CHARS = 18000;
const HICAS_HOST = "sit.hawee.hicas.vn";

function clean(value, maxLength = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function parseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.hostname.toLowerCase() === HICAS_HOST ? url : null;
  } catch {
    return null;
  }
}

function routePattern(template) {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped
    .replace(/\\\{project_id\\\}/g, "[^/]+")
    .replace(/\\\{entity_id\\\}/g, "[^/]+")}/?$`, "i");
}

function routeForUrl(index, url) {
  if (!url) return null;
  const routeUrl = `${url.pathname}${url.search}`;
  const exact = index.routes.find((route) => route.template === routeUrl)
    || index.routes.find((route) => route.template === url.pathname);
  if (exact) return exact;
  return index.routes.find((route) =>
    routePattern(route.template).test(routeUrl)
    || routePattern(route.template).test(url.pathname)) || null;
}

function scoreDocument(document, terms, sections, route) {
  let score = 0;
  const name = document.module.toLowerCase();
  if (sections.includes(name)) score += 40;
  if (route?.source === document.name) score += 35;
  const haystack = `${document.name}\n${document.content}`.toLowerCase();
  for (const term of terms) if (haystack.includes(term)) score += Math.min(12, term.length);
  if (document.name === "SKILL.md") score += 8;
  if (name === "coverage") score += 5;
  if (name === "navigation") score += 5;
  return score;
}

function selectedContent(document, terms) {
  if (!terms.length) return document.content;
  const lines = document.content.split(/\r?\n/);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = lines[index].toLowerCase();
    if (!terms.some((term) => normalized.includes(term))) continue;
    const start = Math.max(0, index - 3);
    const end = Math.min(lines.length, index + 7);
    matches.push(lines.slice(start, end).join("\n"));
  }
  return matches.length ? matches.join("\n\n") : document.content;
}

function selectCatalogRecords(records = [], { terms, route, module }) {
  return records
    .map((record) => {
      const haystack = [
        record.module,
        record.section,
        ...Object.values(record.values || {}),
      ].join(" ").toLowerCase();
      let score = record.module === module ? 25 : 0;
      if (route?.template && haystack.includes(route.template.toLowerCase())) score += 50;
      for (const term of terms) if (haystack.includes(term)) score += Math.min(10, term.length);
      return { record, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 20)
    .map(({ record }) => record);
}

function recordMatchesRoute(record, route) {
  if (!record?.fast_path_eligible || !route?.template) return false;
  return Object.values(record.values || {})
    .some((value) => String(value).includes(route.template));
}

export function createHicasSkillRuntime({ fetchImpl = fetch } = {}) {
  let indexPromise = null;
  const preparedRoutes = new Map();

  async function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetchImpl(INDEX_URL, { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("Packaged HICAS skill index is unavailable.");
        const value = await response.json();
        if (value?.skill !== "hicas-erp-qc" || value?.domain !== HICAS_HOST) {
          throw new Error("Packaged HICAS skill index failed identity validation.");
        }
        return value;
      });
    }
    return indexPromise;
  }

  async function lookup(args = {}, activeUrl = "") {
    const index = await loadIndex();
    const url = parseUrl(args.url || activeUrl);
    if (!url) throw new Error(`The ${HICAS_SKILL_TOOL_NAME} tool is restricted to ${HICAS_HOST}.`);
    const route = routeForUrl(index, url);
    const sections = (args.sections || [])
      .map((value) => clean(value, 80).toLowerCase())
      .filter(Boolean);
    const terms = [
      clean(args.module, 120),
      clean(args.query, 500),
      url.pathname,
      route?.template || "",
    ].join(" ").toLowerCase().split(/[^a-z0-9À-ỹ_#./{}-]+/i).filter((term) => term.length >= 3);
    const ranked = [...index.documents]
      .map((document) => ({
        document,
        score: scoreDocument(document, terms, sections, route),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);
    let remaining = MAX_CONTEXT_CHARS;
    const context = [];
    for (const item of ranked) {
      const content = selectedContent(item.document, terms).slice(0, remaining);
      if (!content) continue;
      context.push({ source: item.document.name, content });
      remaining -= content.length;
      if (remaining <= 0) break;
    }
    const catalogQuery = {
      terms,
      route,
      module: clean(args.module, 120).toLowerCase() || route?.module || "",
    };
    const catalog = Object.fromEntries(
      Object.entries(index.catalogs || {}).map(([name, records]) => [
        name,
        selectCatalogRecords(records, catalogQuery),
      ]),
    );
    const fastControls = (catalog.buttons || [])
      .filter((record) => recordMatchesRoute(record, route))
      .slice(0, 40);
    const routeKey = route?.template || url.pathname;
    preparedRoutes.set(routeKey, {
      preparedAt: Date.now(),
      sourceSha256: index.source_sha256,
    });
    const response = {
      success: true,
      skill: index.skill,
      skillVersion: index.skill_version,
      sourceSha256: index.source_sha256,
      domain: index.domain,
      route: route || {
        template: url.pathname,
        coverage_status: "needs_review",
        source: "",
      },
      policies: index.policies,
      fastPath: {
        allowed: route?.coverage_status !== "unavailable" && fastControls.length > 0,
        controls: fastControls,
        rule: "Only verified records may use fast path; observe again before every action.",
      },
      catalog,
      context,
    };
    while (JSON.stringify(response).length > MAX_RESPONSE_CHARS) {
      const populated = Object.values(response.catalog)
        .filter((records) => records.length)
        .sort((left, right) => right.length - left.length)[0];
      if (populated) {
        populated.pop();
        continue;
      }
      const lastContext = response.context.at(-1);
      if (!lastContext) break;
      if (lastContext.content.length > 1000) {
        lastContext.content = lastContext.content.slice(0, lastContext.content.length - 1000);
      } else {
        response.context.pop();
      }
    }
    return response;
  }

  async function actionGate(urlValue) {
    const index = await loadIndex();
    const url = parseUrl(urlValue);
    if (!url) return { required: false };
    const route = routeForUrl(index, url);
    const routeKey = route?.template || url.pathname;
    if (!preparedRoutes.has(routeKey)) {
      return {
        required: true,
        prepared: false,
        error: `HICAS knowledge is required for ${routeKey}. Call ${HICAS_SKILL_TOOL_NAME} for the current route before a browser action.`,
      };
    }
    return {
      required: true,
      prepared: true,
      route,
      fastPathAllowed: route?.coverage_status !== "unavailable"
        && (index.catalogs?.buttons || []).some((record) =>
          recordMatchesRoute(record, route)),
    };
  }

  async function verifiedControl({ url: urlValue, recordId } = {}) {
    const index = await loadIndex();
    const url = parseUrl(urlValue);
    const route = routeForUrl(index, url);
    const record = (index.catalogs?.buttons || []).find(
      (candidate) => candidate.record_id === clean(recordId, 100),
    );
    const allowed = Boolean(
      url
      && route
      && route.coverage_status !== "unavailable"
      && recordMatchesRoute(record, route),
    );
    return {
      allowed,
      route,
      record: allowed ? record : null,
      reason: allowed ? "verified_skill_control" : "step_mode_required",
    };
  }

  function clearPreparedRoute(urlValue) {
    const url = parseUrl(urlValue);
    if (!url) return;
    for (const key of preparedRoutes.keys()) {
      if (routePattern(key).test(url.pathname)) preparedRoutes.delete(key);
    }
  }

  async function routeMetadata(urlValue) {
    const index = await loadIndex();
    const url = parseUrl(urlValue);
    if (!url) return null;
    const route = routeForUrl(index, url);
    if (!route) return null;
    const records = Object.values(index.catalogs || {}).flat()
      .filter((record) => {
        const haystack = Object.values(record.values || {}).join(" ");
        return haystack.includes(route.template);
      });
    return {
      skillVersion: index.skill_version,
      sourceSha256: index.source_sha256,
      route,
      fastPathAllowed: route.coverage_status !== "unavailable"
        && records.some((record) => recordMatchesRoute(record, route)),
    };
  }

  return {
    loadIndex,
    lookup,
    actionGate,
    verifiedControl,
    clearPreparedRoute,
    routeMetadata,
  };
}
