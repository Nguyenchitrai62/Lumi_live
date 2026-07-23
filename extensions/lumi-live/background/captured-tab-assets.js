import { STORAGE_KEYS } from "../core/extension-config.js";

const CAPTURED_ASSETS_STORAGE_KEY = STORAGE_KEYS.capturedTabAssets;
const MAX_CAPTURED_ASSETS = 3;
const MAX_CAPTURED_ASSET_CHARS = 6_000_000;
const CAPTURED_ASSET_MAX_AGE_MS = 60 * 60 * 1000;

function isStoredAsset(value) {
  return Boolean(
    value
    && typeof value.id === "string"
    && /^data:image\/(?:jpeg|png);base64,/i.test(value.dataUrl || "")
    && typeof value.filename === "string"
    && typeof value.createdAt === "number",
  );
}

function removeExpiredAssets(assets, now = Date.now()) {
  return assets.filter((asset) =>
    isStoredAsset(asset) && now - asset.createdAt <= CAPTURED_ASSET_MAX_AGE_MS);
}

async function loadCapturedAssets() {
  const stored = await chrome.storage.session.get(CAPTURED_ASSETS_STORAGE_KEY);
  const rawAssets = Array.isArray(stored[CAPTURED_ASSETS_STORAGE_KEY])
    ? stored[CAPTURED_ASSETS_STORAGE_KEY]
    : [];
  const assets = removeExpiredAssets(rawAssets);
  if (assets.length !== rawAssets.length) {
    await chrome.storage.session.set({ [CAPTURED_ASSETS_STORAGE_KEY]: assets });
  }
  return assets;
}

function estimateDataUrlBytes(dataUrl) {
  const encoded = String(dataUrl || "").split(",", 2)[1] || "";
  return Math.floor(encoded.length * 3 / 4);
}

export async function saveCapturedTabAsset({
  dataUrl,
  filename,
  contentType = "image/jpeg",
  source = {},
}) {
  if (!/^data:image\/(?:jpeg|png);base64,/i.test(dataUrl || "")) {
    throw new Error("Chrome returned an unsupported screenshot format.");
  }
  if (String(dataUrl).length > MAX_CAPTURED_ASSET_CHARS) {
    throw new Error("The captured screenshot is too large to keep as a Lumi attachment.");
  }

  const asset = {
    id: crypto.randomUUID(),
    dataUrl,
    filename: String(filename || "lumi-tab-capture.jpg").slice(0, 160),
    contentType,
    byteSize: estimateDataUrlBytes(dataUrl),
    createdAt: Date.now(),
    source: {
      tabId: Number.isInteger(source.tabId) ? source.tabId : null,
      title: String(source.title || "Active tab").slice(0, 300),
      url: String(source.url || "").slice(0, 3000),
    },
  };
  const assets = [asset, ...await loadCapturedAssets()]
    .slice(0, MAX_CAPTURED_ASSETS);
  while (
    assets.length > 1
    && assets.reduce((total, item) => total + item.dataUrl.length, 0) > MAX_CAPTURED_ASSET_CHARS
  ) {
    assets.pop();
  }
  await chrome.storage.session.set({ [CAPTURED_ASSETS_STORAGE_KEY]: assets });
  return structuredClone(asset);
}

export async function getCapturedTabAsset(attachmentId) {
  const id = String(attachmentId || "").trim();
  if (!id) return null;
  const assets = await loadCapturedAssets();
  const asset = assets.find((candidate) => candidate.id === id) || null;
  if (asset) return structuredClone(asset);
  return null;
}
