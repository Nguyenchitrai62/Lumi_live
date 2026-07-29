import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BROWSER_TOOLS,
  BROWSER_UI_ACTION_TOOLS,
  buildSessionInstruction,
} from "../live/session-config.js";

const extensionRoot = new URL("../", import.meta.url);

test("publishes one state-bound StagePlan contract for Normal and Fast execution", () => {
  const stageTool = BROWSER_TOOLS.find((tool) => tool.name === "browser_apply_stage");
  assert.ok(stageTool);
  assert.deepEqual(stageTool.parameters.required, ["stateId"]);
  assert.equal(stageTool.parameters.properties.actions.maxItems, 300);
  assert.equal(stageTool.parameters.properties.selectionScopes.maxItems, 20);
  assert.deepEqual(
    stageTool.parameters.properties.actions.items.properties.type.enum,
    ["click", "input", "select"],
  );
  assert.deepEqual(
    stageTool.parameters.properties.selectionScopes.items.properties.desiredState.enum,
    ["on", "off"],
  );
  assert.ok(BROWSER_UI_ACTION_TOOLS.has("browser_apply_stage"));

  const ledgerTool = BROWSER_TOOLS.find((tool) => tool.name === "browser_get_stage_ledger");
  assert.ok(ledgerTool);
  assert.equal(ledgerTool.parameters.properties.limit.maximum, 100);

  const batchTool = BROWSER_TOOLS.find((tool) => tool.name === "browser_batch_actions");
  const selectionTool = BROWSER_TOOLS.find((tool) => tool.name === "browser_set_selection");
  assert.equal(batchTool.parameters.properties.actions.maxItems, 200);
  assert.equal(selectionTool.parameters.properties.indices.maxItems, 300);
  assert.ok(BROWSER_UI_ACTION_TOOLS.has("browser_batch_actions"));
  assert.ok(BROWSER_UI_ACTION_TOOLS.has("browser_set_selection"));

  const fastInstruction = buildSessionInstruction({}, null, BROWSER_TOOLS, {
    fastMode: true,
  });
  const normalInstruction = buildSessionInstruction({}, null, BROWSER_TOOLS, {
    fastMode: false,
  });
  assert.match(fastInstruction, /Fast execution is enabled at session start/i);
  assert.match(fastInstruction, /same shared full-page context/i);
  assert.match(fastInstruction, /zero-delay chunks/i);
  assert.match(normalInstruction, /Normal execution is enabled at session start/i);
  assert.match(normalInstruction, /same shared full-page context/i);
  assert.match(normalInstruction, /representative page animations/i);
  assert.match(fastInstruction, /Normal and Fast are execution policies only/i);
  assert.match(normalInstruction, /Normal and Fast are execution policies only/i);
});

test("keeps context and verification identical while separating execution and target policies", async () => {
  const [
    settingsHtml,
    panelHtml,
    panelController,
    fastController,
    worker,
    workspace,
    manifest,
    pageController,
    pageIdentity,
    pageContext,
    semanticContext,
    actionVerification,
    scrollEffect,
    panelStyles,
  ] = await Promise.all([
    readFile(new URL("settings/index.html", extensionRoot), "utf8"),
    readFile(new URL("side-panel/index.html", extensionRoot), "utf8"),
    readFile(new URL("side-panel/index.js", extensionRoot), "utf8"),
    readFile(new URL("side-panel/fast-mode-controller.js", extensionRoot), "utf8"),
    readFile(new URL("background/index.js", extensionRoot), "utf8"),
    readFile(new URL("background/fast-workspace.js", extensionRoot), "utf8"),
    readFile(new URL("manifest.json", extensionRoot), "utf8"),
    readFile(new URL("browser/controller.js", extensionRoot), "utf8"),
    readFile(new URL("browser/page-state-identity.js", extensionRoot), "utf8"),
    readFile(new URL("browser/page-context.js", extensionRoot), "utf8"),
    readFile(new URL("browser/semantic-anchor-context.js", extensionRoot), "utf8"),
    readFile(new URL("side-panel/browser-action-verification.js", extensionRoot), "utf8"),
    readFile(new URL("browser/effects/scroll.js", extensionRoot), "utf8"),
    readFile(new URL("side-panel/styles.css", extensionRoot), "utf8"),
  ]);

  assert.match(settingsHtml, /id="fastModeInput"/);
  assert.match(settingsHtml, /id="backgroundWorkspaceInput"/);
  assert.match(panelHtml, /id="fastModeButton"/);
  assert.match(panelController, /createFastModeController/);
  assert.match(fastController, /panelAudio\.setVisualAnimationsEnabled\(!enabled\)/);
  assert.match(fastController, /shared context.+verified bulk stages/i);

  assert.match(worker, /WORKSPACE_ENABLED_STORAGE_KEY/);
  assert.match(worker, /async function applyFastModeEnabled\(enabled\)/);
  assert.match(worker, /async function applyWorkspaceEnabled\(enabled/);
  const executionPolicySource = worker.match(
    /async function applyFastModeEnabled[\s\S]*?(?=async function applyWorkspaceEnabled)/,
  )?.[0];
  assert.ok(executionPolicySource);
  assert.doesNotMatch(executionPolicySource, /addTab|release\(/);
  assert.match(worker, /message\.command === "set_workspace_enabled"/);
  assert.match(worker, /targetPolicy: "background_workspace"/);
  assert.match(worker, /restriction: "workspace_tabs_only"/);
  assert.match(worker, /PARTIAL_STAGE_TOOLS\.has\(tool\)/);
  assert.match(workspace, /FAST_WORKSPACE_TITLE = "Lumi Workspace"/);
  assert.match(workspace, /tabsApi\.group/);
  assert.match(workspace, /autoDiscardable: false/);
  assert.ok(JSON.parse(manifest).permissions.includes("tabGroups"));

  assert.match(panelController, /await sendRuntime\("prepare_browser_prompt"\)/);
  assert.match(panelController, /Target policy: Background workspace/);
  assert.match(panelController, /Use browser_apply_stage for independent form edits/);

  assert.match(pageController, /tool === "browser_apply_stage"/);
  assert.match(pageController, /tool === "browser_get_stage_ledger"/);
  assert.match(pageController, /MAX_STAGE_ACTIONS = 300/);
  assert.match(pageController, /FAST_STAGE_CHUNK_SIZE = 40/);
  assert.match(pageController, /NORMAL_STAGE_CHUNK_SIZE = 20/);
  assert.match(pageController, /viewportExpansion: -1/);
  assert.doesNotMatch(pageController, /viewportExpansion:\s*runtime\.visualPreferences\.fastMode/);
  assert.match(pageController, /contextMode: "shared_full_page"/);
  assert.match(pageController, /resolveSemanticSelectionScope/);
  assert.match(pageController, /shouldAnimateStageAction/);
  assert.match(pageController, /runtime\.stateTracker\.assertDocumentStable/);
  assert.match(pageController, /success: completed/);
  assert.match(pageController, /resume: completed \? null/);
  assert.match(pageController, /storeStageLedger/);
  assert.match(pageController, /instantClickElement/);
  const instantClickSource = pageController.match(
    /function instantClickElement[\s\S]*?(?=function instantSelectOption)/,
  )?.[0];
  assert.ok(instantClickSource);
  assert.doesNotMatch(instantClickSource, /scrollIntoView/);

  assert.match(pageIdentity, /stateId:/);
  assert.match(pageIdentity, /semantic DOM changed after the last observation/i);
  assert.match(pageIdentity, /replaced a remaining control/i);
  assert.match(pageContext, /diffObservationSnapshots/);
  assert.match(pageContext, /changedControls/);
  assert.match(semanticContext, /export function resolveSemanticSelectionScope/);
  assert.match(actionVerification, /resume\?\.requiresFreshObservation/);

  assert.match(scrollEffect, /targetLeft/);
  assert.match(scrollEffect, /direction === "left" \|\| direction === "right"/);
  assert.match(panelStyles, /body\.fast-mode #vtuberCard/);
  assert.match(panelStyles, /body\.fast-mode \*, body\.fast-mode \*::before/);
  assert.match(panelStyles, /fast-mode-engage/);
});
