const DATABASE_NAME = "lumi_history_v1";
const DATABASE_VERSION = 1;
const MAX_CONVERSATIONS = 100;
const MAX_BYTES = 100 * 1024 * 1024;

const SECRET_PATTERNS = [
  [/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_GOOGLE_API_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "Bearer [REDACTED]"],
  [
    /\b(api[_ -]?key|password|passwd|secret|token|authorization|cookie)\s*[:=]\s*([^\s,;]{5,})/gi,
    "$1=[REDACTED]",
  ],
  [
    /\b(tk|tài khoản|tai khoan|account|username|user)\s*[:=]\s*([^\s,;]+)(?:\s*[/|]\s*([^\s,;]+))?/gi,
    "$1=[REDACTED_ACCOUNT]",
  ],
  [/(https?:\/\/[^\s?#]+[?&](?:key|token|api_key|access_token)=)[^&#\s]+/gi, "$1[REDACTED]"],
];

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
  });
}

function bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function redactHistoryText(value) {
  let text = String(value || "");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.slice(0, 64000);
}

export function createConversationHistoryStore({
  indexedDBImpl = globalThis.indexedDB,
  now = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  let databasePromise = null;

  function openDatabase() {
    if (!indexedDBImpl) throw new Error("IndexedDB is unavailable.");
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDBImpl.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("conversations")) {
            const conversations = database.createObjectStore("conversations", { keyPath: "id" });
            conversations.createIndex("updatedAt", "updatedAt");
          }
          if (!database.objectStoreNames.contains("messages")) {
            const messages = database.createObjectStore("messages", {
              keyPath: "id",
              autoIncrement: true,
            });
            messages.createIndex("conversationId", "conversationId");
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open chat history."));
      });
    }
    return databasePromise;
  }

  async function listConversations() {
    const database = await openDatabase();
    const transaction = database.transaction("conversations", "readonly");
    const values = await requestResult(transaction.objectStore("conversations").getAll());
    await transactionDone(transaction);
    return values.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async function storageUsage() {
    const conversations = await listConversations();
    return {
      conversations: conversations.length,
      bytes: conversations.reduce((total, item) => total + Number(item.estimatedBytes || 0), 0),
    };
  }

  async function createConversation(title = "New chat") {
    const usage = await storageUsage();
    if (usage.conversations >= MAX_CONVERSATIONS || usage.bytes >= MAX_BYTES) {
      const error = new Error(
        "Local chat history reached 100 conversations or 100 MB. Delete history before creating another chat.",
      );
      error.code = "HISTORY_LIMIT";
      throw error;
    }
    const timestamp = now();
    const conversation = {
      id: randomUUID(),
      title: redactHistoryText(title).replace(/\s+/g, " ").trim().slice(0, 80) || "New chat",
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0,
      estimatedBytes: 0,
      terminalError: "",
      runIds: [],
    };
    const database = await openDatabase();
    const transaction = database.transaction("conversations", "readwrite");
    transaction.objectStore("conversations").add(conversation);
    await transactionDone(transaction);
    return conversation;
  }

  async function getConversation(conversationId) {
    const database = await openDatabase();
    const transaction = database.transaction("conversations", "readonly");
    const value = await requestResult(
      transaction.objectStore("conversations").get(conversationId),
    );
    await transactionDone(transaction);
    return value || null;
  }

  async function getMessages(conversationId) {
    const database = await openDatabase();
    const transaction = database.transaction("messages", "readonly");
    const values = await requestResult(
      transaction.objectStore("messages").index("conversationId").getAll(conversationId),
    );
    await transactionDone(transaction);
    return values.sort((left, right) => left.createdAt - right.createdAt);
  }

  async function addMessage(conversationId, {
    role,
    text,
    kind = "chat",
    runId = "",
  }) {
    const conversation = await getConversation(conversationId);
    if (!conversation) throw new Error("The selected local conversation no longer exists.");
    const message = {
      conversationId,
      role: ["user", "model", "system"].includes(role) ? role : "system",
      text: redactHistoryText(text),
      kind,
      runId: String(runId || ""),
      createdAt: now(),
    };
    const messageBytes = bytes(message);
    const usage = await storageUsage();
    if (usage.bytes + messageBytes > MAX_BYTES) {
      const error = new Error(
        "Local chat history reached 100 MB. Delete history before more messages can be persisted.",
      );
      error.code = "HISTORY_LIMIT";
      throw error;
    }
    conversation.updatedAt = message.createdAt;
    conversation.messageCount += 1;
    conversation.estimatedBytes += messageBytes;
    if (runId && !conversation.runIds.includes(runId)) conversation.runIds.push(runId);
    if (kind === "terminal_error") conversation.terminalError = message.text.slice(0, 1000);
    if (
      conversation.title === "New chat"
      && message.role === "user"
      && message.text
    ) {
      conversation.title = message.text.replace(/\s+/g, " ").trim().slice(0, 80);
    }
    const database = await openDatabase();
    const transaction = database.transaction(
      ["conversations", "messages"],
      "readwrite",
    );
    transaction.objectStore("messages").add(message);
    transaction.objectStore("conversations").put(conversation);
    await transactionDone(transaction);
    return message;
  }

  async function renameConversation(conversationId, title) {
    const conversation = await getConversation(conversationId);
    if (!conversation) throw new Error("Conversation was not found.");
    conversation.title = redactHistoryText(title).replace(/\s+/g, " ").trim().slice(0, 80)
      || conversation.title;
    conversation.updatedAt = now();
    const database = await openDatabase();
    const transaction = database.transaction("conversations", "readwrite");
    transaction.objectStore("conversations").put(conversation);
    await transactionDone(transaction);
    return conversation;
  }

  async function deleteConversation(conversationId) {
    const database = await openDatabase();
    const transaction = database.transaction(
      ["conversations", "messages"],
      "readwrite",
    );
    transaction.objectStore("conversations").delete(conversationId);
    const messageIndex = transaction.objectStore("messages").index("conversationId");
    const cursorRequest = messageIndex.openKeyCursor(IDBKeyRange.only(conversationId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      transaction.objectStore("messages").delete(cursor.primaryKey);
      cursor.continue();
    };
    await transactionDone(transaction);
  }

  async function clear() {
    const database = await openDatabase();
    const transaction = database.transaction(
      ["conversations", "messages"],
      "readwrite",
    );
    transaction.objectStore("conversations").clear();
    transaction.objectStore("messages").clear();
    await transactionDone(transaction);
  }

  return {
    openDatabase,
    listConversations,
    storageUsage,
    createConversation,
    getConversation,
    getMessages,
    addMessage,
    renameConversation,
    deleteConversation,
    clear,
  };
}
