import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  LOCAL_CHAT_SNAPSHOT_VERSION,
  normalizeLocalChatSnapshot,
} from "../side-panel/local-chat-snapshots.js";

const extensionRoot = new URL("../", import.meta.url);

test("keeps a complete per-session transcript snapshot and every task event", () => {
  const taskHistory = Array.from(
    { length: 2004 },
    (_, index) => ({
      id: `event-${index + 1}`,
      taskId: "task-1",
      type: index === 0 ? "task_started" : "step",
    }),
  );
  const snapshot = normalizeLocalChatSnapshot({
    sessionId: "chat-session_1",
    updatedAt: 123,
    transcriptHtml: [
      '<article class="message message-user"><p>Run it</p></article>',
      '<section class="agent-task-view"><details open>Step 1</details></section>',
      '<article class="message-capture"><img src="data:image/png;base64,AA=="></article>',
    ].join(""),
    transcriptScrollTop: 88,
    taskHistory,
  });
  assert.equal(snapshot.version, LOCAL_CHAT_SNAPSHOT_VERSION);
  assert.equal(snapshot.sessionId, "chat-session_1");
  assert.equal(snapshot.transcriptScrollTop, 88);
  assert.match(snapshot.transcriptHtml, /agent-task-view/);
  assert.match(snapshot.transcriptHtml, /data:image\/png/);
  assert.equal(snapshot.taskHistory.length, taskHistory.length);
  assert.equal(snapshot.taskHistory[0].type, "task_started");
  assert.equal(snapshot.taskHistory.at(-1).id, `event-${taskHistory.length}`);
});

test("wires IndexedDB snapshots into full transcript replay and local-only storage", async () => {
  const [manifestSource, panelController, taskView, orchestrator] = await Promise.all([
    readFile(new URL("manifest.json", extensionRoot), "utf8"),
    readFile(new URL("side-panel/index.js", extensionRoot), "utf8"),
    readFile(new URL("side-panel/task-step-view.js", extensionRoot), "utf8"),
    readFile(new URL("live/task-orchestrator.js", extensionRoot), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
  assert.match(panelController, /createLocalChatSnapshotStore/);
  assert.match(panelController, /transcriptHtml:\s*createTranscriptSnapshotHtml\(\)/);
  assert.match(panelController, /data-transient-video-transcript/);
  assert.match(panelController, /transientTranscript\.remove\(\)/);
  assert.match(panelController, /taskHistory:\s*filterTaskTranscriptHistory\(/);
  assert.match(panelController, /restoreActiveChatSessionSnapshot/);
  assert.match(panelController, /attachRestoredTranscriptDisclosures/);
  assert.match(taskView, /const hydrate = \(history = \[\]\)/);
  assert.match(orchestrator, /const restore = \(storedHistory = \[\]\)/);
});
