import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeWorkModeAction,
  createWorkModeTurn,
  recordCreatedProjectFromResult,
} from "../side-panel/work-mode-context.js";

const ERP_CONTEXT = {
  connected: true,
  tabId: 42,
  title: "Tổng quan",
  url: "https://sit.hawee.hicas.vn/tong-quan?tab=du-an",
};

test("builds a prompt-first work target from the active ERP tab", () => {
  const turn = createWorkModeTurn({
    userRequest: "Tạo một dự án kiểm thử mới",
    activeContext: ERP_CONTEXT,
    now: 123456,
  });

  assert.equal(turn.enabled, true);
  assert.equal(turn.target.tabId, 42);
  assert.equal(turn.target.host, "sit.hawee.hicas.vn");
  assert.equal(turn.target.protectedErpHost, "sit.hawee.hicas.vn");
  assert.match(turn.modelText, /\[EXTENSION-AUTHORED WORK TARGET\]/);
  assert.match(turn.modelText, /Mode: work_on_current_tab/);
  assert.match(turn.modelText, /\[USER REQUEST\]\nTạo một dự án kiểm thử mới/);
  assert.match(turn.modelText, /Do not ask which website to use/);
  assert.equal(turn.creationMarker, "LUMI-WORK-2N9C-42");
  assert.match(turn.modelText, /never modify or delete a pre-existing project/i);
  assert.match(turn.modelText, /LUMI-WORK-2N9C-42/);
});

test("leaves ordinary chat unchanged when no controllable web tab is active", () => {
  const turn = createWorkModeTurn({
    userRequest: "Xin chào",
    activeContext: { connected: false, reason: "Restricted tab" },
  });

  assert.equal(turn.enabled, false);
  assert.equal(turn.modelText, "Xin chào");
});

test("locks browser work to the active ERP host", () => {
  const turn = createWorkModeTurn({
    userRequest: "Kiểm tra danh sách dự án",
    activeContext: ERP_CONTEXT,
  });

  assert.throws(
    () => authorizeWorkModeAction({
      turn,
      tool: "browser_open_tab",
      args: { url: "https://example.com/" },
      currentContext: ERP_CONTEXT,
    }),
    /blocked navigation outside sit\.hawee\.hicas\.vn/,
  );
  assert.throws(
    () => authorizeWorkModeAction({
      turn,
      tool: "browser_click",
      args: { index: 7 },
      currentContext: {
        connected: true,
        url: "https://example.com/",
      },
    }),
    /active tab changed/,
  );
});

test("injects project protection and permits only create or conversation-owned project routes", () => {
  const turn = createWorkModeTurn({
    userRequest: "Tạo dự án mới",
    activeContext: ERP_CONTEXT,
  });
  const owned = new Set();
  const existing = authorizeWorkModeAction({
    turn,
    tool: "browser_input_text",
    args: { index: 2, text: "changed" },
    currentContext: {
      connected: true,
      url: "https://sit.hawee.hicas.vn/du-an/existing-project",
    },
    ownedProjectUrls: owned,
  });
  assert.equal(existing.projectPolicy.allowProjectMutation, false);

  const creating = authorizeWorkModeAction({
    turn,
    tool: "browser_input_text",
    args: { index: 2, text: "LUMI NEW" },
    currentContext: {
      connected: true,
      url: "https://sit.hawee.hicas.vn/du-an/them",
    },
    ownedProjectUrls: owned,
  });
  assert.equal(creating.projectPolicy.allowProjectMutation, true);

  const createdKey = recordCreatedProjectFromResult({
    turn,
    tool: "browser_click",
    beforeContext: {
      url: "https://sit.hawee.hicas.vn/du-an/them",
    },
    result: {
      controllerVerification: {
        conclusive: true,
        url: "https://sit.hawee.hicas.vn/du-an/new-project-id",
      },
    },
    ownedProjectUrls: owned,
  });
  assert.equal(createdKey, "https://sit.hawee.hicas.vn/du-an/new-project-id");

  const ownedAction = authorizeWorkModeAction({
    turn,
    tool: "browser_select_option",
    args: { index: 4, optionText: "Active" },
    currentContext: {
      connected: true,
      url: "https://sit.hawee.hicas.vn/du-an/new-project-id",
    },
    ownedProjectUrls: owned,
  });
  assert.equal(ownedAction.projectPolicy.allowProjectMutation, true);
});
