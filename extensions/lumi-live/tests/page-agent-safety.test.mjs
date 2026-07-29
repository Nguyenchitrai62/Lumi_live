import assert from "node:assert/strict";
import test from "node:test";

import {
  assertConfirmedPageAgentClick,
  assertSafeErpProjectInput,
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
  assert.throws(
    () => assertConfirmedPageAgentClick(englishButton),
    /current user-authored request explicitly authorizes this exact action, target, and scope/,
  );
});

test("Work Mode blocks mutations to existing ERP projects", () => {
  const existingProjectPolicy = {
    protectExistingProjects: true,
    allowProjectMutation: false,
    currentPath: "/du-an/existing-project",
    allowedHost: "sit.hawee.hicas.vn",
    lockToAllowedHost: true,
  };
  const editButton = element(
    { "data-testid": "button-edit-projects-grid-view" },
    {
      innerText: "Edit",
      closest(selector) {
        return selector.includes("data-testid") ? {} : null;
      },
    },
  );

  assert.throws(
    () => assertConfirmedPageAgentClick(editButton, true, existingProjectPolicy),
    /blocks modifying or deleting a pre-existing ERP project/,
  );
  assert.throws(
    () => assertSafeErpProjectInput(
      element({ id: "input-project-name" }),
      existingProjectPolicy,
    ),
    /blocks editing a pre-existing ERP project/,
  );
  assert.doesNotThrow(
    () => assertSafeErpProjectInput(
      element({ id: "input-project-name" }),
      { ...existingProjectPolicy, allowProjectMutation: true },
    ),
  );
});

test("Work Mode blocks links that leave the selected ERP host", () => {
  const externalLink = {
    href: "https://example.com/",
  };
  const linkElement = element({}, {
    innerText: "External",
    closest(selector) {
      return selector.includes("a[href]") ? externalLink : null;
    },
  });

  assert.throws(
    () => assertConfirmedPageAgentClick(linkElement, false, {
      lockToAllowedHost: true,
      allowedHost: "sit.hawee.hicas.vn",
    }),
    /blocks this link because it leaves sit\.hawee\.hicas\.vn/,
  );
});
