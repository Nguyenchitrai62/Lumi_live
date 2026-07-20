import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_TOOLS,
  buildSessionInstruction,
  configureMcpTools,
} from "../live/session-config.js";

test("grounds self-references and searches in the Lumi Live product identity", () => {
  const instruction = buildSessionInstruction();
  assert.match(instruction, /Your assistant name is Lumi/i);
  assert.match(instruction, /product entity "Lumi Live Chrome extension"/i);
  assert.match(instruction, /literal English brand phrase "Lumi Live Chrome extension"/i);
  assert.match(instruction, /never translate, shorten, or paraphrase/i);
  assert.match(instruction, /YouTube video.+without a spoken preamble/i);
  assert.match(instruction, /live_translate/i);
  assert.match(instruction, /tool owns translated audio playback/i);
  assert.ok(BUILTIN_TOOLS.some((tool) => tool.name === "live_translate"));
  assert.doesNotMatch(instruction, /Talk to a AI Agent That Controls Your Active Tab/i);
});

test("does not expose temporarily disabled MCP servers to the agent session", () => {
  const activeTools = new Map();
  const declarations = configureMcpTools({
    servers: [
      {
        id: "disabled",
        serverName: "Disabled Redmine",
        enabled: false,
        tools: [{
          name: "redmine_get_spent_time",
          description: "Read spent time.",
          permission: "allow",
          gemini: { enabled: true, parameters: { type: "OBJECT", properties: {} } },
        }],
      },
      {
        id: "enabled",
        serverName: "Enabled Notion",
        enabled: true,
        tools: [{
          name: "search",
          description: "Search workspace.",
          permission: "allow",
          gemini: { enabled: true, parameters: { type: "OBJECT", properties: {} } },
        }],
      },
    ],
  }, activeTools);

  assert.equal(declarations.length, 1);
  assert.match(declarations[0].name, /Enabled_Notion/);
  assert.doesNotMatch(buildSessionInstruction({
    servers: [{
      serverName: "Disabled Redmine",
      enabled: false,
      tools: [{ name: "redmine_get_spent_time" }],
    }],
  }), /Disabled Redmine/);
});
