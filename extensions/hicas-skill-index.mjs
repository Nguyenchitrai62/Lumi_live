import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HICAS_SKILL_DIRECTORY = path.join(
  moduleDirectory,
  "lumi-live",
  "skills",
  "hicas-erp-qc",
);

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const GOOGLE_KEY_PATTERN = /\bAIza[A-Za-z0-9_-]{30,}\b/;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[_ -]?key|password|passwd|secret|bearer|authorization|cookie|session[_ -]?(?:id|token))\s*[:=]\s*["']?[^<{\s][^\r\n"']{5,}/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function normalizedCell(value) {
  return String(value || "").replace(/`/g, "").replace(/\s+/g, " ").trim();
}

function canonicalCoverageStatus(value) {
  const status = normalizedCell(value).toLowerCase();
  if (status === "verified") return "verified";
  if (status.includes("role_unverified")) return "role_unverified";
  if (status.includes("blocked_by_policy")) return "blocked_by_policy";
  if (status.includes("blocked_by_prerequisite")) return "blocked_by_prerequisite";
  if (status.includes("observed_partial")) return "observed_partial";
  if (
    status.includes("unavailable")
    || status.includes("placeholder")
    || status.includes("404")
    || status.includes("empty shell")
  ) return "unavailable";
  return "observed";
}

function parseMarkdownTables(content, source) {
  const records = [];
  const lines = content.split(/\r?\n/);
  let section = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s+/.test(line)) section = line.replace(/^#{1,6}\s+/, "").trim();
    if (!line.trim().startsWith("|") || index + 1 >= lines.length) continue;
    const separator = lines[index + 1];
    if (!/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(separator)) continue;
    const headers = line.split("|").slice(1, -1).map(normalizedCell);
    index += 2;
    while (index < lines.length && lines[index].trim().startsWith("|")) {
      const cells = lines[index].split("|").slice(1, -1).map(normalizedCell);
      const values = Object.fromEntries(headers.map((header, cellIndex) => [
        header || `column_${cellIndex + 1}`,
        cells[cellIndex] || "",
      ]));
      const status = Object.entries(values).find(([key]) => /status|trạng thái/i.test(key))?.[1] || "";
      records.push({
        source,
        section,
        values,
        coverage_status: canonicalCoverageStatus(status),
        coverage_detail: normalizedCell(status),
        fast_path_eligible: normalizedCell(status).toLowerCase() === "verified",
      });
      index += 1;
    }
    index -= 1;
  }
  return records;
}

function moduleFromSource(source) {
  const name = path.basename(source, path.extname(source));
  const aliases = {
    "project-and-boq": "project_boq",
    "data-dictionary": "data_dictionary",
  };
  return aliases[name] || name.replace(/-/g, "_");
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function parseRoutes(documents) {
  const routeMap = new Map();
  for (const document of documents) {
    for (const match of document.content.matchAll(/`(\/[^`\s]+)`/g)) {
      const template = match[1]
        .replace(/[),.;]+$/g, "")
        .replace(/\/+/g, "/");
      if (!routeMap.has(template)) {
        const nearby = document.content.slice(match.index, match.index + 260);
        const unavailable = /unavailable|placeholder|404|empty shell|sắp ra mắt|coming soon/i.test(nearby);
        routeMap.set(template, {
          template,
          source: document.name,
          module: moduleFromSource(document.name),
          coverage_status: unavailable ? "unavailable" : "observed",
        });
      }
    }
  }
  for (const record of documents.flatMap((document) => document.records)) {
    const route = Object.entries(record.values)
      .find(([key, value]) => /route|url/i.test(key) && String(value).startsWith("/"))?.[1];
    if (!route) continue;
    const existing = routeMap.get(route) || {
      template: route,
      source: record.source,
      module: moduleFromSource(record.source),
      coverage_status: "observed",
    };
    const rowText = Object.values(record.values).join(" ");
    if (/unavailable|placeholder|404|empty shell|sắp ra mắt|coming soon/i.test(rowText)) {
      existing.coverage_status = "unavailable";
    }
    if (record.coverage_status) existing.coverage_status = record.coverage_status;
    routeMap.set(route, existing);
  }
  return [...routeMap.values()]
    .map((route) => ({
      ...route,
      fingerprint: fingerprint({
        template: route.template,
        module: route.module,
        coverage_status: route.coverage_status,
        records: documents.flatMap((document) => document.records)
          .filter((record) =>
            Object.values(record.values).some((value) =>
              String(value).includes(route.template))),
      }),
    }))
    .sort((left, right) => left.template.localeCompare(right.template));
}

function recordCatalog(documents, sourceName) {
  return documents
    .filter((document) => document.name === `references/${sourceName}.md`)
    .flatMap((document) => document.records)
    .map((record) => ({
      ...record,
      module: moduleFromSource(record.source),
      record_id: fingerprint({
        source: record.source,
        section: record.section,
        values: record.values,
      }).slice(0, 20),
    }));
}

function sectionCatalog(documents, sourceName) {
  const document = documents.find(
    (item) => item.name === `references/${sourceName}.md`,
  );
  if (!document) return [];
  return [...document.content.matchAll(/^#{2,4}\s+(.+)$/gm)]
    .map((match) => normalizedCell(match[1]))
    .filter((section) => section && section.toLowerCase() !== "contents")
    .map((section) => ({
      source: document.name,
      section,
      values: {
        name: section,
        source: document.name,
      },
      coverage_status: "observed",
      fast_path_eligible: false,
      module: moduleFromSource(document.name),
      record_id: fingerprint({
        source: document.name,
        section,
      }).slice(0, 20),
    }));
}

function assertSanitizedSkill(files) {
  for (const file of files) {
    const redacted = file.content
      .replace(/\{project_id\}|\{entity_id\}|\{run-id\}/gi, "");
    const findings = [
      UUID_PATTERN.test(redacted) && "UUID",
      GOOGLE_KEY_PATTERN.test(redacted) && "Google API key",
      SECRET_ASSIGNMENT_PATTERN.test(redacted) && "credential assignment",
      EMAIL_PATTERN.test(redacted) && "email address",
    ].filter(Boolean);
    if (findings.length) {
      throw new Error(`${file.name} contains forbidden ${findings.join(", ")} data.`);
    }
  }
}

export async function buildHicasSkillIndex(
  skillDirectory = DEFAULT_HICAS_SKILL_DIRECTORY,
) {
  const skillPath = path.resolve(skillDirectory);
  const skillMarkdown = await readFile(path.join(skillPath, "SKILL.md"), "utf8");
  if (!/^---\s*\r?\nname:\s*hicas-erp-qc\s*$/m.test(skillMarkdown)) {
    throw new Error("HICAS skill frontmatter is missing name: hicas-erp-qc.");
  }
  const referenceDirectory = path.join(skillPath, "references");
  const referenceNames = (await readdir(referenceDirectory))
    .filter((name) => name.endsWith(".md"))
    .sort();
  const agentConfiguration = await readFile(
    path.join(skillPath, "agents", "openai.yaml"),
    "utf8",
  );
  const files = [
    { name: "SKILL.md", content: skillMarkdown },
    { name: "agents/openai.yaml", content: agentConfiguration },
    ...await Promise.all(referenceNames.map(async (name) => ({
      name: `references/${name}`,
      content: await readFile(path.join(referenceDirectory, name), "utf8"),
    }))),
  ];
  assertSanitizedSkill(files);
  const sourceSha256 = createHash("sha256");
  for (const file of files) sourceSha256.update(`${file.name}\0${file.content}\0`, "utf8");
  const documents = files
    .filter((file) => file.name.endsWith(".md"))
    .map((file) => ({
    name: file.name,
    module: path.basename(file.name, ".md"),
    content: file.content,
    records: parseMarkdownTables(file.content, file.name),
    }));
  const routes = parseRoutes(documents);
  const buttonCatalog = recordCatalog(documents, "buttons");
  const fieldCatalog = [
    ...recordCatalog(documents, "data-dictionary"),
    ...sectionCatalog(documents, "data-dictionary"),
  ];
  const workflowCatalog = [
    ...recordCatalog(documents, "workflows"),
    ...sectionCatalog(documents, "workflows"),
  ];
  const coverageCatalog = recordCatalog(documents, "coverage");
  const index = {
    schema_version: "1.1",
    skill: "hicas-erp-qc",
    skill_version: "0.2.0",
    domain: "sit.hawee.hicas.vn",
    source_sha256: sourceSha256.digest("hex"),
    generated_at: new Date().toISOString(),
    policies: {
      unidentified_project: "read_only",
      user_authorized_test_project: "exact_name_and_run_captured_id_scoped_mutation",
      newly_created_project: "run_created_scoped_mutation",
      shared_enterprise_data: "read_only",
      screenshot_existing_or_shared_data: "forbidden",
      action_loop: ["OBSERVE", "ACT", "STABILIZE", "VERIFY", "RECORD"],
    },
    routes,
    catalogs: {
      buttons: buttonCatalog,
      fields: fieldCatalog,
      workflows: workflowCatalog,
      coverage: coverageCatalog,
    },
    summary: {
      routes: routes.length,
      buttons: buttonCatalog.length,
      fields: fieldCatalog.length,
      workflows: workflowCatalog.length,
      coverage: coverageCatalog.length,
    },
    documents,
  };
  const outputPath = path.join(skillPath, "runtime-index.json");
  await writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return { index, outputPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { index, outputPath } = await buildHicasSkillIndex(process.argv[2]);
  console.log(`Built ${outputPath}`);
  console.log(`HICAS skill ${index.source_sha256} · ${index.routes.length} routes`);
}
