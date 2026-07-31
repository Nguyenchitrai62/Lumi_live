import assert from "node:assert/strict";
import test from "node:test";

import { createSidePanelLifecycle } from "../background/side-panel-lifecycle.js";
import { createResilientRuntimePort } from "../side-panel/lifecycle-port.js";

function createTimers() {
  const pending = new Map();
  let sequence = 0;
  return {
    clearTimer(timerId) {
      pending.delete(timerId);
    },
    runAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    setTimer(callback) {
      const timerId = ++sequence;
      pending.set(timerId, callback);
      return timerId;
    },
  };
}

function createPort() {
  const disconnectListeners = [];
  return {
    disconnect() {
      for (const listener of disconnectListeners) listener();
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      },
    },
  };
}

test("does not treat a temporary port disconnect as a native side-panel close", async () => {
  let closed = 0;
  const lifecycle = createSidePanelLifecycle({
    nativeCloseEvents: true,
    onClosed: async () => { closed += 1; },
  });
  const port = createPort();

  lifecycle.connect(port);
  await lifecycle.waitForIdle();
  port.disconnect();
  await lifecycle.waitForIdle();

  assert.equal(closed, 0);
  assert.equal(lifecycle.isOpen, true);
});

test("cancels legacy close cleanup when the panel reconnects during the grace period", async () => {
  const timers = createTimers();
  let opened = 0;
  let closed = 0;
  const lifecycle = createSidePanelLifecycle({
    closeGraceMs: 10,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onOpened: async () => { opened += 1; },
    onClosed: async () => { closed += 1; },
  });
  const firstPort = createPort();

  lifecycle.connect(firstPort);
  await lifecycle.waitForIdle();
  firstPort.disconnect();
  assert.equal(lifecycle.isOpen, true);
  lifecycle.connect(createPort());
  timers.runAll();
  await lifecycle.waitForIdle();

  assert.equal(opened, 1);
  assert.equal(closed, 0);
  assert.equal(lifecycle.isOpen, true);
});

test("runs cleanup after Chrome confirms that the side panel closed", async () => {
  const timers = createTimers();
  let closed = 0;
  const lifecycle = createSidePanelLifecycle({
    nativeCloseEvents: true,
    closeGraceMs: 10,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onClosed: async () => { closed += 1; },
  });
  const port = createPort();

  lifecycle.connect(port);
  await lifecycle.waitForIdle();
  port.disconnect();
  lifecycle.nativeClosed();
  timers.runAll();
  await lifecycle.waitForIdle();

  assert.equal(closed, 1);
  assert.equal(lifecycle.isOpen, false);
});

test("reports one reopen when the Port connects before Chrome's native opened event", async () => {
  const timers = createTimers();
  let opened = 0;
  const lifecycle = createSidePanelLifecycle({
    nativeCloseEvents: true,
    closeGraceMs: 10,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onOpened: async () => { opened += 1; },
  });
  const firstPort = createPort();

  lifecycle.connect(firstPort);
  await lifecycle.waitForIdle();
  firstPort.disconnect();
  lifecycle.nativeClosed();
  timers.runAll();
  await lifecycle.waitForIdle();
  lifecycle.connect(createPort());
  lifecycle.nativeOpened();
  await lifecycle.waitForIdle();

  assert.equal(opened, 2);
  assert.equal(lifecycle.isOpen, true);
});

test("keeps another side-panel instance open when one window closes", async () => {
  const timers = createTimers();
  let closed = 0;
  const lifecycle = createSidePanelLifecycle({
    nativeCloseEvents: true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onClosed: async () => { closed += 1; },
  });
  const firstPort = createPort();

  lifecycle.connect(firstPort);
  lifecycle.connect(createPort());
  await lifecycle.waitForIdle();
  firstPort.disconnect();
  lifecycle.nativeClosed();
  timers.runAll();
  await lifecycle.waitForIdle();

  assert.equal(closed, 0);
  assert.equal(lifecycle.isOpen, true);
});

test("invalidates queued close work when the panel reopens", async () => {
  const timers = createTimers();
  let resolveFirstOpen;
  const firstOpenGate = new Promise((resolve) => { resolveFirstOpen = resolve; });
  let opened = 0;
  let currentOpens = 0;
  let closed = 0;
  const lifecycle = createSidePanelLifecycle({
    nativeCloseEvents: true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    async onOpened({ isCurrent }) {
      opened += 1;
      if (opened === 1) await firstOpenGate;
      if (isCurrent()) currentOpens += 1;
    },
    onClosed: async () => { closed += 1; },
  });
  const firstPort = createPort();

  lifecycle.connect(firstPort);
  firstPort.disconnect();
  lifecycle.nativeClosed();
  timers.runAll();
  lifecycle.connect(createPort());
  lifecycle.nativeOpened();
  resolveFirstOpen();
  await lifecycle.waitForIdle();

  assert.equal(closed, 0);
  assert.equal(opened, 2);
  assert.equal(currentOpens, 1);
  assert.equal(lifecycle.isOpen, true);
});

test("reconnects the lifecycle port after a service-worker disconnect", () => {
  const timers = createTimers();
  const ports = [];
  const lifecyclePort = createResilientRuntimePort({
    name: "lumi_live_side_panel",
    connect() {
      const port = createPort();
      ports.push(port);
      return port;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  assert.equal(ports.length, 1);
  ports[0].disconnect();
  timers.runAll();
  assert.equal(ports.length, 2);

  lifecyclePort.dispose();
  timers.runAll();
  assert.equal(ports.length, 2);
});
