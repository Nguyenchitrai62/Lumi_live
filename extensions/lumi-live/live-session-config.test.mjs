import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionInstruction,
} from "./live-session-config.js";

test("grounds self-references and searches in the Lumi Live product identity", () => {
  const instruction = buildSessionInstruction();
  assert.match(instruction, /Your assistant name is Lumi/i);
  assert.match(instruction, /product entity "Lumi Live Chrome extension"/i);
  assert.match(instruction, /literal English brand phrase "Lumi Live Chrome extension"/i);
  assert.match(instruction, /never translate, shorten, or paraphrase/i);
  assert.match(instruction, /YouTube video.+without a spoken preamble/i);
  assert.doesNotMatch(instruction, /Talk to a AI Agent That Controls Your Active Tab/i);
});
