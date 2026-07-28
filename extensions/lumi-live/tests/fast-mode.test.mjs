import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BROWSER_TOOLS,
  BROWSER_UI_ACTION_TOOLS,
  buildSessionInstruction,
} from "../live/session-config.js";

const extensionRoot = new URL("../", import.meta.url);

test("publishes a bounded bulk form tool and Fast mode guidance", () => {
  const batchTool = BROWSER_TOOLS.find((tool) => tool.name === "browser_batch_actions");
  assert.ok(batchTool);
  assert.equal(batchTool.parameters.properties.actions.minItems, 1);
  assert.equal(batchTool.parameters.properties.actions.maxItems, 100);
  assert.deepEqual(
    batchTool.parameters.properties.actions.items.properties.type.enum,
    ["click", "input", "select"],
  );
  assert.ok(BROWSER_UI_ACTION_TOOLS.has("browser_batch_actions"));
  assert.match(
    buildSessionInstruction({}, null, BROWSER_TOOLS, { fastMode: true }),
    /Fast mode is enabled at session start/,
  );
});

test("wires Fast mode through settings, the side panel, the workspace, and the page controller", async () => {
  const [settingsHtml, panelHtml, panelController, fastController, worker, workspace, manifest, pageController, scrollEffect, panelStyles] =
    await Promise.all([
      readFile(new URL("settings/index.html", extensionRoot), "utf8"),
      readFile(new URL("side-panel/index.html", extensionRoot), "utf8"),
      readFile(new URL("side-panel/index.js", extensionRoot), "utf8"),
      readFile(new URL("side-panel/fast-mode-controller.js", extensionRoot), "utf8"),
      readFile(new URL("background/index.js", extensionRoot), "utf8"),
      readFile(new URL("background/fast-workspace.js", extensionRoot), "utf8"),
      readFile(new URL("manifest.json", extensionRoot), "utf8"),
      readFile(new URL("browser/controller.js", extensionRoot), "utf8"),
      readFile(new URL("browser/effects/scroll.js", extensionRoot), "utf8"),
      readFile(new URL("side-panel/styles.css", extensionRoot), "utf8"),
    ]);

  assert.match(settingsHtml, /id="fastModeInput"/);
  assert.match(panelHtml, /id="fastModeButton"/);
  assert.match(panelController, /createFastModeController/);
  assert.match(fastController, /panelAudio\.setVisualAnimationsEnabled\(!enabled\)/);
  assert.match(fastController, /is-engaging/);
  assert.match(worker, /FAST_MODE_STORAGE_KEY/);
  assert.match(worker, /if \(fastModeEnabled\) return;/);
  assert.match(workspace, /tabsApi\.group/);
  assert.match(workspace, /autoDiscardable: false/);
  assert.ok(JSON.parse(manifest).permissions.includes("tabGroups"));
  assert.match(pageController, /tool === "browser_batch_actions"/);
  assert.match(pageController, /instantClickElement/);
  assert.match(pageController, /viewportExpansion:\s*runtime\.visualPreferences\.fastMode \? -1 : 0/);
  assert.match(pageController, /fullPageIndexed/);
  assert.match(pageController, /viewportPolicy:\s*fullPageIndexed \? "full_page_dom"/);
  assert.match(pageController, /without viewport scrolling/);
  const instantClickSource = pageController.match(
    /function instantClickElement[\s\S]*?(?=function instantSelectOption)/,
  )?.[0];
  assert.ok(instantClickSource);
  assert.doesNotMatch(instantClickSource, /scrollIntoView/);
  assert.match(scrollEffect, /targetLeft/);
  assert.match(scrollEffect, /direction === "left" \|\| direction === "right"/);
  assert.match(panelStyles, /body\.fast-mode #vtuberCard/);
  assert.match(panelStyles, /body\.fast-mode \*, body\.fast-mode \*::before/);
  assert.match(panelStyles, /fast-mode-engage/);
});
