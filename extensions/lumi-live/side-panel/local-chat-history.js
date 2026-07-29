export const LOCAL_CHAT_HISTORY_VERSION = 2;
export const MAX_LOCAL_CHAT_SESSIONS = 50;
export const MAX_LOCAL_CHAT_HISTORY_TURNS = 200;
export const MAX_LOCAL_CHAT_HISTORY_CHARS = 250000;
export const MAX_LOCAL_CHAT_HISTORY_TOTAL_CHARS = 1500000;
export const MAX_LOCAL_CHAT_SESSION_TITLE_CHARS = 64;
export const DEFAULT_LOCAL_CHAT_SESSION_TITLE = "New chat";

function normalizeTimestamp(value, fallback = 0) {
  return Math.max(0, Math.trunc(Number(value) || Number(fallback) || 0));
}

function normalizeSessionId(value, fallback) {
  return String(value || fallback || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 128);
}

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

export function deriveLocalChatSessionTitle(
  turns,
  fallback = DEFAULT_LOCAL_CHAT_SESSION_TITLE,
) {
  const firstUserTurn = normalizeLocalChatHistory(turns)
    .find((turn) => turn.role === "user");
  const title = String(firstUserTurn?.text || fallback)
    .replace(/\s+/g, " ")
    .trim();
  if (title.length <= MAX_LOCAL_CHAT_SESSION_TITLE_CHARS) {
    return title || DEFAULT_LOCAL_CHAT_SESSION_TITLE;
  }
  return `${title.slice(0, MAX_LOCAL_CHAT_SESSION_TITLE_CHARS - 1).trimEnd()}…`;
}

export function createLocalChatSession({
  id,
  title = DEFAULT_LOCAL_CHAT_SESSION_TITLE,
  createdAt = Date.now(),
  updatedAt = createdAt,
  turns = [],
} = {}) {
  const normalizedCreatedAt = normalizeTimestamp(createdAt, Date.now());
  const normalizedTurns = normalizeLocalChatHistory(turns);
  return {
    id: normalizeSessionId(id, `chat-${normalizedCreatedAt}`),
    title: normalizedTurns.length
      ? deriveLocalChatSessionTitle(normalizedTurns, title)
      : deriveLocalChatSessionTitle([], title),
    createdAt: normalizedCreatedAt,
    updatedAt: Math.max(
      normalizedCreatedAt,
      normalizeTimestamp(updatedAt, normalizedCreatedAt),
    ),
    turns: normalizedTurns,
  };
}

function migrateLegacyHistory(value, now) {
  if (Array.isArray(value?.sessions)) return value;
  const turns = normalizeLocalChatHistory(value);
  if (!turns.length) return { activeSessionId: "", sessions: [] };
  const savedAt = normalizeTimestamp(value?.savedAt, now);
  const session = createLocalChatSession({
    id: `legacy-${savedAt}`,
    createdAt: savedAt,
    updatedAt: savedAt,
    turns,
  });
  return {
    activeSessionId: session.id,
    sessions: [session],
  };
}

export function normalizeLocalChatHistoryState(
  value,
  {
    now = Date.now(),
    maxSessions = MAX_LOCAL_CHAT_SESSIONS,
    maxTotalChars = MAX_LOCAL_CHAT_HISTORY_TOTAL_CHARS,
  } = {},
) {
  const normalizedNow = normalizeTimestamp(now, Date.now());
  const source = migrateLegacyHistory(value, normalizedNow);
  const requestedActiveSessionId = normalizeSessionId(source?.activeSessionId);
  const sessionLimit = Math.max(0, Math.trunc(Number(maxSessions) || 0));
  let remainingChars = Math.max(0, Math.trunc(Number(maxTotalChars) || 0));
  const seenIds = new Set();
  const normalizedSessions = (Array.isArray(source?.sessions) ? source.sessions : [])
    .map((session, index) => {
      const createdAt = normalizeTimestamp(
        session?.createdAt,
        session?.updatedAt || normalizedNow,
      );
      const fallbackId = `chat-${createdAt}-${index + 1}`;
      let id = normalizeSessionId(session?.id, fallbackId);
      while (seenIds.has(id)) id = `${id}-${index + 1}`;
      seenIds.add(id);
      return createLocalChatSession({
        ...session,
        id,
        createdAt,
        updatedAt: session?.updatedAt,
      });
    })
    .sort((left, right) => (
      right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || left.id.localeCompare(right.id)
    ));

  const sessions = [];
  for (const session of normalizedSessions) {
    if (sessions.length >= sessionLimit) break;
    if (!session.turns.length) {
      sessions.push(session);
      continue;
    }
    if (remainingChars <= 0) break;
    const turns = normalizeLocalChatHistory(session.turns, {
      maxChars: Math.min(MAX_LOCAL_CHAT_HISTORY_CHARS, remainingChars),
    });
    if (!turns.length) continue;
    sessions.push({
      ...session,
      title: deriveLocalChatSessionTitle(turns, session.title),
      turns,
    });
    remainingChars -= turns.reduce((total, turn) => total + turn.text.length, 0);
  }

  const activeSessionId = sessions.some(
    (session) => session.id === requestedActiveSessionId,
  )
    ? requestedActiveSessionId
    : sessions[0]?.id || "";
  return {
    version: LOCAL_CHAT_HISTORY_VERSION,
    activeSessionId,
    sessions,
  };
}

export function serializeLocalChatHistoryState(state, savedAt = Date.now()) {
  return {
    ...normalizeLocalChatHistoryState(state, { now: savedAt }),
    savedAt: normalizeTimestamp(savedAt),
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
      return normalizeLocalChatHistoryState(stored?.[key], { now: now() });
    },

    save(state) {
      const payload = serializeLocalChatHistoryState(state, now());
      return enqueueWrite(async () => {
        await storageArea.set({ [key]: payload });
        return payload;
      });
    },

    clear() {
      return enqueueWrite(async () => {
        await storageArea.remove(key);
      });
    },
  };
}
