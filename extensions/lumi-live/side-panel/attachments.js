import {
  imageFilesFromClipboard,
  imageFilesFromDrop,
  isSupportedImageFile,
  prepareImageAttachment,
} from "./image-attachments.js";

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_IMAGES_PER_MESSAGE = 1;
const MAX_DOCUMENT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BATCH_BYTES = 50 * 1024 * 1024;
export const DOCUMENT_ACCEPT = [
  ".xlsx",
  ".csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
].join(",");
export const ATTACHMENT_ACCEPT = `${DOCUMENT_ACCEPT},image/jpeg,image/png,image/webp,image/gif`;

const DOCUMENT_EXTENSIONS = new Set(["xlsx", "csv"]);
const DOCUMENT_MIME_TYPES = new Map([
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["text/csv", "csv"],
  ["application/csv", "csv"],
  ["application/vnd.ms-excel", "csv"],
]);

function extensionFor(file) {
  return String(file?.name || "").toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
}

export function classifyAttachmentFile(file) {
  if (!file || Number(file.size) <= 0) return null;
  if (isSupportedImageFile(file)) return { category: "image", kind: "image" };
  const extension = extensionFor(file);
  const mimeKind = DOCUMENT_MIME_TYPES.get(String(file.type || "").toLowerCase());
  if (extension && !DOCUMENT_EXTENSIONS.has(extension)) return null;
  if (!DOCUMENT_EXTENSIONS.has(extension) && !mimeKind) return null;
  return {
    category: "document",
    kind: DOCUMENT_EXTENSIONS.has(extension) ? extension : mimeKind,
  };
}

export function attachmentFilesFromClipboard(clipboardData) {
  const files = Array.from(clipboardData?.items || [])
    .filter((item) => item?.kind === "file")
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
  return files.length ? files.filter(classifyAttachmentFile) : imageFilesFromClipboard(clipboardData);
}

export function attachmentFilesFromDrop(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []).filter(classifyAttachmentFile);
  return files.length ? files : imageFilesFromDrop(dataTransfer);
}

export function validateAttachmentSelection(existingAttachments, files) {
  const existing = Array.from(existingAttachments || []);
  const selected = Array.from(files || []);
  const accepted = [];
  const errors = [];
  let totalBytes = existing.reduce(
    (sum, item) => sum + (Number(item.sourceByteSize ?? item.byteSize) || 0),
    0,
  );
  let imageCount = existing.filter((item) => item.category === "image").length;
  for (const file of selected) {
    if (!file || Number(file.size) <= 0) {
      errors.push(`${file?.name || "File"}: the file is empty.`);
      continue;
    }
    const classification = classifyAttachmentFile(file);
    if (!classification) {
      errors.push(`${file?.name || "File"}: use XLSX, CSV, JPEG, PNG, WebP, or GIF.`);
      continue;
    }
    if (existing.length + accepted.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      errors.push(`A message can contain at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`);
      break;
    }
    if (classification.category === "image" && imageCount >= MAX_IMAGES_PER_MESSAGE) {
      errors.push("A message can contain at most one image.");
      continue;
    }
    const fileLimit = classification.category === "image"
      ? 12 * 1024 * 1024
      : MAX_DOCUMENT_FILE_BYTES;
    if (file.size > fileLimit) {
      errors.push(
        `${file.name}: ${classification.category === "image" ? "images must be 12 MB or smaller" : "documents must be 25 MB or smaller"}.`,
      );
      continue;
    }
    if (totalBytes + file.size > MAX_ATTACHMENT_BATCH_BYTES) {
      errors.push("The attachment batch exceeds the 50 MB limit.");
      break;
    }
    accepted.push({ file, ...classification });
    totalBytes += file.size;
    if (classification.category === "image") imageCount += 1;
  }
  return { accepted, errors };
}

export function createDocumentParserClient({
  workerUrl = chrome.runtime.getURL("dist/document-parser-worker.js"),
  WorkerConstructor = globalThis.Worker,
} = {}) {
  const worker = new WorkerConstructor(workerUrl);
  const pending = new Map();
  worker.addEventListener("message", (event) => {
    const { requestId, ok, document, applied, error } = event.data || {};
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    if (ok) request.resolve(
      request.operation === "edit" ? { document, applied: applied || [] } : document,
    );
    else {
      const failure = new Error(error?.message || "The document could not be parsed.");
      failure.code = error?.code || "parse_failed";
      request.reject(failure);
    }
  });
  worker.addEventListener("error", (event) => {
    const failure = new Error(event?.message || "The document parser worker stopped unexpectedly.");
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  });
  function requestWorker(operation, payload, transfer = []) {
    const requestId = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const result = new Promise((resolve, reject) => pending.set(requestId, {
      resolve,
      reject,
      operation,
    }));
    worker.postMessage({ requestId, operation, ...payload }, transfer);
    return result;
  }
  return Object.freeze({
    async parse(file, kind) {
      const bytes = await file.arrayBuffer();
      return requestWorker("parse", {
        bytes,
        name: file.name,
        mimeType: file.type,
        kind,
      }, [bytes]);
    },
    async edit(sourceBytes, { name, mimeType, kind }, edits) {
      const bytes = sourceBytes.slice(0);
      return requestWorker("edit", {
        bytes,
        name,
        mimeType,
        kind,
        edits,
      }, [bytes]);
    },
    dispose() {
      worker.terminate();
      const failure = new Error("The document parser was closed.");
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
    },
  });
}

export async function prepareAttachment(file, classification, parserClient) {
  if (classification.category === "image") {
    return {
      ...(await prepareImageAttachment(file)),
      category: "image",
      kind: "image",
      parseStatus: "ready",
      sourceByteSize: file.size,
    };
  }
  const parsed = await parserClient.parse(file, classification.kind);
  return {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    category: "document",
    kind: parsed.kind,
    name: parsed.name,
    mimeType: parsed.mimeType,
    byteSize: parsed.byteSize,
    sourceByteSize: file.size,
    parseStatus: "ready",
    parsed,
  };
}

export function queuedAttachmentMessagePreview(message) {
  const text = String(message?.text || "").replace(/\s+/g, " ").trim();
  const attachments = Array.from(message?.attachments || []);
  if (!attachments.length) return text;
  const label = attachments.length === 1
    ? attachments[0].name || "Attachment"
    : `${attachments.length} attachments`;
  return text ? `${label} · ${text}` : label;
}
