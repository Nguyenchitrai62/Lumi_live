function parseUrl(rawUrl, baseUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return null;
  try {
    return new URL(value, String(baseUrl || "https://youtube.com/"));
  } catch {
    return null;
  }
}

export function isYouTubeUrl(rawUrl, baseUrl) {
  const url = parseUrl(rawUrl, baseUrl);
  if (!url) return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === "youtu.be"
    || hostname === "youtube.com"
    || hostname.endsWith(".youtube.com");
}

export function isYouTubeVideoUrl(rawUrl, baseUrl) {
  const url = parseUrl(rawUrl, baseUrl);
  if (!url || !isYouTubeUrl(url.href)) return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "youtu.be") return url.pathname.split("/").filter(Boolean).length > 0;
  return url.pathname === "/watch"
    ? Boolean(url.searchParams.get("v"))
    : /^\/(?:shorts|live)\/[^/]+/i.test(url.pathname);
}

function linkedUrl(element) {
  const link = element?.closest?.("a[href]")
    || (element?.matches?.("a[href]") ? element : null);
  const href = link?.href || link?.getAttribute?.("href");
  return href ? parseUrl(href, element?.ownerDocument?.location?.href)?.href || "" : "";
}

function nearbyVideo(element) {
  let candidate = element;
  for (let depth = 0; candidate && depth < 8; depth += 1) {
    if (candidate.matches?.("video")) return candidate;
    const video = candidate.querySelector?.("video");
    if (video) return video;
    candidate = candidate.parentElement;
  }
  return null;
}

export function captureYouTubeVideoClick(element) {
  const documentUrl = element?.ownerDocument?.location?.href || "";
  const targetUrl = linkedUrl(element);
  const opensVideoLink = isYouTubeVideoUrl(targetUrl, documentUrl);
  let video = null;
  if (isYouTubeUrl(documentUrl)) {
    video = nearbyVideo(element);
    if (!video && isYouTubeVideoUrl(documentUrl)) {
      video = element.ownerDocument.querySelector?.("video") || null;
    }
  }
  return {
    opensVideoLink,
    video,
    videoWasPaused: Boolean(video?.paused),
  };
}

export function didClickOpenYouTubeVideo(capture) {
  if (capture?.opensVideoLink) return true;
  return Boolean(capture?.video && capture.videoWasPaused && !capture.video.paused);
}
