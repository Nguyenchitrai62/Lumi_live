import assert from "node:assert/strict";
import test from "node:test";

import {
  findCommonCharacterPrefix,
} from "../side-panel/transcript-presentation.js";
import {
  BROWSER_ACTION_CLEANUP_DELAY_MS,
  BROWSER_CLICK_RIPPLE_DURATION_MS,
  DEFAULT_THINKING_LEVEL,
  FORM_INPUT_REVEAL_DURATION_MS,
  GOOGLE_POINTER_AIM_DURATION_MS,
  GOOGLE_QUERY_REVEAL_DURATION_MS,
  PAGE_SCROLL_DURATION_MS,
} from "../core/ui-config.js";
import * as uiConfig from "../core/ui-config.js";

test("central UI config contains only tunable variables for visible behavior", () => {
  assert.equal(DEFAULT_THINKING_LEVEL, "low");
  assert.equal(BROWSER_CLICK_RIPPLE_DURATION_MS, 300);
  assert.equal(BROWSER_ACTION_CLEANUP_DELAY_MS, 420);
  assert.equal(FORM_INPUT_REVEAL_DURATION_MS, 500);
  assert.equal(PAGE_SCROLL_DURATION_MS, 1000);
  assert.equal(GOOGLE_QUERY_REVEAL_DURATION_MS, 500);
  assert.equal(GOOGLE_POINTER_AIM_DURATION_MS, 360);
  assert.ok(Object.values(uiConfig).every((value) => (
    typeof value === "number" || typeof value === "string" || typeof value === "boolean"
  )));
});

test("finds a Unicode-safe prefix when streamed transcript targets grow", () => {
  assert.equal(findCommonCharacterPrefix("Xin chào 👋", "Xin chào 👋 bạn"), 10);
  assert.equal(findCommonCharacterPrefix("abc", "axy"), 1);
});
