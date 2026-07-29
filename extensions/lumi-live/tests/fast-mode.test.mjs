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
  assert.equal(
    BROWSER_TOOLS.some((tool) => tool.name === "browser_apply_stage"),
    false,
  );
  const batchTool = BROWSER_TOOLS.find((tool) => tool.name === "browser_batch_actions");
  assert.ok(batchTool);
  assert.equal(batchTool.parameters.properties.actions.minItems, 1);
  assert.equal(batchTool.parameters.properties.actions.maxItems, 200);
  assert.deepEqual(
    batchTool.parameters.properties.actions.items.properties.type.enum,
    ["click", "input", "select"],
  );
  assert.ok(BROWSER_UI_ACTION_TOOLS.has("browser_batch_actions"));
  const selectionTool = BROWSER_TOOLS.find((tool) => tool.name === "browser_set_selection");
  assert.ok(selectionTool);
  assert.equal(selectionTool.parameters.properties.indices.maxItems, 300);
  assert.deepEqual(selectionTool.parameters.properties.desiredState.enum, ["on", "off"]);
  assert.ok(BROWSER_UI_ACTION_TOOLS.has("browser_set_selection"));
  assert.match(
    buildSessionInstruction({}, null, BROWSER_TOOLS, { fastMode: true }),
    /Fast mode is enabled at session start/,
  );
  assert.match(
    buildSessionInstruction({}, null, BROWSER_TOOLS, { fastMode: false }),
    /same Gemini Live planning, remaining-goal ledger, durable memory, recovery, safety, and verification harness/i,
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
  assert.match(worker, /message\.command === "prepare_browser_prompt"/);
  assert.match(worker, /restriction: "workspace_tabs_only"/);
  assert.match(worker, /\? \{ groupId: workspaceGroup\.id \}/);
  assert.match(worker, /Fast mode can switch only to tabs already inside Agent Space/);
  assert.match(panelController, /await sendRuntime\("prepare_browser_prompt"\)/);
  assert.match(panelController, /onUserSpeechStart:[^]*sendRuntime\("prepare_browser_prompt"\)/);
  assert.match(panelController, /This turn is locked to workspace tabId/);
  assert.match(workspace, /tabsApi\.group/);
  assert.match(workspace, /autoDiscardable: false/);
  assert.ok(JSON.parse(manifest).permissions.includes("tabGroups"));
  assert.match(pageController, /tool === "browser_batch_actions"/);
  assert.match(pageController, /tool === "browser_set_selection"/);
  assert.match(pageController, /MAX_FAST_BATCH_ACTIONS = 200/);
  assert.match(pageController, /MAX_FAST_SELECTION_INDICES = 300/);
  assert.match(pageController, /Each control may appear only once per batch/);
  assert.match(pageController, /await verifyFastBatchAction\(action, signal\)/);
  assert.match(pageController, /A later batch action changed this control after its initial verification/);
  assert.match(pageController, /instantClickElement/);
  assert.match(pageController, /enableMask:\s*!runtime\.visualPreferences\.fastMode/);
  assert.match(pageController, /viewportExpansion:\s*runtime\.visualPreferences\.fastMode \? -1 : 0/);
  assert.match(pageController, /fullPageIndexed/);
  assert.match(pageController, /viewportPolicy:\s*fullPageIndexed \? "full_page_dom"/);
  assert.match(pageController, /without viewport scrolling/);
  assert.doesNotMatch(pageController, /browser_apply_stage|createPageStateTracker|stateId/);
  const clickToolSource = pageController.match(
    /if \(tool === "browser_click"\)[\s\S]*?(?=if \(tool === "browser_input_text"\))/,
  )?.[0];
  assert.ok(clickToolSource);
  assert.match(
    clickToolSource,
    /runtime\.visualPreferences\.fastMode\s*\?\s*instantClickElement\(element\)\s*:\s*await activeController\.clickElement\(index\)/,
  );
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

test("releases Fast workspace with the panel and restores it from the active tab", async () => {
  const [worker, uiConfig, panelController, settingsController] = await Promise.all([
    readFile(new URL("background/index.js", extensionRoot), "utf8"),
    readFile(new URL("core/ui-config.js", extensionRoot), "utf8"),
    readFile(new URL("side-panel/index.js", extensionRoot), "utf8"),
    readFile(new URL("settings/index.js", extensionRoot), "utf8"),
  ]);
  const panelLifecycle = worker.slice(
    worker.indexOf("chrome.runtime.onConnect.addListener"),
    worker.indexOf("function isWebPage"),
  );
  assert.match(panelLifecycle, /if \(fastModeEnabled\) await activateFastWorkspace\(\)/);
  assert.match(panelLifecycle, /await fastWorkspace\.release\(\)/);
  assert.match(panelLifecycle, /await setConnectedTab\(null\)/);
  assert.match(worker, /activateWorkspace = sidePanelPorts\.size > 0/);
  assert.match(uiConfig, /export const DEFAULT_FAST_MODE_ENABLED = (?:true|false)/);
  assert.match(panelController, /DEFAULT_FAST_MODE_ENABLED/);
  assert.match(settingsController, /DEFAULT_FAST_MODE_ENABLED/);
});
