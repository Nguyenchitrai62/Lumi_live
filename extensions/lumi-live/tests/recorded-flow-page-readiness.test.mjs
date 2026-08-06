import assert from "node:assert/strict";
import test from "node:test";

import { waitForRecordedFlowPageReady } from "../browser/recorded-flow-page-readiness.js";

function fakeClock() {
  let currentTime = 0;
  const delays = [];
  return {
    delay: async (milliseconds) => {
      delays.push(milliseconds);
      currentTime += milliseconds;
    },
    delays,
    now: () => currentTime,
  };
}

test("recorded-flow page readiness keeps waiting while the tab is loading", async () => {
  const clock = fakeClock();
  const statuses = ["loading", "loading", "complete", "complete"];
  let calls = 0;

  const result = await waitForRecordedFlowPageReady(17, {
    delay: clock.delay,
    getTab: async () => ({ id: 17, status: statuses[Math.min(calls++, statuses.length - 1)] }),
    now: clock.now,
    pollIntervalMs: 100,
    postLoadQuietMs: 50,
    timeoutMs: 2000,
  });

  assert.equal(result.tab.status, "complete");
  assert.equal(result.sawLoading, true);
  assert.equal(calls, 4);
  assert.deepEqual(clock.delays, [100, 100, 50]);
});

test("recorded-flow page readiness observes a delayed navigation before continuing", async () => {
  const clock = fakeClock();
  const statuses = ["complete", "loading", "loading", "complete", "complete"];
  let calls = 0;

  const result = await waitForRecordedFlowPageReady(23, {
    delay: clock.delay,
    getTab: async () => ({ id: 23, status: statuses[Math.min(calls++, statuses.length - 1)] }),
    navigationStartGraceMs: 200,
    now: clock.now,
    pollIntervalMs: 100,
    postLoadQuietMs: 50,
    timeoutMs: 2000,
  });

  assert.equal(result.tab.status, "complete");
  assert.equal(result.sawLoading, true);
  assert.equal(calls, 5);
  assert.deepEqual(clock.delays, [100, 100, 100, 50]);
});

test("recorded-flow new-tab readiness does not accept an about:blank placeholder", async () => {
  const clock = fakeClock();
  const tabs = [
    { id: 29, status: "complete", url: "about:blank" },
    {
      id: 29,
      pendingUrl: "https://example.test/report",
      status: "loading",
      url: "about:blank",
    },
    { id: 29, status: "complete", url: "https://example.test/report" },
    { id: 29, status: "complete", url: "https://example.test/report" },
  ];
  let calls = 0;

  const result = await waitForRecordedFlowPageReady(29, {
    delay: clock.delay,
    getTab: async () => tabs[Math.min(calls++, tabs.length - 1)],
    now: clock.now,
    pollIntervalMs: 100,
    postLoadQuietMs: 50,
    tabIsReady: (tab) => tab.status === "complete" && /^https?:\/\//.test(tab.url),
    timeoutMs: 2000,
  });

  assert.equal(result.tab.url, "https://example.test/report");
  assert.equal(result.sawLoading, true);
  assert.equal(calls, 4);
  assert.deepEqual(clock.delays, [100, 100, 50]);
});

test("recorded-flow page readiness reports failure only after the load timeout", async () => {
  const clock = fakeClock();
  let calls = 0;

  await assert.rejects(
    waitForRecordedFlowPageReady(31, {
      delay: clock.delay,
      getTab: async () => {
        calls += 1;
        return { id: 31, status: "loading" };
      },
      now: clock.now,
      pollIntervalMs: 250,
      timeoutMs: 2000,
    }),
    /still loading after 2 seconds/,
  );

  assert.equal(clock.now(), 2000);
  assert.ok(calls >= 8);
});
