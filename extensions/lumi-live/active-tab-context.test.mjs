import assert from "node:assert/strict";
import test from "node:test";

import {
  extractActiveContextIdentifiers,
  sanitizeActiveContextUrl,
} from "./active-tab-context.js";

test("extracts file context from a Hawee-style viewer URL", () => {
  const safeUrl = sanitizeActiveContextUrl(
    "https://example.test/viewer/pdf?filename=H1_KS.pdf&baseFileId=6a5898b45338c21e4aecbb68&baseMajorRev=3",
  );
  assert.deepEqual(extractActiveContextIdentifiers(safeUrl).identifiers, [
    { name: "filename", value: "H1_KS.pdf", source: "query" },
    { name: "baseFileId", value: "6a5898b45338c21e4aecbb68", source: "query" },
    { name: "baseMajorRev", value: "3", source: "query" },
  ]);
});

test("redacts credential-like query and hash values", () => {
  const safeUrl = sanitizeActiveContextUrl(
    "https://example.test/files/abc?fileId=abc&access_token=secret#id_token=hidden&view=page",
  );
  assert.doesNotMatch(safeUrl, /secret|hidden/);
  assert.match(safeUrl, /fileId=abc/);
  assert.match(safeUrl, /redacted/i);
});

test("keeps recent decoded path segments as context candidates", () => {
  const context = extractActiveContextIdentifiers("https://example.test/projects/p-12/files/My%20Plan.pdf");
  assert.deepEqual(context.pathSegments, ["projects", "p-12", "files", "My Plan.pdf"]);
});
