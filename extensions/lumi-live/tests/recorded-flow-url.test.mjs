import assert from "node:assert/strict";
import test from "node:test";

import {
  isDynamicRecordedUrlSegment,
  recordedFlowUrlMatches,
  recordedUrlValueMatches,
} from "../browser/recorded-flow-url.js";

test("recorded result URLs treat a generated numeric ID as a dynamic route slot", () => {
  const expected = "https://uat-erp.hawee.hicas.vn/du-an/a4387a79-43e0-fc8f-eb25-3a22e30ec830/boq/boq-gop/them/23258";

  assert.equal(recordedFlowUrlMatches(
    "https://uat-erp.hawee.hicas.vn/du-an/a4387a79-43e0-fc8f-eb25-3a22e30ec830/boq/boq-gop/them/24501",
    expected,
  ), true);
  assert.equal(recordedFlowUrlMatches(
    "https://uat-erp.hawee.hicas.vn/du-an/a4387a79-43e0-fc8f-eb25-3a22e30ec830/boq/boq-gop/them/undefined",
    expected,
  ), true);
});

test("dynamic result URLs still require the same origin and fixed route shape", () => {
  const expected = "https://uat.example.test/project/a/boq/import/them/23258";

  assert.equal(recordedFlowUrlMatches(
    "https://uat.example.test/project/a/boq/manage/undefined",
    expected,
  ), false);
  assert.equal(recordedFlowUrlMatches(
    "https://other.example.test/project/a/boq/import/them/undefined",
    expected,
  ), false);
  assert.equal(recordedFlowUrlMatches(
    "https://uat.example.test/project/a/boq/import/them",
    expected,
  ), false);
});

test("only recorded dynamic values become wildcards", () => {
  assert.equal(isDynamicRecordedUrlSegment("23258"), true);
  assert.equal(isDynamicRecordedUrlSegment("create"), false);
  assert.equal(recordedUrlValueMatches("undefined", "23258"), true);
  assert.equal(recordedUrlValueMatches("edit", "create"), false);
});
