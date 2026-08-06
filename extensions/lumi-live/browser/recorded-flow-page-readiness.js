export const DEFAULT_RECORDED_FLOW_PAGE_LOAD_TIMEOUT_MS = 45000;

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function defaultDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForRecordedFlowPageReady(tabId, {
  assertActive = () => {},
  delay = defaultDelay,
  getTab,
  navigationStartGraceMs = 0,
  now = () => Date.now(),
  pollIntervalMs = 150,
  postLoadQuietMs = 350,
  tabIsReady = (tab) => tab?.status === "complete",
  timeoutMs = DEFAULT_RECORDED_FLOW_PAGE_LOAD_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(tabId) || typeof getTab !== "function") {
    throw new Error("Recorded-flow page readiness requires a valid browser tab.");
  }

  const maximumWait = boundedNumber(
    timeoutMs,
    DEFAULT_RECORDED_FLOW_PAGE_LOAD_TIMEOUT_MS,
    2000,
    120000,
  );
  const navigationGrace = boundedNumber(navigationStartGraceMs, 0, 0, 5000);
  const pollInterval = boundedNumber(pollIntervalMs, 150, 25, 1000);
  const quietPeriod = boundedNumber(postLoadQuietMs, 250, 0, 2000);
  const startedAt = now();
  let lastTab = null;
  let sawLoading = false;

  while (now() - startedAt <= maximumWait) {
    assertActive();
    lastTab = await getTab(tabId);
    if (!lastTab) throw new Error("The browser tab closed while the recorded flow was waiting for the page.");
    if (lastTab.status === "loading") sawLoading = true;

    const navigationGraceElapsed = now() - startedAt >= navigationGrace;
    if (tabIsReady(lastTab) && navigationGraceElapsed) {
      if (quietPeriod > 0) {
        await delay(quietPeriod);
        assertActive();
        lastTab = await getTab(tabId);
        if (!lastTab) {
          throw new Error("The browser tab closed while the recorded flow was waiting for the page.");
        }
        if (lastTab.status === "loading") sawLoading = true;
      }
      if (tabIsReady(lastTab)) return { sawLoading, tab: lastTab };
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= maximumWait) break;
    await delay(Math.min(pollInterval, maximumWait - elapsedMs));
  }

  const seconds = Math.round(maximumWait / 1000);
  const detail = lastTab?.status === "loading"
    ? `The page was still loading after ${seconds} seconds.`
    : `The page did not become ready after ${seconds} seconds.`;
  throw new Error(detail);
}
