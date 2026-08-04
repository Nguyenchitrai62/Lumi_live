import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const extensionRoot = new URL("../", import.meta.url);
const projectRoot = new URL("../../../", import.meta.url);

test("Excel Understand and always-on XLSX editing are wired as local providers", async () => {
  const [controller, mcpController, config, registry, html, build] = await Promise.all([
    readFile(new URL("side-panel/index.js", extensionRoot), "utf8"),
    readFile(new URL("side-panel/mcp-panel-controller.js", extensionRoot), "utf8"),
    readFile(new URL("live/session-config.js", extensionRoot), "utf8"),
    readFile(new URL("documents/excel-registry.js", extensionRoot), "utf8"),
    readFile(new URL("side-panel/index.html", extensionRoot), "utf8"),
    readFile(new URL("extensions/build.mjs", projectRoot), "utf8"),
  ]);

  assert.match(controller, /\[LOCAL_EXCEL_PROVIDER\]/);
  assert.match(controller, /EXCEL_ANALYSIS_GUIDANCE/);
  assert.match(controller, /excelRegistry\.callTool/);
  assert.match(controller, /excelRegistry\.clear\(\)/);
  assert.match(controller, /documentParser\.dispose\(\)/);
  assert.match(config, /localProviders = \[\]/);
  assert.match(registry, /name: "excel_understand"/);
  assert.match(registry, /name: "excel_edit"/);
  assert.match(registry, /enum: \["overview", "read_range", "search", "formulas"\]/);
  assert.match(registry, /name: EXCEL_EDIT_SCHEMA\.name,[^]*permission: "allow"/);
  assert.match(controller, /createExcelDownloadMessage\(result\.download\)/);
  assert.match(controller, /dataset\.transientExcelExport/);
  assert.match(controller, /releaseExcelDownloadUrls\(\)/);
  assert.match(controller, /tool\.permission !== "allow"[^]*requestMcpToolPermission/);
  assert.match(mcpController, /if \(tool\.localProvider\) \{[^]*tool\.permission = "allow"/);
  for (const retiredTool of [
    "document_list",
    "document_get_structure",
    "document_search",
    "document_read_chunk",
    "spreadsheet_read_range",
  ]) {
    assert.doesNotMatch(registry, new RegExp(`name: "${retiredTool}"`));
  }
  assert.doesNotMatch(registry, /chrome\.storage|indexedDB/);
  assert.match(html, /accept="[^"]*\.xlsx[^"]*\.csv/);
  assert.match(html, /\bmultiple\b/);
  assert.doesNotMatch(html, /\.docx/);
  assert.match(build, /document-parser-worker\.js/);
});

test("saved chat snapshots redact spreadsheet tool payloads", async () => {
  const controller = await readFile(new URL("side-panel/index.js", extensionRoot), "utf8");
  assert.match(controller, /data-local-excel-activity/);
  assert.match(controller, /Spreadsheet content is not stored/);
  assert.match(controller, /localExcelHistoryResult\(result, mcpTool\)/);
  assert.match(controller, /markRestoredWorkbookAttachmentsExpired\(\)/);
});
