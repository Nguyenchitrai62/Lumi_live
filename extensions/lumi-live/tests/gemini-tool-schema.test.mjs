import assert from "node:assert/strict";
import test from "node:test";

import { prepareGeminiMcpTool } from "../mcp/gemini-tool-schema.js";

test("encodes boolean and numeric enum values as Gemini strings", () => {
  const result = prepareGeminiMcpTool({
    name: "set_value",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean", enum: [true, false] },
        level: { type: "integer", enum: [1, 2] },
      },
    },
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(result.parameters.properties.enabled.enum, ["true", "false"]);
  assert.deepEqual(result.parameters.properties.level.enum, ["1", "2"]);
});

test("encodes primitive const values inside anyOf", () => {
  const result = prepareGeminiMcpTool({
    name: "set_polymorphic_value",
    inputSchema: {
      type: "object",
      properties: {
        value: { anyOf: [{ const: true }, { type: "string" }] },
      },
    },
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(result.parameters.properties.value.anyOf[0].enum, ["true"]);
});

test("encodes protobuf int64 schema limits as strings", () => {
  const result = prepareGeminiMcpTool({
    name: "batch",
    inputSchema: {
      type: "object",
      properties: {
        values: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
      },
    },
  });

  assert.equal(result.enabled, true);
  assert.equal(result.parameters.properties.values.minItems, "1");
  assert.equal(result.parameters.properties.values.maxItems, "5");
});

test("disables only a tool with an unsupported schema type", () => {
  const result = prepareGeminiMcpTool({
    name: "upload",
    inputSchema: {
      type: "object",
      properties: { attachment: { type: "file" } },
    },
  });

  assert.equal(result.enabled, false);
  assert.match(result.errors.join(" "), /unsupported value file/);
});

test("requires MCP function parameters to be an object", () => {
  const result = prepareGeminiMcpTool({
    name: "invalid_root",
    inputSchema: { type: "string" },
  });

  assert.equal(result.enabled, false);
  assert.match(result.errors.join(" "), /must have type object/);
});

test("drops unknown required names without invalidating the declaration", () => {
  const result = prepareGeminiMcpTool({
    name: "known_args",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query", "missing", 42],
    },
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(result.parameters.required, ["query"]);
  assert.equal(result.warnings.length, 1);
});
