import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FALLBACK_MODEL,
  MODEL,
  BUILTIN_TOOLS,
  buildSessionInstruction,
} from "../live/session-config.js";
import { QC_TOOLS, QC_TOOL_NAMES, isQcTool } from "../live/qc-tools.js";
import { normalizeQcServiceUrl } from "../side-panel/qc-service-client.js";
import { qcPhaseForAction } from "../live/task-orchestrator.js";

const extensionRoot = new URL("../", import.meta.url);

test("publishes strict local QC tools without exposing approval tokens", () => {
  assert.equal(MODEL, "gemini-3.1-flash-live-preview");
  assert.equal(FALLBACK_MODEL, "gemini-2.5-flash-native-audio-preview-12-2025");
  assert.ok(QC_TOOLS.length >= 8);
  assert.ok(BUILTIN_TOOLS.some((tool) => tool.name === QC_TOOL_NAMES.getRunPlan));
  assert.ok(isQcTool(QC_TOOL_NAMES.recordStep));
  assert.ok(isQcTool(QC_TOOL_NAMES.createPromptPlan));
  assert.ok(isQcTool(QC_TOOL_NAMES.recordComparisonActual));
  assert.ok(isQcTool(QC_TOOL_NAMES.prepareBugDraft));
  assert.equal(
    QC_TOOLS.some((tool) =>
      Object.keys(tool.parameters?.properties || {}).some((name) => /approval.?token/i.test(name))),
    false,
  );
  const instruction = buildSessionInstruction(null, null);
  assert.match(instruction, /local QC service is the source of\s+truth/i);
  assert.match(instruction, /extension, not the model, injects confirmation/i);
});

test("maps agent actions onto the explicit QC lifecycle", () => {
  assert.equal(qcPhaseForAction("qc_get_run_plan"), "PLAN");
  assert.equal(qcPhaseForAction("qc_begin_step"), "OBSERVE");
  assert.equal(qcPhaseForAction("browser_click", "browser_action"), "ACT");
  assert.equal(qcPhaseForAction("browser_wait_for_page_state", "browser_observation"), "STABILIZE");
  assert.equal(qcPhaseForAction("qc_record_step"), "RECORD");
  assert.equal(qcPhaseForAction("qc_complete_run"), "COMPLETE");
});

test("allows only loopback HTTP endpoints for the local QC service", () => {
  assert.equal(normalizeQcServiceUrl("http://127.0.0.1:8765/"), "http://127.0.0.1:8765");
  assert.equal(normalizeQcServiceUrl("http://localhost:9000"), "http://localhost:9000");
  assert.throws(() => normalizeQcServiceUrl("https://127.0.0.1:8765"), /must use http/);
  assert.throws(() => normalizeQcServiceUrl("http://erp.example.com"), /must use http/);
});

test("side panel keeps QC controls in chat while preserving the action gate", async () => {
  const html = await readFile(new URL("side-panel/index.html", extensionRoot), "utf8");
  const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionRoot), "utf8"));
  const styles = await readFile(new URL("side-panel/styles.css", extensionRoot), "utf8");
  const controller = await readFile(new URL("side-panel/index.js", extensionRoot), "utf8");
  const workspace = await readFile(
    new URL("side-panel/qc-workspace-controller.js", extensionRoot),
    "utf8",
  );
  for (const id of [
    "qcWorkspace",
    "qcWorkbookInput",
    "qcAllowedDomains",
    "qcCompileButton",
    "qcApproveButton",
    "qcStartRunButton",
    "qcPauseRunButton",
    "qcResumeRunButton",
    "qcCancelRunButton",
    "qcApproveStepButton",
    "qcDownloadExcel",
    "qcDownloadHtml",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(controller, /qcWorkspace\.authorizeBrowserAction/);
  assert.match(controller, /qcWorkspace\.recordAgentEvent/);
  assert.match(controller, /function renderQcRunCard/);
  assert.match(controller, /qcWorkspace\.compileWorkbook/);
  assert.match(html, /id="qcWorkspace"[^>]*hidden[^>]*inert/);
  assert.match(html, /id="imageAttachmentInput"[\s\S]*?\.xlsx/);
  assert.match(workspace, /QC policy requires qc_begin_step/);
  assert.match(workspace, /approval_token:\s*approvalToken/);
  assert.doesNotMatch(workspace, /approval_token:\s*args\./);
  assert.match(workspace, /chrome\.storage\.session/);
  assert.match(manifest.content_security_policy.extension_pages, /ws:\/\/127\.0\.0\.1:\*/);
  assert.match(styles, /grid-template-rows:\s*auto auto auto minmax\(0,\s*1fr\) auto/);
  assert.match(styles, /\.qc-workspace\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(styles, /\.qc-chat-card/);
});

test("QC service configuration lives in Settings instead of the conversation chrome", async () => {
  const settingsHtml = await readFile(new URL("settings/index.html", extensionRoot), "utf8");
  const settingsController = await readFile(new URL("settings/index.js", extensionRoot), "utf8");
  for (const id of [
    "qcServiceUrlInput",
    "qcServiceTokenInput",
    "qcAllowedDomainsInput",
    "qcDiscoveryModeInput",
    "qcTestServiceButton",
    "qcSaveSettingsButton",
  ]) {
    assert.match(settingsHtml, new RegExp(`id="${id}"`));
  }
  assert.match(settingsController, /STORAGE_KEYS\.qcServiceToken/);
  assert.match(settingsController, /function normalizeQcServiceUrl/);
});
