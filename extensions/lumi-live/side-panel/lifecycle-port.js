export const LIFECYCLE_PORT_RECONNECT_DELAY_MS = 200;

export function createResilientRuntimePort({
  connect,
  name,
  reconnectDelayMs = LIFECYCLE_PORT_RECONNECT_DELAY_MS,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timerId) => clearTimeout(timerId),
}) {
  let activePort = null;
  let reconnectTimerId = null;
  let disposed = false;

  function scheduleReconnect() {
    if (disposed || reconnectTimerId !== null) return;
    reconnectTimerId = setTimer(() => {
      reconnectTimerId = null;
      open();
    }, reconnectDelayMs);
  }

  function open() {
    if (disposed || activePort) return activePort;
    let port = null;
    try {
      port = connect({ name });
      if (!port?.onDisconnect?.addListener) {
        throw new TypeError("Lifecycle connection did not return a Chrome runtime Port.");
      }
      activePort = port;
      port.onDisconnect.addListener(() => {
        if (activePort !== port) return;
        activePort = null;
        scheduleReconnect();
      });
      return port;
    } catch {
      if (activePort === port) activePort = null;
      try {
        port?.disconnect();
      } catch {
        // The invalid or partially initialized port is already unusable.
      }
      scheduleReconnect();
      return null;
    }
  }

  function dispose() {
    disposed = true;
    if (reconnectTimerId !== null) clearTimer(reconnectTimerId);
    reconnectTimerId = null;
    const port = activePort;
    activePort = null;
    port?.disconnect();
  }

  open();

  return Object.freeze({
    dispose,
    get port() {
      return activePort;
    },
  });
}
