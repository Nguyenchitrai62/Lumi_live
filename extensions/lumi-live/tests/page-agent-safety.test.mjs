import assert from "node:assert/strict";
import test from "node:test";

import {
  assertConfirmedPageAgentClick,
  assertSafePageAgentInput,
} from "../browser/page-agent-safety.js";

function element(attributes = {}, properties = {}) {
  return {
    ...properties,
    getAttribute(name) {
      return attributes[name] ?? null;
    },
  };
}

test("secret input protection is shared across English and Vietnamese labels", () => {
  assert.throws(
    () => assertSafePageAgentInput(element({ placeholder: "Nhập mã xác thực" })),
    /blocks typing passwords/,
  );
  assert.throws(
    () => assertSafePageAgentInput(element({ "aria-label": "Khóa API" })),
    /blocks typing passwords/,
  );
  assert.doesNotThrow(
    () => assertSafePageAgentInput(element({ placeholder: "Tên hiển thị" })),
  );
});

test("consequential clicks require an explicit confirmation in both languages", () => {
  const vietnameseButton = element({}, { innerText: "Chuyển tiền" });
  const englishButton = element({}, { textContent: "Delete account" });

  assert.throws(
    () => assertConfirmedPageAgentClick(vietnameseButton, false),
    /explicit confirmation/,
  );
  assert.throws(
    () => assertConfirmedPageAgentClick(englishButton),
    /explicit confirmation/,
  );
  assert.doesNotThrow(
    () => assertConfirmedPageAgentClick(vietnameseButton, true),
  );
});
