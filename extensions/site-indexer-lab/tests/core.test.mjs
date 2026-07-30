import assert from "node:assert/strict";
import test from "node:test";

import {
  actionSafety,
  buildCapabilityMarkdown,
  canonicalizePageUrl,
  normalizeScanUrl,
  sameSiteOrigin,
  stateFingerprint,
} from "../core.js";

test("normalizes supported URLs and strips common tracking parameters", () => {
  assert.equal(normalizeScanUrl("example.com/app"), "https://example.com/app");
  assert.equal(
    canonicalizePageUrl("https://example.com/app?utm_source=test&id=42#details"),
    "https://example.com/app?id=42#details",
  );
  assert.equal(
    canonicalizePageUrl("https://example.com/app?z=2&a=1"),
    "https://example.com/app?a=1&z=2",
  );
  assert.throws(
    () => normalizeScanUrl("https://user:secret@example.com"),
    /credentials/i,
  );
  assert.throws(() => normalizeScanUrl("javascript:alert(1)"), /Only http/i);
});

test("keeps crawling inside one origin", () => {
  assert.equal(
    sameSiteOrigin("https://example.com/a", "https://example.com/b"),
    true,
  );
  assert.equal(
    sameSiteOrigin("https://app.example.com", "https://example.com"),
    false,
  );
  assert.equal(
    sameSiteOrigin("file:///C:/demo/a.html", "file:///C:/demo/b.html"),
    true,
  );
});

test("allows safe navigation and blocks consequential destinations", () => {
  assert.deepEqual(
    actionSafety({
      name: "Project details",
      role: "link",
      href: "https://example.com/projects/42",
      disabled: false,
    }, "https://example.com/projects"),
    {
      safe: true,
      category: "navigation",
      reason: "same-origin navigation",
      destination: "https://example.com/projects/42",
    },
  );
  assert.equal(
    actionSafety({
      name: "Delete project",
      role: "button",
      disabled: false,
    }, "https://example.com").safe,
    false,
  );
  assert.equal(
    actionSafety({
      name: "Documentation",
      role: "link",
      href: "https://docs.example.net",
      disabled: false,
    }, "https://example.com").safe,
    false,
  );
  assert.equal(
    actionSafety({
      name: "Specification",
      role: "link",
      href: "https://example.com/specification.pdf",
      download: true,
      disabled: false,
    }, "https://example.com").safe,
    false,
  );
});

test("allows deterministic read-only disclosure controls", () => {
  assert.equal(
    actionSafety({
      name: "Project settings",
      role: "button",
      expanded: false,
      disabled: false,
    }, "https://example.com").safe,
    true,
  );
  assert.equal(
    actionSafety({
      name: "Unnamed custom action",
      role: "button",
      expanded: null,
      hasPopup: false,
      disabled: false,
    }, "https://example.com").safe,
    false,
  );
  assert.equal(
    actionSafety({
      name: "Mở chi tiết",
      role: "button",
      tag: "button",
    }, "https://example.com").safe,
    true,
  );
  assert.equal(
    actionSafety({
      name: "Tạo dự án",
      role: "button",
      tag: "button",
    }, "https://example.com").safe,
    false,
  );
  assert.equal(
    actionSafety({
      name: "Unrelated item",
      context: "View details",
      role: "button",
      tag: "button",
    }, "https://example.com").safe,
    false,
  );
});

test("builds stable fingerprints and a readable Markdown index", () => {
  const snapshot = {
    url: "https://example.com/projects",
    title: "Projects",
    headings: [{ level: 1, text: "Projects" }],
    dialogs: [],
    actions: [{ role: "link", name: "Project details" }],
  };
  assert.equal(stateFingerprint(snapshot), stateFingerprint(structuredClone(snapshot)));
  assert.notEqual(
    stateFingerprint(snapshot),
    stateFingerprint({ ...snapshot, dialogs: ["Project filters"] }),
  );
  assert.notEqual(
    stateFingerprint({
      ...snapshot,
      stateSignals: { selected: ["Overview"], mainTextHash: "content-a" },
    }),
    stateFingerprint({
      ...snapshot,
      stateSignals: { selected: ["Dashboard"], mainTextHash: "content-b" },
    }),
  );

  const markdown = buildCapabilityMarkdown({
    siteTitle: "Example App",
    origin: "https://example.com",
    startUrl: "https://example.com/projects",
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T00:01:00.000Z",
    workerCount: 4,
    processedJobCount: 1,
    totalJobDurationMs: 2500,
    screens: [{
      id: "screen-001",
      route: "/projects",
      title: "Projects",
      fingerprint: "abc123",
      depth: 0,
      discoveredVia: "Start URL",
      headings: [{ level: 1, text: "Projects" }],
      safeActions: [{
        category: "navigation",
        name: "Project details",
        destination: "https://example.com/projects/42",
      }],
      forms: [],
      blockedActionCount: 2,
      url: "https://example.com/projects",
      workerId: "worker-2",
      scanDurationMs: 2500,
    }],
    transitions: [],
  });
  assert.match(markdown, /^# Example App/m);
  assert.match(markdown, /deterministic code only \(no LLM\)/i);
  assert.match(markdown, /Parallel workers: 4/);
  assert.match(markdown, /Build duration: 1m 0s/);
  assert.match(markdown, /Average job time: 2\.5 s/);
  assert.match(markdown, /Slowest scans/);
  assert.match(markdown, /worker-2/);
  assert.match(markdown, /Project details/);
  assert.match(markdown, /2 unclassified or potentially consequential controls/);
});

test("compresses shared actions and removes self-loop transitions", () => {
  const sharedAction = {
    category: "navigation",
    role: "link",
    name: "Company directory",
    destination: "https://example.com/directory",
  };
  const index = {
    siteTitle: "Compact App",
    origin: "https://example.com",
    startUrl: "https://example.com",
    workerCount: 4,
    screens: [1, 2, 3].map((ordinal) => ({
      id: `screen-00${ordinal}`,
      route: ordinal === 3 ? "/settings" : "/",
      url: ordinal === 3 ? "https://example.com/settings" : "https://example.com",
      title: ordinal === 3 ? "Settings" : "Overview",
      fingerprint: `state-${ordinal}`,
      depth: ordinal - 1,
      safeActions: [
        sharedAction,
        {
          category: "disclosure",
          role: "tab",
          name: `Local tab ${ordinal}`,
        },
      ],
      forms: [],
      headings: [],
      blockedActionCount: 0,
    })),
    transitions: [
      { from: "screen-001", to: "screen-001", action: "No change" },
      { from: "screen-001", to: "screen-003", action: "Settings" },
    ],
    noOpActionCount: 1,
    prunedActionCount: 5,
  };
  const markdown = buildCapabilityMarkdown(index);
  assert.equal((markdown.match(/Company directory/g) || []).length, 1);
  assert.doesNotMatch(markdown, /No change/);
  assert.match(markdown, /Repeated branches pruned: 5/);
  assert.match(markdown, /screen-001, screen-002/);
});
