import assert from "node:assert/strict";
import test from "node:test";

import {
  isSafeMarkdownUrl,
  parseMarkdownBlocks,
} from "../side-panel/markdown-renderer.js";

test("parses conversation Markdown tables, links, lists, and fenced code into blocks", () => {
  const blocks = parseMarkdownBlocks([
    "## Result",
    "",
    "| Name | Link |",
    "| --- | --- |",
    "| Lumi | [Open](https://example.com) |",
    "",
    "- First",
    "- Second",
    "",
    "```js",
    "const ready = true;",
    "```",
  ].join("\n"));

  assert.deepEqual(blocks, [
    { type: "heading", level: 2, text: "Result" },
    {
      type: "table",
      headers: ["Name", "Link"],
      rows: [["Lumi", "[Open](https://example.com)"]],
    },
    { type: "list", ordered: false, items: ["First", "Second"] },
    { type: "code", language: "js", text: "const ready = true;" },
  ]);
});

test("allows safe Markdown links and images while rejecting script URLs", () => {
  assert.equal(isSafeMarkdownUrl("https://example.com/path"), true);
  assert.equal(isSafeMarkdownUrl("mailto:hello@example.com"), true);
  assert.equal(isSafeMarkdownUrl("javascript:alert(1)"), false);
  assert.equal(isSafeMarkdownUrl("data:text/html;base64,PHNjcmlwdD4=", { image: true }), false);
  assert.equal(isSafeMarkdownUrl("data:image/png;base64,iVBORw0KGgo=", { image: true }), true);
});

