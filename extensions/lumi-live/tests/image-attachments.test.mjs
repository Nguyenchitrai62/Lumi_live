import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  imageFilesFromClipboard,
  imageFilesFromDrop,
  isSupportedImageFile,
  queuedImageMessagePreview,
} from "../side-panel/image-attachments.js";

test("accepts common raster images and rejects unsupported clipboard files", () => {
  assert.equal(isSupportedImageFile({ type: "image/png", size: 120 }), true);
  assert.equal(isSupportedImageFile({ type: "image/webp", size: 120 }), true);
  assert.equal(isSupportedImageFile({ type: "image/svg+xml", size: 120 }), false);
  assert.equal(isSupportedImageFile({ type: "image/png", size: 0 }), false);
});

test("extracts only image files from clipboard and drag data", () => {
  const png = { type: "image/png", size: 120, name: "paste.png" };
  const text = { type: "text/plain", size: 20, name: "note.txt" };
  assert.deepEqual(imageFilesFromClipboard({
    items: [
      { kind: "string", type: "text/plain" },
      { kind: "file", type: "image/png", getAsFile: () => png },
    ],
  }), [png]);
  assert.deepEqual(imageFilesFromDrop({ files: [text, png] }), [png]);
});

test("queued image messages expose a useful compact preview", () => {
  assert.equal(
    queuedImageMessagePreview({
      text: "What is shown here?",
      attachment: { name: "screen.jpg" },
    }),
    "Image · What is shown here?",
  );
  assert.equal(
    queuedImageMessagePreview({ text: "", attachment: { name: "screen.jpg" } }),
    "Image · screen.jpg",
  );
});

test("composer wires image paste, drop, preview, and Gemini video input", async () => {
  const root = new URL("../", import.meta.url);
  const [html, controller] = await Promise.all([
    readFile(new URL("side-panel/index.html", root), "utf8"),
    readFile(new URL("side-panel/index.js", root), "utf8"),
  ]);
  assert.match(html, /id="imageAttachmentInput"/);
  assert.match(html, /id="imageAttachmentTray"/);
  assert.match(controller, /addEventListener\("paste"/);
  assert.match(controller, /addEventListener\("drop"/);
  assert.match(controller, /selectedAttachment\?\.frame/);
  assert.match(controller, /createMessage\("user", displayText, \{ attachment: selectedAttachment \}\)/);
});
