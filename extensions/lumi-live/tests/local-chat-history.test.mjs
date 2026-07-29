import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { STORAGE_KEYS } from "../core/extension-config.js";
import {
  createLocalChatHistoryStore,
  LOCAL_CHAT_HISTORY_VERSION,
  MAX_LOCAL_CHAT_HISTORY_CHARS,
  MAX_LOCAL_CHAT_HISTORY_TURNS,
  normalizeLocalChatHistory,
  serializeLocalChatHistory,
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

test("normalizes a larger local archive without persisting unsupported turns", () => {
  const turns = normalizeLocalChatHistory({
    version: 999,
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

test("saves, restores, and clears local chat history in write order", async () => {
  const storageArea = createMemoryStorage();
  const store = createLocalChatHistoryStore({
    storageArea,
    storageKey: STORAGE_KEYS.chatHistory,
    now: () => 123456,
  });
  const turns = [
    { role: "user", text: "Hello Lumi" },
    { role: "model", text: "Hello!" },
  ];
  await store.save(turns);
  assert.deepEqual(
    storageArea.values.get(STORAGE_KEYS.chatHistory),
    {
      version: LOCAL_CHAT_HISTORY_VERSION,
      savedAt: 123456,
      turns,
    },
  );
  assert.deepEqual(await store.load(), turns);

  const pendingSave = store.save([
    ...turns,
    { role: "user", text: "Keep going" },
  ]);
  const pendingClear = store.clear();
  await Promise.all([pendingSave, pendingClear]);
  assert.equal(storageArea.values.has(STORAGE_KEYS.chatHistory), false);
  assert.deepEqual(await store.load(), []);
});

test("serializes only text turns and wires restore plus explicit local clearing", async () => {
  assert.deepEqual(
    serializeLocalChatHistory([
      { role: "user", text: "Question" },
      { role: "thinking", text: "Do not persist" },
      { role: "model", text: "Answer" },
    ], 99),
    {
      version: LOCAL_CHAT_HISTORY_VERSION,
      savedAt: 99,
      turns: [
        { role: "user", text: "Question" },
        { role: "model", text: "Answer" },
      ],
    },
  );

  const [panelHtml, panelController] = await Promise.all([
    readFile(new URL("side-panel/index.html", extensionRoot), "utf8"),
    readFile(new URL("side-panel/index.js", extensionRoot), "utf8"),
  ]);
  assert.match(panelHtml, /id="clearHistoryButton"/);
  assert.match(panelController, /chatHistoryStore\.save\(localChatHistory\)/);
  assert.match(panelController, /trimConversationHistory\(restored\)/);
  assert.match(panelController, /await restoreLocalChatHistory\(\)/);
  assert.match(panelController, /await chatHistoryStore\.clear\(\)/);
  assert.match(panelController, /window\.confirm/);
});
