import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAttachmentFile,
  validateAttachmentSelection,
} from "../side-panel/attachments.js";

function file(name, type, size = 100) {
  return { name, type, size };
}

test("attachment classification tolerates missing or misleading Windows MIME values", () => {
  assert.deepEqual(classifyAttachmentFile(file("data.xlsx", "")), {
    category: "document",
    kind: "xlsx",
  });
  assert.deepEqual(classifyAttachmentFile(file("data.csv", "application/vnd.ms-excel")), {
    category: "document",
    kind: "csv",
  });
  assert.equal(classifyAttachmentFile(file("notes.docx", "application/octet-stream")), null);
  assert.equal(classifyAttachmentFile(file("legacy.xls", "application/vnd.ms-excel")), null);
});

test("attachment selection allows five total and at most one image", () => {
  const selection = validateAttachmentSelection([], [
    file("a.xlsx", ""),
    file("b.csv", "text/csv"),
    file("c.xlsx", ""),
    file("photo.png", "image/png"),
    file("d.xlsx", ""),
    file("extra.csv", ""),
  ]);
  assert.equal(selection.accepted.length, 5);
  assert.match(selection.errors[0], /at most 5/);
  const images = validateAttachmentSelection([], [
    file("one.png", "image/png"),
    file("two.jpg", "image/jpeg"),
  ]);
  assert.equal(images.accepted.length, 1);
  assert.match(images.errors[0], /at most one image/);
});

test("attachment selection enforces per-file and batch limits", () => {
  const tooLarge = validateAttachmentSelection([], [
    file("large.xlsx", "", 25 * 1024 * 1024 + 1),
  ]);
  assert.equal(tooLarge.accepted.length, 0);
  assert.match(tooLarge.errors[0], /25 MB/);
  const batch = validateAttachmentSelection([], [
    file("a.xlsx", "", 20 * 1024 * 1024),
    file("b.xlsx", "", 20 * 1024 * 1024),
    file("c.xlsx", "", 20 * 1024 * 1024),
  ]);
  assert.equal(batch.accepted.length, 2);
  assert.match(batch.errors[0], /50 MB/);
});
