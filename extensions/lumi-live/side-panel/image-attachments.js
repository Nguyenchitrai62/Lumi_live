export const MAX_IMAGE_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_DIMENSION = 1600;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function isSupportedImageFile(file) {
  return Boolean(file)
    && SUPPORTED_IMAGE_TYPES.has(String(file.type || "").toLowerCase())
    && Number(file.size) > 0;
}

export function imageFilesFromClipboard(clipboardData) {
  return Array.from(clipboardData?.items || [])
    .filter((item) =>
      item?.kind === "file"
      && SUPPORTED_IMAGE_TYPES.has(String(item.type || "").toLowerCase()))
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
}

export function imageFilesFromDrop(dataTransfer) {
  return Array.from(dataTransfer?.files || []).filter(isSupportedImageFile);
}

export function queuedImageMessagePreview(message) {
  const text = String(message?.text || "").replace(/\s+/g, " ").trim();
  if (text) return message?.attachment ? `Image · ${text}` : text;
  return message?.attachment
    ? `Image · ${message.attachment.name || "Attached image"}`
    : "";
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Chrome could not encode this image."));
      },
      "image/jpeg",
      quality,
    );
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Chrome could not read this image."));
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      return await createImageBitmap(file);
    } catch {
      throw new Error("This image could not be decoded.");
    }
  }
}

export async function prepareImageAttachment(file) {
  if (!isSupportedImageFile(file)) {
    throw new Error("Use a JPEG, PNG, WebP, or GIF image.");
  }
  if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error("Images must be 12 MB or smaller.");
  }

  const bitmap = await decodeImage(file);
  try {
    const scale = Math.min(
      1,
      MAX_IMAGE_ATTACHMENT_DIMENSION / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Chrome could not prepare an image canvas.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    let output = await canvasToBlob(canvas, 0.84);
    if (output.size > 3 * 1024 * 1024) {
      output = await canvasToBlob(canvas, 0.7);
    }
    const previewDataUrl = await blobToDataUrl(output);
    const separatorIndex = previewDataUrl.indexOf(",");
    if (!previewDataUrl.startsWith("data:image/jpeg;base64,") || separatorIndex < 0) {
      throw new Error("Chrome returned an unsupported image encoding.");
    }
    const data = previewDataUrl.slice(separatorIndex + 1);
    if (!data) throw new Error("Chrome returned an empty image.");
    const originalName = String(file.name || "clipboard-image").trim() || "clipboard-image";
    const name = `${originalName.replace(/\.[^.]+$/, "").slice(0, 100) || "image"}.jpg`;
    return {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      name,
      byteSize: output.size,
      width,
      height,
      previewDataUrl,
      frame: {
        data,
        mimeType: "image/jpeg",
      },
    };
  } finally {
    bitmap.close();
  }
}
