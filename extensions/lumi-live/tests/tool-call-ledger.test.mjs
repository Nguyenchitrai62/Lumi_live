import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPendingCancellationResponses,
  registerPendingFunctionCalls,
  settlePendingFunctionCalls,
} from "../live/tool-call-ledger.js";

test("cancel accounts for every call in a batch while the first tool is still running", () => {
  const pendingIds = new Set();
  const pendingNames = new Map();
  registerPendingFunctionCalls([
    { id: "observe", name: "browser_get_page_state" },
    { id: "click", name: "browser_click" },
  ], pendingIds, pendingNames);

  assert.deepEqual([...pendingIds], ["observe", "click"]);
  assert.deepEqual(buildPendingCancellationResponses(pendingIds, pendingNames), [
    {
      id: "observe",
      name: "browser_get_page_state",
      response: { error: "Cancelled by the user before this tool could finish." },
    },
    {
      id: "click",
      name: "browser_click",
      response: { error: "Cancelled by the user before this tool could finish." },
    },
  ]);
});

test("tool calls remain pending until their response batch is sent", () => {
  const pendingIds = new Set();
  const pendingNames = new Map();
  registerPendingFunctionCalls([
    { id: "search", name: "browser_input_text" },
    { id: "open-video", name: "browser_click" },
  ], pendingIds, pendingNames);

  const responses = [{
    id: "search",
    name: "browser_input_text",
    response: { result: { success: true } },
  }];
  assert.equal(pendingIds.has("search"), true);

  settlePendingFunctionCalls(responses, pendingIds, pendingNames);

  assert.deepEqual([...pendingIds], ["open-video"]);
  assert.equal(pendingNames.has("search"), false);
  assert.equal(pendingNames.get("open-video"), "browser_click");
});
