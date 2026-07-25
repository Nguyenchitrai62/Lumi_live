export const MAX_BROWSER_UPLOAD_FILES = 20;

export function isAbsoluteLocalFilePath(value) {
  const path = String(value || "").trim();
  if (!path || path.includes("\0")) return false;
  return (
    /^[a-zA-Z]:[\\/]/.test(path)
    || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path)
    || /^\/(?!\/)/.test(path)
  );
}

export function normalizeUploadFilePaths(value) {
  const requestedPaths = Array.isArray(value) ? value : [value];
  const filePaths = requestedPaths
    .map((path) => String(path || "").trim())
    .filter(Boolean);

  if (!filePaths.length) {
    throw new Error("At least one absolute local file path is required.");
  }
  if (filePaths.length > MAX_BROWSER_UPLOAD_FILES) {
    throw new Error(`Lumi can upload at most ${MAX_BROWSER_UPLOAD_FILES} files at once.`);
  }
  for (const filePath of filePaths) {
    if (!isAbsoluteLocalFilePath(filePath)) {
      throw new Error(`Upload paths must be absolute local paths: ${filePath}`);
    }
  }
  return filePaths;
}

export function localFileName(filePath) {
  const parts = String(filePath || "").split(/[\\/]/);
  return parts.at(-1) || "file";
}

export function isFileChooserDebuggerEvent(source, method, tabId) {
  return source?.tabId === tabId && method === "Page.fileChooserOpened";
}
