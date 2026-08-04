import {
  DOCUMENT_LIMITS,
  parseDocumentBytes,
} from "./document-parser-core.js";
import { editXlsxBytes } from "./excel-editor-core.js";

function ownedArrayBuffer(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

self.addEventListener("message", (event) => {
  const {
    requestId,
    operation = "parse",
    bytes,
    name,
    mimeType,
    kind,
    edits,
  } = event.data || {};
  try {
    const edited = operation === "edit"
      ? editXlsxBytes(bytes, edits)
      : null;
    const outputBytes = edited?.bytes || bytes;
    const document = parseDocumentBytes(outputBytes, {
      name,
      mimeType,
      kind,
      limits: DOCUMENT_LIMITS,
    });
    const sourceBytes = ownedArrayBuffer(outputBytes);
    document.sourceBytes = sourceBytes;
    self.postMessage({
      requestId,
      ok: true,
      operation,
      document,
      applied: edited?.applied || [],
    }, [sourceBytes]);
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: {
        code: error?.code || "parse_failed",
        message: error instanceof Error ? error.message : "The document could not be parsed.",
      },
    });
  }
});
