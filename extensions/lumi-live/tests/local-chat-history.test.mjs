import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { STORAGE_KEYS } from "../core/extension-config.js";
import {
  createLocalChatHistoryStore,
  createLocalChatSession,
  deriveLocalChatSessionTitle,
  findReusableBlankChatSession,
  LOCAL_CHAT_HISTORY_VERSION,
  MAX_LOCAL_CHAT_HISTORY_CHARS,
  MAX_LOCAL_CHAT_HISTORY_TURNS,
  normalizeLocalChatHistory,
  normalizeLocalChatHistoryState,
  serializeLocalChatHistoryState,
} from "../side-panel/local-chat-history.js";

const extensionRoot = new URL("../", import.meta.url);

function createMemoryStorage() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return { [key]: values.get(key) };
    },
    async set(update) {
      for (const [key, value] of Object.entries(update)) values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

test("normalizes a bounded text-only transcript", () => {
  const turns = normalizeLocalChatHistory({
    turns: [
      { role: "model", text: "orphan model turn" },
      { role: "user", text: "  First   question  " },
      { role: "thinking", text: "private reasoning" },
      { role: "model", text: " First answer " },
    ],
  });
  assert.deepEqual(turns, [
    { role: "user", text: "First question" },
    { role: "model", text: "First answer" },
  ]);

  const manyTurns = Array.from({ length: 400 }, (_, index) => ({
    role: index % 2 ? "model" : "user",
    text: `turn-${index}-${"x".repeat(2000)}`,
  }));
  const bounded = normalizeLocalChatHistory(manyTurns);
  assert.ok(bounded.length <= MAX_LOCAL_CHAT_HISTORY_TURNS);
  assert.ok(
    bounded.reduce((total, turn) => total + turn.text.length, 0)
      <= MAX_LOCAL_CHAT_HISTORY_CHARS,
  );
  assert.equal(bounded[0]?.role, "user");
});

test("migrates the previous single transcript into the first named chat session", () => {
  const migrated = normalizeLocalChatHistoryState({
    version: 1,
    savedAt: 123456,
    turns: [
      { role: "user", text: "Research the latest project status" },
      { role: "model", text: "I will check it." },
    ],
  }, { now: 999999 });
  assert.equal(migrated.version, LOCAL_CHAT_HISTORY_VERSION);
  assert.equal(migrated.activeSessionId, "legacy-123456");
  assert.deepEqual(migrated.sessions, [{
    id: "legacy-123456",
    title: "Research the latest project status",
    createdAt: 123456,
    updatedAt: 123456,
    turns: [
      { role: "user", text: "Research the latest project status" },
      { role: "model", text: "I will check it." },
    ],
  }]);
});

test("keeps multiple sessions sorted and derives compact titles", () => {
  const older = createLocalChatSession({
    id: "older",
    createdAt: 100,
    updatedAt: 200,
    turns: [{ role: "user", text: "Older task" }],
  });
  const newer = createLocalChatSession({
    id: "newer",
    createdAt: 300,
    updatedAt: 400,
    turns: [{
      role: "user",
      text: "A very long request ".repeat(10),
    }],
  });
  const state = normalizeLocalChatHistoryState({
    activeSessionId: older.id,
    sessions: [older, newer],
  });
  assert.deepEqual(state.sessions.map((session) => session.id), ["newer", "older"]);
  assert.equal(state.activeSessionId, "older");
  assert.ok(state.sessions[0].title.endsWith("…"));
  assert.equal(
    deriveLocalChatSessionTitle([{ role: "user", text: "  Plan   release  " }]),
    "Plan release",
  );
});

test("reuses an existing blank chat instead of creating duplicates", () => {
  const blank = createLocalChatSession({
    id: "blank",
    createdAt: 10,
    turns: [],
  });
  const activeBlank = createLocalChatSession({
    id: "active-blank",
    createdAt: 20,
    turns: [],
  });
  const populated = createLocalChatSession({
    id: "populated",
    createdAt: 30,
    turns: [{ role: "user", text: "Keep this chat" }],
  });

  assert.equal(
    findReusableBlankChatSession([blank, populated], populated.id)?.id,
    blank.id,
  );
  assert.equal(
    findReusableBlankChatSession([blank, activeBlank], activeBlank.id)?.id,
    activeBlank.id,
  );
  assert.equal(findReusableBlankChatSession([populated]), null);
});

test("saves, restores, and clears session history in write order", async () => {
  const storageArea = createMemoryStorage();
  const store = createLocalChatHistoryStore({
    storageArea,
    storageKey: STORAGE_KEYS.chatHistory,
    now: () => 123456,
  });
  const session = createLocalChatSession({
    id: "chat-one",
    createdAt: 100,
    updatedAt: 200,
    turns: [
      { role: "user", text: "Hello Lumi" },
      { role: "model", text: "Hello!" },
    ],
  });
  const state = {
    activeSessionId: session.id,
    sessions: [session],
  };
  await store.save(state);
  assert.deepEqual(
    storageArea.values.get(STORAGE_KEYS.chatHistory),
    serializeLocalChatHistoryState(state, 123456),
  );
  assert.deepEqual(await store.load(), normalizeLocalChatHistoryState(state));

  const pendingSave = store.save({
    activeSessionId: session.id,
    sessions: [{
      ...session,
      turns: [...session.turns, { role: "user", text: "Keep going" }],
    }],
  });
  const pendingClear = store.clear();
  await Promise.all([pendingSave, pendingClear]);
  assert.equal(storageArea.values.has(STORAGE_KEYS.chatHistory), false);
  assert.deepEqual(await store.load().then((value) => value.sessions), []);
});

test("wires New chat, the saved-session dialog, switching, deletion, and clearing", async () => {
  const [panelHtml, panelController, panelStyles] = await Promise.all([
    readFile(new URL("side-panel/index.html", extensionRoot), "utf8"),
    readFile(new URL("side-panel/index.js", extensionRoot), "utf8"),
    readFile(new URL("side-panel/styles.css", extensionRoot), "utf8"),
  ]);
  assert.match(panelHtml, /id="newChatButton"/);
  assert.match(panelHtml, /id="chatHistoryDialog"/);
  assert.match(panelHtml, /id="chatConfirmationDialog"/);
  assert.match(panelHtml, /id="chatConfirmationConfirm"/);
  assert.match(panelHtml, /id="chatSessionList"/);
  assert.match(panelHtml, /id="clearHistoryButton"/);
  assert.match(panelController, /chatHistoryStore\.save\(chatHistoryState\)/);
  assert.match(panelController, /async function startNewChatSession\(\)/);
  assert.match(panelController, /async function activateChatSession\(sessionId\)/);
  assert.match(panelController, /async function deleteChatSession\(sessionId\)/);
  assert.match(panelController, /findReusableBlankChatSession/);
  assert.match(panelController, /Connection stays active/);
  assert.doesNotMatch(panelController, /window\.confirm/);
  assert.doesNotMatch(panelController, /reconnectAfterChatSessionChange/);
  const newChatSource = panelController.slice(
    panelController.indexOf("async function startNewChatSession"),
    panelController.indexOf("async function activateChatSession"),
  );
  assert.match(newChatSource, /findReusableBlankChatSession/);
  assert.match(newChatSource, /cancelConversationWorkForChatChange\(\)/);
  assert.match(newChatSource, /clearConversationContext\(\)/);
  assert.doesNotMatch(
    newChatSource,
    /stopSession|autoStartSessionIfReady|websocket(?:\?|)\.close|cleanupMedia/,
  );
  assert.match(panelController, /restoreLocalChatHistory\(\)/);
  assert.match(panelController, /pendingConversationBoundary = true/);
  assert.match(panelController, /sendPendingConversationBoundary\(\)/);
  assert.match(panelController, /await chatHistoryStore\.clear\(\)/);
  assert.match(panelStyles, /\.chat-history-dialog/);
  assert.match(panelStyles, /\.chat-confirmation-dialog/);
  assert.match(panelStyles, /\.chat-session-row\.is-active/);
});
