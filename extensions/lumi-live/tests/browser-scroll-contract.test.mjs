import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BROWSER_TOOLS } from "../live/session-config.js";

test("browser_scroll exposes content and exact normalized targets", async () => {
  const scrollTool = BROWSER_TOOLS.find(({ name }) => name === "browser_scroll");
  assert.ok(scrollTool);
  assert.equal(scrollTool.parameters.properties.position.minimum, 0);
  assert.equal(scrollTool.parameters.properties.position.maximum, 1);
  assert.equal(scrollTool.parameters.properties.text.type, "STRING");
  assert.deepEqual(scrollTool.parameters.properties.alignment.enum, ["start", "center", "end"]);
  assert.equal(scrollTool.parameters.properties.occurrence.minimum, 1);
  assert.ok(!scrollTool.parameters.required?.includes("direction"));

  const extensionController = await readFile(new URL("../browser/controller.js", import.meta.url), "utf8");
  const visualEffects = await readFile(new URL("../browser/effects/scroll.js", import.meta.url), "utf8");
  const studioController = await readFile(new URL("../../../app/lib/live/studio-page-agent.ts", import.meta.url), "utf8");
  assert.match(extensionController, /position,\s*indexedElement:/);
  assert.match(visualEffects, /maxTop \* position/);
  assert.match(extensionController, /scrollToTextGradually/);
  assert.match(visualEffects, /export async function scrollToTextGradually/);
  assert.match(visualEffects, /element\.scrollIntoView\(\{ behavior: "auto", block: alignment/);
  assert.match(studioController, /durationMs: 1000/);
});
