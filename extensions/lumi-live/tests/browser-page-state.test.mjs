import assert from "node:assert/strict";
import test from "node:test";

import { selectPageStateContent } from "../browser/page-state-content.js";
import {
  BROWSER_TOOLS,
  buildSessionInstruction,
} from "../live/session-config.js";

test("browser page state supports targeted queries and dynamic waiting", () => {
  const tool = BROWSER_TOOLS.find(({ name }) => name === "browser_get_page_state");
  const waitTool = BROWSER_TOOLS.find(({ name }) => name === "browser_wait_for_page_state");
  assert.ok(tool);
  assert.ok(waitTool);
  assert.equal(tool.parameters.properties.query.type, "STRING");
  assert.deepEqual(waitTool.parameters.properties.condition.enum, ["present", "absent"]);
  assert.deepEqual(waitTool.parameters.required, ["query"]);
  assert.match(tool.description, /without losing its element indices to truncation/i);
  const instruction = buildSessionInstruction();
  assert.match(instruction, /complete ordered goal as an internal checklist/i);
  assert.match(instruction, /same named item container/i);
  assert.match(instruction, /nextPageStateQuery/i);
  assert.match(instruction, /observe-act-verify loop/i);
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
