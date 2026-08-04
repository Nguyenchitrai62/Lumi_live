import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LOCAL_EXCEL_PROVIDER } from "../documents/excel-registry.js";
import { BUILTIN_TOOLS } from "../live/session-config.js";
import { createAdminToolsGesture } from "../settings/admin-tools-gesture.js";
import { createBuiltInToolInventory } from "../settings/built-in-tool-inventory.js";

const extensionRoot = new URL("../", import.meta.url);

test("admin inventory unlocks only after five icon clicks inside one second", () => {
  let timestamp = 0;
  let unlockCount = 0;
  const gesture = createAdminToolsGesture({
    now: () => timestamp,
    onUnlock: () => { unlockCount += 1; },
  });

  for (timestamp of [0, 200, 400, 600]) assert.equal(gesture.registerClick(), false);
  timestamp = 800;
  assert.equal(gesture.registerClick(), true);
  assert.equal(unlockCount, 1);

  for (timestamp of [2_000, 2_300, 2_600, 2_900, 3_200]) {
    assert.equal(gesture.registerClick(), false);
  }
  assert.equal(unlockCount, 1);
});

test("built-in inventory includes extension and Excel tools with fixed policies", () => {
  const inventory = createBuiltInToolInventory();
  const names = inventory.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const tool of BUILTIN_TOOLS) assert.ok(names.includes(tool.name));
  for (const tool of LOCAL_EXCEL_PROVIDER.tools) assert.ok(names.includes(tool.name));
  assert.ok(inventory.every((tool) => tool.alwaysEnabled === true));
  assert.ok(inventory.every((tool) => tool.permission === "allow"));
});

test("settings keeps the built-in inventory hidden, read-only, and ephemeral", async () => {
  const [html, controller, settings, gesture, styles] = await Promise.all([
    readFile(new URL("settings/index.html", extensionRoot), "utf8"),
    readFile(new URL("settings/mcp-settings-controller.js", extensionRoot), "utf8"),
    readFile(new URL("settings/index.js", extensionRoot), "utf8"),
    readFile(new URL("settings/admin-tools-gesture.js", extensionRoot), "utf8"),
    readFile(new URL("settings/styles.css", extensionRoot), "utf8"),
  ]);
  assert.match(html, /<img id="lumiSettingsIcon"[^>]*draggable="false"/);
  assert.doesNotMatch(html, /admin tools|built-in tools/i);
  assert.match(settings, /requiredClicks: 5/);
  assert.match(settings, /windowMs: 1_000/);
  assert.match(settings, /adminToolsGesture\.registerClick\(\)/);
  assert.doesNotMatch(gesture, /chrome\.storage|localStorage|sessionStorage/);
  assert.match(controller, /readOnlyInventory/);
  assert.match(controller, /mcp-fixed-permission/);
  assert.match(controller, /openBuiltInToolsView/);
  assert.match(controller, /mcpToolPermissionList\.replaceChildren\(\)/);
  assert.match(styles, /#lumiSettingsIcon\s*\{[^}]*user-select:\s*none;/);
  assert.doesNotMatch(styles, /#lumiSettingsIcon[^}]*animation/);
});

test("MCP permission requests use a modal high-contrast layer", async () => {
  const [html, controller, styles] = await Promise.all([
    readFile(new URL("side-panel/index.html", extensionRoot), "utf8"),
    readFile(new URL("side-panel/mcp-panel-controller.js", extensionRoot), "utf8"),
    readFile(new URL("side-panel/styles.css", extensionRoot), "utf8"),
  ]);
  assert.match(html, /id="mcpPermissionBackdrop"/);
  assert.match(controller, /kind: "permission"/);
  assert.match(controller, /role", isPermissionPrompt \? "alertdialog" : "alert"/);
  assert.match(styles, /\.mcp-permission-backdrop\s*\{[^}]*rgba\(12,8,18,\.76\)/);
  assert.match(styles, /\.mcp-tool-notice\[data-kind="permission"\]\s*\{[^}]*border:\s*2px solid #ffd166;[^}]*background:\s*#1b1324;/);
});
