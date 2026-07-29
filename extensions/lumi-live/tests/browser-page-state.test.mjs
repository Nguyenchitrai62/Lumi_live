import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { selectPageStateContent } from "../browser/page-state-content.js";
import {
  normalizeSemanticActionIntent,
  normalizeSemanticAnchor,
  scoreSemanticControlIntent,
  scoreSemanticAnchorMatch,
  scoreSemanticAnchorVariants,
} from "../browser/semantic-anchor-context.js";
import {
  BROWSER_TOOLS,
  buildSessionInstruction,
} from "../live/session-config.js";

test("browser page state supports targeted queries and dynamic waiting", () => {
  const tool = BROWSER_TOOLS.find(({ name }) => name === "browser_get_page_state");
  const semanticTool = BROWSER_TOOLS.find(
    ({ name }) => name === "browser_find_semantic_context",
  );
  const waitTool = BROWSER_TOOLS.find(({ name }) => name === "browser_wait_for_page_state");
  const scrollTool = BROWSER_TOOLS.find(({ name }) => name === "browser_scroll");
  assert.ok(tool);
  assert.ok(semanticTool);
  assert.ok(waitTool);
  assert.ok(scrollTool);
  assert.equal(tool.parameters.properties.query.type, "STRING");
  assert.equal(semanticTool.parameters.properties.targets.type, "ARRAY");
  assert.equal(semanticTool.parameters.properties.targets.maxItems, 4);
  assert.deepEqual(
    semanticTool.parameters.properties.intent.enum,
    ["auto", "select", "activate", "input", "choose", "inspect"],
  );
  assert.deepEqual(semanticTool.parameters.required, ["targets"]);
  assert.deepEqual(waitTool.parameters.properties.condition.enum, ["present", "absent"]);
  assert.deepEqual(waitTool.parameters.required, ["query"]);
  assert.deepEqual(scrollTool.parameters.properties.direction.enum, ["up", "down", "left", "right"]);
  assert.match(tool.description, /without losing its element indices to truncation/i);
  assert.match(semanticTool.description, /typo-tolerant matching/i);
  assert.match(semanticTool.description, /table headers/i);
  assert.match(semanticTool.description, /off-viewport data-lumi-index values are immediately actionable/i);
  const instruction = buildSessionInstruction();
  assert.match(instruction, /complete ordered goal as an internal checklist/i);
  assert.match(instruction, /same named item container/i);
  assert.match(instruction, /nextPageStateQuery/i);
  assert.match(instruction, /observe-act-verify loop/i);
  assert.match(instruction, /semantic anchors/i);
  assert.match(instruction, /browser_find_semantic_context/i);
  assert.match(instruction, /intent=select/i);
  assert.match(instruction, /open Shadow DOM/i);
  assert.match(instruction, /same-origin frames/i);
  assert.match(instruction, /do not scroll again/i);
  assert.match(instruction, /complete rendered DOM/i);
  assert.match(instruction, /supports up, down, left, and right/i);
  assert.doesNotMatch(instruction, /Hawee/i);
});

test("centers a long page-state response on an exact filename", () => {
  const before = Array.from({ length: 120 }, (_, index) => `before row ${index}`).join("\n");
  const target = [
    'row "quarterly-report.pdf PDF 1.61 MB Pending"',
    "  checkbox [index=413]",
    "  text quarterly-report.pdf",
  ].join("\n");
  const after = Array.from({ length: 120 }, (_, index) => `after row ${index}`).join("\n");
  const result = selectPageStateContent(
    `${before}\n${target}\n${after}`,
    "quarterly-report.pdf",
    1000,
  );
  assert.equal(result.queryMatched, true);
  assert.match(result.content, /quarterly-report\.pdf/);
  assert.match(result.content, /checkbox \[index=413\]/);
  assert.ok(result.content.length < before.length + target.length + after.length);
});

test("reports when targeted text is absent from the current semantic DOM", () => {
  const result = selectPageStateContent("button Upload\nrow another.pdf", "quarterly-report.pdf");
  assert.equal(result.queryMatched, false);
  assert.match(result.content, /was not found in the current semantic DOM/i);
});

test("normalizes accents and tolerates small semantic-anchor typos", () => {
  assert.equal(
    normalizeSemanticAnchor("  Chạy Hawee DocAI  "),
    "chay hawee docai",
  );
  const typoMatch = scoreSemanticAnchorMatch(
    "chạy hawe docai",
    "Chạy Hawee DocAI",
  );
  assert.equal(typoMatch.method, "fuzzy");
  assert.ok(typoMatch.score >= 0.56);
});

test("semantic anchors strongly match filenames inside a table row", () => {
  const result = scoreSemanticAnchorVariants(
    String.raw`F:\Source_code\r_d-ai\doc\5_HỒ SƠ KỸ THUẬT\CƠ ĐIỆN\FIRE\FIRE\333.pdf`,
    "333.pdf PDF 1.61 MB uploaded",
  );
  assert.equal(result.method, "contained");
  assert.equal(result.variant, "333.pdf");
  assert.ok(result.score >= 0.94);
});

test("semantic action intent ranks the requested control type without toggling selected items", () => {
  assert.equal(normalizeSemanticActionIntent(" SELECT "), "select");
  assert.equal(normalizeSemanticActionIntent("unsupported"), "auto");
  assert.equal(scoreSemanticControlIntent("select", "select"), 1);
  assert.equal(scoreSemanticControlIntent("select", "activate"), 0.2);
  assert.equal(
    scoreSemanticControlIntent("select", "select", { selected: true }),
    0.08,
  );
  assert.equal(
    scoreSemanticControlIntent("activate", "activate", { disabled: true }),
    0,
  );
  assert.equal(scoreSemanticControlIntent("input", "input"), 1);
  assert.equal(scoreSemanticControlIntent("choose", "choose"), 1);
});

test("semantic resolver traversal is not limited to the first fixed number of DOM elements", async () => {
  const source = await readFile(
    new URL("../browser/semantic-anchor-context.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /createTreeWalker/);
  assert.match(source, /element\.shadowRoot/);
  assert.match(source, /element\.contentDocument\?\.body/);
  assert.match(source, /ROW_CONTAINER_SELECTOR/);
  assert.match(source, /REPEATED_CONTAINER_SELECTOR/);
  assert.match(source, /GROUP_CONTAINER_SELECTOR/);
  assert.doesNotMatch(source, /MAX_CANDIDATE_ELEMENTS/);
  assert.match(source, /accessible label\/description relationships|aria-labelledby/);
  assert.match(source, /Shared full-page DOM index is active/);
});
