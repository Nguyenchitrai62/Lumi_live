export const LOCAL_CHAT_HISTORY_VERSION = 1;
export const MAX_LOCAL_CHAT_HISTORY_TURNS = 200;
export const MAX_LOCAL_CHAT_HISTORY_CHARS = 250000;

export function normalizeLocalChatHistory(
  value,
  {
    maxTurns = MAX_LOCAL_CHAT_HISTORY_TURNS,
    maxChars = MAX_LOCAL_CHAT_HISTORY_CHARS,
  } = {},
) {
  const sourceTurns = Array.isArray(value)
    ? value
    : Array.isArray(value?.turns) ? value.turns : [];
  const turns = [];
  const turnLimit = Math.max(0, Math.trunc(Number(maxTurns) || 0));
  let remainingChars = Math.max(0, Math.trunc(Number(maxChars) || 0));
  for (
    let index = sourceTurns.length - 1;
    index >= 0 && turns.length < turnLimit;
    index -= 1
  ) {
    const turn = sourceTurns[index];
    const role = turn?.role === "model"
      ? "model"
      : turn?.role === "user" ? "user" : "";
    const text = String(turn?.text || "").replace(/\s+/g, " ").trim();
    if (!role || !text || remainingChars <= 0) continue;
    const retainedText = text.slice(-remainingChars);
    turns.push({ role, text: retainedText });
    remainingChars -= retainedText.length;
  }
  turns.reverse();
  while (turns[0]?.role === "model") turns.shift();
  return turns;
}

export function serializeLocalChatHistory(history, savedAt = Date.now()) {
  return {
    version: LOCAL_CHAT_HISTORY_VERSION,
    savedAt: Math.max(0, Math.trunc(Number(savedAt) || 0)),
    turns: normalizeLocalChatHistory(history),
  };
}

export function createLocalChatHistoryStore({
  storageArea,
  storageKey,
  now = Date.now,
} = {}) {
  if (!storageArea?.get || !storageArea?.set || !storageArea?.remove) {
    throw new Error("A Chrome-compatible storage area is required.");
  }
  const key = String(storageKey || "").trim();
  if (!key) throw new Error("A local chat-history storage key is required.");

  let pendingWrite = Promise.resolve();

  const enqueueWrite = (operation) => {
    const nextWrite = pendingWrite.catch(() => {}).then(operation);
    pendingWrite = nextWrite;
    return nextWrite;
  };

  return {
    async load() {
      await pendingWrite.catch(() => {});
      const stored = await storageArea.get(key);
      return normalizeLocalChatHistory(stored?.[key]);
    },

    save(history) {
      const payload = serializeLocalChatHistory(history, now());
      return enqueueWrite(async () => {
        await storageArea.set({ [key]: payload });
        return payload.turns;
      });
    },

    clear() {
      return enqueueWrite(async () => {
        await storageArea.remove(key);
      });
    },
  };
}
