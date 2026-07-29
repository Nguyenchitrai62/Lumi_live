export const LOCAL_CHAT_SNAPSHOT_VERSION = 1;
export const LOCAL_CHAT_SNAPSHOT_DATABASE = "lumiLocalChatSessions";
export const LOCAL_CHAT_SNAPSHOT_STORE = "transcriptSnapshots";

function normalizeSessionId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 128);
}

function cloneSerializable(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeTaskHistory(value) {
  return cloneSerializable(
    Array.isArray(value)
      ? value.filter((event) => event && typeof event === "object")
      : [],
    [],
  );
}

export function normalizeLocalChatSnapshot(value, sessionId = value?.sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("A chat session ID is required for its transcript snapshot.");
  }
  const taskHistory = normalizeTaskHistory(value?.taskHistory);
  return {
    version: LOCAL_CHAT_SNAPSHOT_VERSION,
    sessionId: normalizedSessionId,
    updatedAt: Math.max(0, Math.trunc(Number(value?.updatedAt) || Date.now())),
    transcriptHtml: String(value?.transcriptHtml || ""),
    transcriptScrollTop: Math.max(
      0,
      Math.trunc(Number(value?.transcriptScrollTop) || 0),
    ),
    taskHistory,
  };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error || new Error("IndexedDB request failed."),
    );
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error || new Error("IndexedDB transaction was aborted."),
    );
    transaction.onerror = () => reject(
      transaction.error || new Error("IndexedDB transaction failed."),
    );
  });
}

export function createLocalChatSnapshotStore({
  indexedDb = globalThis.indexedDB,
  databaseName = LOCAL_CHAT_SNAPSHOT_DATABASE,
  storeName = LOCAL_CHAT_SNAPSHOT_STORE,
  now = Date.now,
} = {}) {
  if (!indexedDb?.open) {
    throw new Error("IndexedDB is required for complete local chat snapshots.");
  }
  let databasePromise = null;
  let pendingWrite = Promise.resolve();

  const openDatabase = () => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName, { keyPath: "sessionId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error || new Error("Could not open the Lumi chat database."),
      );
      request.onblocked = () => reject(
        new Error("The Lumi chat database upgrade is blocked by another panel."),
      );
    });
    return databasePromise;
  };

  const enqueueWrite = (operation) => {
    const nextWrite = pendingWrite.catch(() => {}).then(operation);
    pendingWrite = nextWrite;
    return nextWrite;
  };

  return Object.freeze({
    async load(sessionId) {
      await pendingWrite.catch(() => {});
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId) return null;
      const database = await openDatabase();
      const transaction = database.transaction(storeName, "readonly");
      const stored = await requestResult(
        transaction.objectStore(storeName).get(normalizedSessionId),
      );
      return stored
        ? normalizeLocalChatSnapshot(stored, normalizedSessionId)
        : null;
    },

    save(value) {
      const snapshot = normalizeLocalChatSnapshot({
        ...value,
        updatedAt: now(),
      });
      return enqueueWrite(async () => {
        const database = await openDatabase();
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(snapshot);
        await transactionComplete(transaction);
        return snapshot;
      });
    },

    delete(sessionId) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      if (!normalizedSessionId) return Promise.resolve();
      return enqueueWrite(async () => {
        const database = await openDatabase();
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete(normalizedSessionId);
        await transactionComplete(transaction);
      });
    },

    clear() {
      return enqueueWrite(async () => {
        const database = await openDatabase();
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).clear();
        await transactionComplete(transaction);
      });
    },
  });
}
