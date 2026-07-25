import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isAbsoluteLocalFilePath,
  isFileChooserDebuggerEvent,
  localFileName,
  MAX_BROWSER_UPLOAD_FILES,
  normalizeUploadFilePaths,
} from "../browser/file-upload.js";
import {
  chooseCompatibleFileInput,
  FILE_UPLOAD_TARGET_ATTRIBUTE,
} from "../browser/file-upload-target.js";
import {
  BROWSER_TOOLS,
  BROWSER_UI_ACTION_TOOLS,
  buildSessionInstruction,
} from "../live/session-config.js";

test("browser upload tool requires indexed, confirmed absolute local paths", () => {
  const tool = BROWSER_TOOLS.find(({ name }) => name === "browser_upload_file");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["index", "filePaths", "confirmed"]);
  assert.equal(tool.parameters.properties.filePaths.type, "ARRAY");
  assert.ok(BROWSER_UI_ACTION_TOOLS.has("browser_upload_file"));
  assert.match(tool.description, /fully handle a website's file input/i);
  assert.match(tool.description, /Never claim native file selection is impossible/i);
  assert.match(buildSessionInstruction(), /generic browser_upload_file implementation/i);
  assert.match(buildSessionInstruction(), /Never say upload is impossible/i);
});

test("normalizes Windows, UNC, and POSIX absolute upload paths", () => {
  assert.equal(isAbsoluteLocalFilePath("C:\\Users\\trait\\Downloads\\333.pdf"), true);
  assert.equal(isAbsoluteLocalFilePath("\\\\server\\share\\drawing.dwg"), true);
  assert.equal(isAbsoluteLocalFilePath("/tmp/file.pdf"), true);
  assert.equal(isAbsoluteLocalFilePath("Downloads\\333.pdf"), false);
  assert.equal(isAbsoluteLocalFilePath("file:///C:/Users/trait/333.pdf"), false);
  assert.deepEqual(
    normalizeUploadFilePaths([" C:\\Users\\trait\\Downloads\\333.pdf "]),
    ["C:\\Users\\trait\\Downloads\\333.pdf"],
  );
  assert.equal(localFileName("C:\\Users\\trait\\Downloads\\333.pdf"), "333.pdf");
});

test("rejects missing, relative, and excessive upload path lists", () => {
  assert.throws(() => normalizeUploadFilePaths([]), /At least one/);
  assert.throws(() => normalizeUploadFilePaths(["relative.pdf"]), /absolute local paths/);
  assert.throws(
    () => normalizeUploadFilePaths(Array.from(
      { length: MAX_BROWSER_UPLOAD_FILES + 1 },
      (_, index) => `C:\\tmp\\${index}.pdf`,
    )),
    /at most/,
  );
});

test("matches only file chooser events from the intended tab", () => {
  assert.equal(
    isFileChooserDebuggerEvent({ tabId: 42 }, "Page.fileChooserOpened", 42),
    true,
  );
  assert.equal(
    isFileChooserDebuggerEvent({ tabId: 9 }, "Page.fileChooserOpened", 42),
    false,
  );
  assert.equal(
    isFileChooserDebuggerEvent({ tabId: 42 }, "Page.loadEventFired", 42),
    false,
  );
});

function fakeFileInput({
  accept = "",
  disabled = false,
  multiple = false,
  visible = false,
  webkitdirectory = false,
} = {}) {
  const attributes = new Map([["type", "file"]]);
  if (accept) attributes.set("accept", accept);
  if (disabled) attributes.set("disabled", "");
  if (multiple) attributes.set("multiple", "");
  if (webkitdirectory) attributes.set("webkitdirectory", "");
  return {
    type: "file",
    disabled,
    multiple,
    webkitdirectory,
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    getClientRects() {
      return visible ? [{}] : [];
    },
    contains() {
      return false;
    },
    closest() {
      return null;
    },
  };
}

test("refuses to guess between multiple unrelated compatible file inputs", () => {
  const genericInput = fakeFileInput();
  const folderInput = fakeFileInput({ webkitdirectory: true });
  const pdfInput = fakeFileInput({ accept: ".pdf,image/png,application/msword" });
  const imageInput = fakeFileInput({ accept: "image/*", visible: true });
  const result = chooseCompatibleFileInput(
    [genericInput, folderInput, imageInput, pdfInput],
    ["333.pdf"],
  );
  assert.equal(result.input, null);
  assert.equal(result.strategy, "ambiguous_compatible_inputs");
  assert.equal(result.candidateCount, 2);
  assert.equal(FILE_UPLOAD_TARGET_ATTRIBUTE, "data-lumi-file-upload-target");
});

test("uses the only compatible file input when no indexed relationship is needed", () => {
  const pdfInput = fakeFileInput({ accept: ".pdf" });
  const result = chooseCompatibleFileInput([pdfInput], ["333.pdf"]);
  assert.equal(result.input, pdfInput);
  assert.equal(result.strategy, "matching_accept_attribute");
});

test("prefers an indexed file input when generic inputs share the page", () => {
  const firstInput = fakeFileInput();
  const indexedInput = fakeFileInput();
  const result = chooseCompatibleFileInput(
    [firstInput, indexedInput],
    ["333.pdf"],
    indexedInput,
  );
  assert.equal(result.input, indexedInput);
  assert.equal(result.strategy, "indexed_file_control");
});

test("prefers a compatible file input sharing the upload trigger container", () => {
  const unrelatedWrapper = { tagName: "DIV", parentElement: null };
  const relatedWrapper = { tagName: "SECTION", parentElement: null };
  const unrelatedInput = fakeFileInput({ accept: ".pdf" });
  const relatedInput = fakeFileInput({ accept: ".pdf" });
  unrelatedInput.parentElement = unrelatedWrapper;
  relatedInput.parentElement = relatedWrapper;
  const uploadButton = {
    parentElement: relatedWrapper,
    contains() {
      return false;
    },
    closest() {
      return null;
    },
    getAttribute() {
      return null;
    },
  };
  const result = chooseCompatibleFileInput(
    [unrelatedInput, relatedInput],
    ["quarterly-report.pdf"],
    uploadButton,
  );
  assert.equal(result.input, relatedInput);
  assert.equal(result.strategy, "upload_control_container");
});

test("background upload route directly fills compatible inputs and keeps chooser fallback", async () => {
  const worker = await readFile(new URL("../background/index.js", import.meta.url), "utf8");
  assert.match(worker, /chrome\.debugger\.attach\(rootDebuggee,\s*"1\.3"\)/);
  assert.match(worker, /"bridge_prepare_file_upload_target"/);
  assert.match(worker, /"DOM\.performSearch"/);
  assert.match(worker, /"Page\.setInterceptFileChooserDialog"/);
  assert.match(worker, /"bridge_click_file_upload_target"/);
  assert.match(worker, /"DOM\.setFileInputFiles"/);
  assert.match(worker, /fileSelectionComplete:\s*true/);
  assert.match(worker, /uploadCompletionVerified:\s*false/);
  assert.doesNotMatch(worker, /uploaded:\s*true/);
  assert.match(worker, /nextPageStateQuery:\s*fileNames\[0\]/);
  assert.match(worker, /cancelHandlers:\s*new Set\(\)/);
  assert.match(worker, /chooserWaiter\?\.cancel\(reason\)/);
  assert.match(worker, /chrome\.debugger\.detach\(rootDebuggee\)/);
  assert.match(worker, /tool === "browser_upload_file"/);
});
