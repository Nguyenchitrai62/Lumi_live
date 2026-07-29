import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticVerificationQuery,
  collectAutomaticBrowserVerification,
  MAX_AUTOMATIC_VERIFICATION_CHARS,
} from "../side-panel/browser-action-verification.js";

test("derives the shortest useful post-action verification query", () => {
  assert.equal(
    automaticVerificationQuery(
      "browser_upload_file",
      {},
      { nextPageStateQuery: "demo.pdf" },
    ),
    "demo.pdf",
  );
  assert.equal(
    automaticVerificationQuery(
      "browser_select_option",
      { optionText: "Vietnamese" },
      {},
    ),
    "Vietnamese",
  );
  assert.equal(
    automaticVerificationQuery("browser_click", {}, {}),
    "",
  );
});

test("uses authoritative tab navigation results without another DOM round trip", async () => {
  let readCount = 0;
  const verification = await collectAutomaticBrowserVerification({
    tool: "browser_switch_tab",
    result: {
      switched: true,
      url: "chrome://settings/",
      title: "Settings",
      tabId: 8,
      controllable: false,
    },
    readPageState: async () => {
      readCount += 1;
      return {};
    },
  });
  assert.equal(verification.available, true);
  assert.equal(verification.conclusive, true);
  assert.equal(verification.source, "tab_navigation_result");
  assert.equal(readCount, 0);
});

test("collects bounded fresh page state after a browser action", async () => {
  const verification = await collectAutomaticBrowserVerification({
    tool: "browser_select_option",
    args: { optionText: "Vietnamese" },
    result: { success: true },
    readPageState: async (query) => ({
      queryMatched: query === "Vietnamese",
      title: "Preferences",
      url: "https://example.com/settings",
      content: "x".repeat(MAX_AUTOMATIC_VERIFICATION_CHARS + 100),
    }),
  });
  assert.equal(verification.available, true);
  assert.equal(verification.conclusive, true);
  assert.equal(verification.queryMatched, true);
  assert.equal(verification.content.length, MAX_AUTOMATIC_VERIFICATION_CHARS);
});

test("keeps upload assignment inconclusive until the page proves completion", async () => {
  const verification = await collectAutomaticBrowserVerification({
    tool: "browser_upload_file",
    result: {
      success: true,
      requiresPageVerification: true,
      nextPageStateQuery: "demo.pdf",
    },
    readPageState: async () => ({
      queryMatched: true,
      content: "demo.pdf selected",
    }),
  });
  assert.equal(verification.available, true);
  assert.equal(verification.conclusive, false);
});

test("preserves a partial stage checkpoint while collecting fresh resume state", async () => {
  let observed = 0;
  const verification = await collectAutomaticBrowserVerification({
    tool: "browser_apply_stage",
    result: {
      success: false,
      status: "partial",
      error: "Control 18 was replaced.",
      resume: {
        nextActionNumber: 4,
        completedActionCount: 3,
        remainingActionCount: 7,
        requiresFreshObservation: true,
      },
      requiresPageVerification: true,
    },
    readPageState: async () => {
      observed += 1;
      return {
        stateId: "doc:2:9",
        documentId: "doc",
        domRevision: 9,
        pageDelta: { kind: "delta", changedControls: [{ index: 18 }] },
        content: "Fresh form state",
      };
    },
  });

  assert.equal(observed, 1);
  assert.equal(verification.available, true);
  assert.equal(verification.conclusive, false);
  assert.equal(verification.stateId, "doc:2:9");
  assert.deepEqual(verification.pageDelta.changedControls, [{ index: 18 }]);
});
