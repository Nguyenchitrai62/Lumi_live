export const SIDE_PANEL_CLOSE_GRACE_MS = 400;

export function createSidePanelLifecycle({
  nativeCloseEvents = false,
  closeGraceMs = SIDE_PANEL_CLOSE_GRACE_MS,
  onOpened = async () => {},
  onClosed = async () => {},
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timerId) => clearTimeout(timerId),
} = {}) {
  const ports = new Set();
  let open = false;
  let generation = 0;
  let closeTimerId = null;
  let closePending = false;
  let nativeReopenPending = false;
  let lifecycleWork = Promise.resolve();

  function enqueue(work) {
    lifecycleWork = lifecycleWork.catch(() => {}).then(work).catch(() => {});
    return lifecycleWork;
  }

  function cancelScheduledClose() {
    if (closeTimerId === null) return;
    clearTimer(closeTimerId);
    closeTimerId = null;
  }

  function markOpened({ nativeEvent = false } = {}) {
    const wasOpen = open;
    const interruptedClose = closePending;
    cancelScheduledClose();
    closePending = false;
    const shouldNotifyOpened = !wasOpen || (nativeEvent && nativeReopenPending);
    if (nativeEvent || !wasOpen) nativeReopenPending = false;
    if (!shouldNotifyOpened) {
      // A runtime Port reconnect only restores the service-worker transport. It
      // must not replay feature-level "panel opened" work. Still invalidate a
      // close callback that may already be queued behind other lifecycle work.
      if (interruptedClose) generation += 1;
      return lifecycleWork;
    }
    open = true;
    const currentGeneration = ++generation;
    return enqueue(() => onOpened({
      isCurrent: () => open && generation === currentGeneration,
    }));
  }

  function scheduleClosed() {
    cancelScheduledClose();
    closePending = true;
    const currentGeneration = ++generation;
    closeTimerId = setTimer(() => {
      closeTimerId = null;
      void enqueue(async () => {
        if (generation !== currentGeneration) return;
        if (ports.size > 0) {
          closePending = false;
          nativeReopenPending = false;
          return;
        }
        closePending = false;
        open = false;
        await onClosed({
          isCurrent: () => !open && generation === currentGeneration,
        });
      });
    }, closeGraceMs);
  }

  function connect(port) {
    if (!port?.onDisconnect?.addListener) {
      throw new TypeError("Side-panel lifecycle requires a Chrome runtime Port.");
    }
    ports.add(port);
    void markOpened();
    let disconnected = false;
    port.onDisconnect.addListener(() => {
      if (disconnected) return;
      disconnected = true;
      ports.delete(port);
      if (ports.size > 0 || nativeCloseEvents) return;
      scheduleClosed();
    });
    return port;
  }

  function nativeOpened() {
    return markOpened({ nativeEvent: true });
  }

  function nativeClosed() {
    nativeReopenPending = true;
    scheduleClosed();
  }

  return Object.freeze({
    connect,
    nativeClosed,
    nativeOpened,
    waitForIdle: () => lifecycleWork,
    get isOpen() {
      return open;
    },
    get portCount() {
      return ports.size;
    },
  });
}
