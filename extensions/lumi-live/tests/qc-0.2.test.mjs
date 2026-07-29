import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { redactHistoryText } from "../side-panel/conversation-history.js";
import { createHicasSkillRuntime } from "../side-panel/hicas-skill-runtime.js";

const skillRoot = new URL("../skills/hicas-erp-qc/", import.meta.url);

async function skillSourceFiles() {
  const references = (await readdir(new URL("references/", skillRoot)))
    .filter((name) => name.endsWith(".md"))
    .sort();
  const names = [
    "SKILL.md",
    "agents/openai.yaml",
    ...references.map((name) => `references/${name}`),
  ];
  return Promise.all(names.map(async (name) => ({
    name,
    content: await readFile(new URL(name, skillRoot), "utf8"),
  })));
}

test("packaged HICAS index matches sanitized source and exposes guarded catalogs", async () => {
  const index = JSON.parse(await readFile(new URL("runtime-index.json", skillRoot), "utf8"));
  const sources = await skillSourceFiles();
  const sourceHash = createHash("sha256");
  for (const source of sources) sourceHash.update(`${source.name}\0${source.content}\0`, "utf8");
  assert.equal(index.schema_version, "1.1");
  assert.equal(index.skill_version, "0.2.0");
  assert.equal(index.source_sha256, sourceHash.digest("hex"));
  assert.ok(index.routes.length >= 85);
  assert.ok(index.catalogs.buttons.length > 0);
  assert.ok(index.catalogs.fields.length > 0);
  assert.ok(index.catalogs.workflows.length > 0);
  assert.ok(index.catalogs.coverage.length > 0);
  assert.ok(index.routes.every((route) => /^[a-f0-9]{64}$/.test(route.fingerprint)));
  const sourceText = sources.map((source) => source.content).join("\n");
  assert.doesNotMatch(sourceText, /\bAIza[A-Za-z0-9_-]{30,}\b/);
  assert.doesNotMatch(
    sourceText.replace(/\{project_id\}|\{entity_id\}|\{run-id\}/gi, ""),
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  );
});

test("HICAS lookup is route-scoped, bounded, and observed controls cannot use fast path", async () => {
  const index = JSON.parse(await readFile(new URL("runtime-index.json", skillRoot), "utf8"));
  const runtime = createHicasSkillRuntime({
    fetchImpl: async () => ({ ok: true, json: async () => index }),
  });
  const url = "https://sit.hawee.hicas.vn/admin/banner";
  const before = await runtime.actionGate(url);
  assert.equal(before.required, true);
  assert.equal(before.prepared, false);
  const lookup = await runtime.lookup({
    url,
    module: "administration",
    query: "button field coverage",
  });
  assert.equal(lookup.route.template, "/admin/banner");
  assert.equal(lookup.fastPath.allowed, false);
  assert.ok(JSON.stringify(lookup).length <= 18000);
  const after = await runtime.actionGate(url);
  assert.equal(after.prepared, true);
  assert.equal(after.fastPathAllowed, false);
});

test("fast path requires an exact verified skill control record", async () => {
  const index = JSON.parse(await readFile(new URL("runtime-index.json", skillRoot), "utf8"));
  const runtime = createHicasSkillRuntime({
    fetchImpl: async () => ({ ok: true, json: async () => index }),
  });
  const url = "https://sit.hawee.hicas.vn/tong-quan?tab=du-an";
  const lookup = await runtime.lookup({
    url,
    module: "enterprise",
    query: "Project tab",
    sections: ["buttons"],
  });
  const projectTab = lookup.fastPath.controls.find(
    (record) => record.values?.Control === "Project tab",
  );
  assert.ok(projectTab?.record_id);
  assert.equal(lookup.fastPath.allowed, true);
  assert.equal((await runtime.verifiedControl({
    url,
    recordId: projectTab.record_id,
  })).allowed, true);
  assert.equal((await runtime.verifiedControl({
    url,
    recordId: "model-invented-selector",
  })).allowed, false);
});

test("history redaction removes provider keys, bearer tokens, and ERP account pairs", () => {
  const providerKey = `AI${"za"}SyABCDEFGHIJKLMNOPQRSTUVWXYZ123456`;
  const examplePassword = "ExampleOnly!42";
  const redacted = redactHistoryText(
    `key=${providerKey} tk: admin/${examplePassword} `
    + "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
  );
  assert.doesNotMatch(redacted, /AIzaSy/);
  assert.doesNotMatch(redacted, /ExampleOnly/);
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(redacted, /REDACTED/);
});

test("0.2.0 manifest and UI include history, alerts, compare, schedules, and explicit bug send", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const html = await readFile(new URL("../side-panel/index.html", import.meta.url), "utf8");
  const panel = await readFile(new URL("../side-panel/index.js", import.meta.url), "utf8");
  const background = await readFile(new URL("../background/index.js", import.meta.url), "utf8");
  const diagnostics = await readFile(
    new URL("../browser/runtime-diagnostics.js", import.meta.url),
    "utf8",
  );
  assert.equal(manifest.version, "0.2.0");
  for (const permission of ["alarms", "notifications", "unlimitedStorage"]) {
    assert.ok(manifest.permissions.includes(permission));
  }
  for (const id of [
    "historyDrawer",
    "runAttention",
    "qcCompileComparisonButton",
    "qcCreateScheduleButton",
    "qcBugDraftList",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(panel, /redmine_create_issue/);
  assert.match(panel, /window\.confirm\([^]*similar open issue/);
  assert.match(background, /QC_SCHEDULE_ALARM_PREFIX/);
  assert.match(background, /sidePanelPorts\.size === 0/);
  assert.match(background, /target_fingerprint/);
  assert.match(background, /chrome\.alarms\.onAlarm/);
  assert.match(background, /collect_runtime_diagnostics/);
  assert.match(panel, /runtimeDiagnostics/);
  assert.match(panel, /consoleErrors/);
  assert.match(panel, /networkErrors/);
  assert.match(diagnostics, /installRuntimeDiagnosticsProbeInPage/);
  assert.doesNotMatch(diagnostics, /requestBody|requestHeaders|responseBody/);
});
