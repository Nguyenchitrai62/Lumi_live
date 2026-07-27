import assert from "node:assert/strict";
import test from "node:test";

import {
  findCommonCharacterPrefix,
  getLiveModelPartTranscriptRole,
  isScrollAtBottom,
} from "../side-panel/transcript-presentation.js";
import { applyUiConfig } from "../side-panel/apply-ui-config.js";
import {
  BROWSER_ACTION_CLEANUP_DELAY_MS,
  BROWSER_CLICK_RIPPLE_DURATION_MS,
  DEFAULT_AGENT_MAX_STEPS,
  DEFAULT_COMPLETION_RECOVERY_LIMIT,
  DEFAULT_IDENTICAL_STATE_ACTION_LIMIT,
  DEFAULT_THINKING_LEVEL,
  FORM_INPUT_REVEAL_DURATION_MS,
  GOOGLE_POINTER_AIM_DURATION_MS,
  GOOGLE_QUERY_REVEAL_DURATION_MS,
  PAGE_SCROLL_DURATION_MS,
  TASK_AUTO_FOLLOW_BOTTOM_TOLERANCE_PX,
  TASK_STEP_DETAIL_MAX_HEIGHT_PX,
  TASK_STEP_DETAIL_MAX_VIEWPORT_HEIGHT_PERCENT,
} from "../core/ui-config.js";
import * as uiConfig from "../core/ui-config.js";

test("central UI config contains runtime and visible-behavior tuning values", () => {
  assert.equal(DEFAULT_THINKING_LEVEL, "low");
  assert.equal(DEFAULT_AGENT_MAX_STEPS, 24);
  assert.equal(DEFAULT_IDENTICAL_STATE_ACTION_LIMIT, 2);
  assert.equal(DEFAULT_COMPLETION_RECOVERY_LIMIT, 2);
  assert.equal(TASK_AUTO_FOLLOW_BOTTOM_TOLERANCE_PX, 1);
  assert.equal(TASK_STEP_DETAIL_MAX_HEIGHT_PX, 430);
  assert.equal(TASK_STEP_DETAIL_MAX_VIEWPORT_HEIGHT_PERCENT, 58);
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

test("task detail dimensions flow from UI config into a CSS variable", () => {
  const values = new Map();
  applyUiConfig({
    style: {
      setProperty: (property, value) => values.set(property, value),
    },
  });
  assert.equal(
    values.get("--ui-task-step-detail-max-height"),
    "min(58vh, 430px)",
  );
});

test("finds a Unicode-safe prefix when streamed transcript targets grow", () => {
  assert.equal(findCommonCharacterPrefix("Xin chào 👋", "Xin chào 👋 bạn"), 10);
  assert.equal(findCommonCharacterPrefix("abc", "axy"), 1);
});

test("routes only real Live model text to a visible transcript role", () => {
  assert.equal(
    getLiveModelPartTranscriptRole({ thought: true, text: "Checking the current tab." }),
    "thinking",
  );
  assert.equal(
    getLiveModelPartTranscriptRole({ text: "Here is what I found." }),
    "lumi",
  );
  assert.equal(
    getLiveModelPartTranscriptRole({ inlineData: { data: "audio" } }),
    null,
  );
  assert.equal(
    getLiveModelPartTranscriptRole({ thought: true, text: "   " }),
    null,
  );
});

test("transcript follow activates only at the actual bottom", () => {
  assert.equal(
    isScrollAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 }),
    true,
  );
  assert.equal(
    isScrollAtBottom({ scrollHeight: 1000, scrollTop: 498, clientHeight: 500 }),
    false,
  );
  assert.equal(
    isScrollAtBottom({ scrollHeight: 1000, scrollTop: 499.5, clientHeight: 500 }),
    true,
  );
});
