export async function collectVideoAnalysisSourceInPage() {
  const cleanText = (value) => String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  const absoluteUrl = (value) => {
    const source = String(value || "").trim();
    if (!source) return "";
    try {
      const parsed = new URL(source, location.href);
      return ["http:", "https:", "blob:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  };
  const facebookVideoIdFromUrl = (value) => {
    try {
      const parsed = new URL(String(value || ""), location.href);
      if (!/(^|\.)facebook\.com$/i.test(parsed.hostname)) return "";
      return parsed.pathname.match(/\/(?:reel|reels|videos?)\/(\d+)/i)?.[1]
        || parsed.searchParams.get("v")
        || "";
    } catch {
      return "";
    }
  };
  const facebookVideoId = facebookVideoIdFromUrl(location.href);
  const elementFacebookVideoId = (mediaElement) => {
    if (!mediaElement || !facebookVideoId) return "";
    let node = mediaElement;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      for (const attribute of Array.from(node.attributes || [])) {
        const name = String(attribute?.name || "");
        const value = String(attribute?.value || "");
        if (/^(?:data-)?(?:video|reel)(?:[-_]?id)?$/i.test(name) && value === facebookVideoId) {
          return facebookVideoId;
        }
        const linkedId = facebookVideoIdFromUrl(value);
        if (linkedId) return linkedId;
      }
      const links = Array.from(node.querySelectorAll?.('a[href*="/reel/"],a[href*="/reels/"],a[href*="/videos/"]') || [])
        .map((link) => facebookVideoIdFromUrl(link.href || link.getAttribute?.("href")))
        .filter(Boolean);
      const distinctIds = [...new Set(links)];
      if (distinctIds.length === 1) return distinctIds[0];
    }
    return "";
  };
  const mediaElements = [...document.querySelectorAll("video, audio")];
  const scoreElement = (element) => {
    const rect = element.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const playable = element.readyState >= HTMLMediaElement.HAVE_METADATA ? 1_000_000 : 0;
    const active = !element.paused && !element.ended ? 2_000_000 : 0;
    const associatedId = elementFacebookVideoId(element);
    const identityScore = !facebookVideoId
      ? 0
      : associatedId === facebookVideoId
        ? 20_000_000
        : associatedId
          ? -20_000_000
          : 0;
    return identityScore + active + playable + area;
  };
  const element = mediaElements.sort((left, right) => scoreElement(right) - scoreElement(left))[0] || null;
  const selectedElementFacebookVideoId = elementFacebookVideoId(element);
  const htmlTracks = [];
  if (element) {
    const restoredTrackModes = [];
    for (const track of Array.from(element.textTracks || [])) {
      if (track.mode !== "disabled") continue;
      restoredTrackModes.push([track, track.mode]);
      try { track.mode = "hidden"; } catch { /* Some players own the track mode. */ }
    }
    if (restoredTrackModes.length) {
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    for (const track of Array.from(element.textTracks || [])) {
      const cues = Array.from(track.cues || []).map((cue) => ({
        start: Number(cue.startTime) || 0,
        end: Number(cue.endTime) || Number(cue.startTime) || 0,
        text: cleanText(cue.text),
      })).filter((cue) => cue.text);
      if (!cues.length) continue;
      htmlTracks.push({
        source: "html_text_track",
        ...(facebookVideoId && selectedElementFacebookVideoId === facebookVideoId
          ? { facebookVideoId, identityVerified: true }
          : {}),
        language: String(track.language || ""),
        label: String(track.label || track.language || "Captions"),
        kind: String(track.kind || "subtitles"),
        cues,
      });
    }
    for (const trackElement of element.querySelectorAll("track")) {
      const baseUrl = absoluteUrl(trackElement.src || trackElement.getAttribute("src"));
      if (!baseUrl || htmlTracks.some((track) => track.baseUrl === baseUrl)) continue;
      htmlTracks.push({
        source: "html_track_url",
        baseUrl,
        ...(facebookVideoId && selectedElementFacebookVideoId === facebookVideoId
          ? { facebookVideoId, identityVerified: true }
          : {}),
        language: String(trackElement.srclang || ""),
        label: cleanText(trackElement.label || trackElement.srclang || "Captions"),
        kind: String(trackElement.kind || "subtitles"),
        cues: [],
      });
    }
    for (const [track, mode] of restoredTrackModes) {
      try { track.mode = mode; } catch { /* Restore is best-effort. */ }
    }
  }

  const youtubeTracks = [];
  const playerResponses = [];
  if (globalThis.ytInitialPlayerResponse) playerResponses.push(globalThis.ytInitialPlayerResponse);
  const configuredPlayerResponse = globalThis.ytplayer?.config?.args?.player_response;
  if (configuredPlayerResponse) {
    try {
      playerResponses.push(typeof configuredPlayerResponse === "string"
        ? JSON.parse(configuredPlayerResponse)
        : configuredPlayerResponse);
    } catch {
      // YouTube can omit or replace this legacy player response.
    }
  }
  for (const response of playerResponses) {
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    for (const track of tracks) {
      const baseUrl = absoluteUrl(track?.baseUrl);
      if (!baseUrl || youtubeTracks.some((candidate) => candidate.baseUrl === baseUrl)) continue;
      youtubeTracks.push({
        source: "youtube_caption_track",
        baseUrl,
        language: String(track.languageCode || ""),
        label: cleanText(track.name?.simpleText
          || track.name?.runs?.map((run) => run.text).join("")
          || track.languageCode
          || "YouTube captions"),
        kind: String(track.kind || "subtitles"),
        autoGenerated: track.kind === "asr",
      });
    }
  }

  const candidates = [];
  const addCandidate = (value, origin, mimeType = "", metadata = {}) => {
    const url = absoluteUrl(value);
    if (!url || candidates.some((candidate) => candidate.url === url)) return;
    candidates.push({ url, origin, mimeType: String(mimeType || ""), ...metadata });
  };

  if (facebookVideoId && /(^|\.)facebook\.com$/i.test(location.hostname)) {
    const readXmlAttribute = (attributes, name) => {
      const match = String(attributes || "").match(new RegExp(`(?:^|\\s)${name}=["']([^"']+)["']`, "i"));
      return cleanText(match?.[1] || "");
    };
    const decodeXmlUrl = (value) => String(value || "")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
    const scripts = [...document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]')];
    for (const script of scripts) {
      const text = String(script.textContent || "");
      if (!text.includes(facebookVideoId) || !text.includes("dash_manifests")) continue;
      let root;
      try { root = JSON.parse(text); } catch { continue; }
      const stack = [root];
      let visited = 0;
      while (stack.length && visited < 200_000) {
        const value = stack.pop();
        visited += 1;
        if (!value || typeof value !== "object") continue;
        if (String(value.id || "") === facebookVideoId && value.videoDeliveryResponseFragment) {
          const captionsUrl = absoluteUrl(value.captions_url);
          if (captionsUrl && !htmlTracks.some((track) => track.baseUrl === captionsUrl)) {
            htmlTracks.push({
              source: "facebook_caption_url",
              baseUrl: captionsUrl,
              facebookVideoId,
              identityVerified: true,
              language: String(value.video_available_captions_locales?.[0] || ""),
              label: "Facebook captions",
              kind: "subtitles",
              cues: [],
            });
          }
          const manifests = value.videoDeliveryResponseFragment
            ?.videoDeliveryResponseResult
            ?.dash_manifests;
          for (const manifest of Array.isArray(manifests) ? manifests : []) {
            const xml = String(manifest?.manifest_xml || "");
            const representationPattern = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
            for (const match of xml.matchAll(representationPattern)) {
              const baseUrl = decodeXmlUrl(match[2].match(/<BaseURL>([\s\S]*?)<\/BaseURL>/i)?.[1]);
              const mimeType = readXmlAttribute(match[1], "mimeType");
              addCandidate(baseUrl, "facebook_dash_manifest", mimeType, {
                facebookVideoId,
                identityVerified: true,
              });
              const candidate = candidates.at(-1);
              if (candidate?.url === absoluteUrl(baseUrl)) {
                candidate.bandwidth = Number(readXmlAttribute(match[1], "bandwidth")) || 0;
                candidate.codecs = readXmlAttribute(match[1], "codecs");
                candidate.representationId = readXmlAttribute(match[1], "id");
              }
            }
          }
          stack.length = 0;
          break;
        }
        if (Array.isArray(value)) {
          for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
        } else {
          for (const child of Object.values(value)) {
            if (child && typeof child === "object") stack.push(child);
          }
        }
      }
      if (candidates.some((candidate) => candidate.origin === "facebook_dash_manifest")) break;
    }
  }
  if (element) {
    const canTrustSelectedElement = !facebookVideoId || selectedElementFacebookVideoId === facebookVideoId;
    if (canTrustSelectedElement) {
      const identityMetadata = facebookVideoId
        ? { facebookVideoId, identityVerified: true }
        : {};
      addCandidate(element.currentSrc, "current_src", element.getAttribute("type"), identityMetadata);
      addCandidate(element.src, "element_src", element.getAttribute("type"), identityMetadata);
      for (const source of element.querySelectorAll("source")) {
        addCandidate(source.src, "source_element", source.type, identityMetadata);
      }
    }
  }
  for (const selector of [
    'meta[property="og:video"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video:secure_url"]',
    'meta[name="twitter:player:stream"]',
  ]) {
    const meta = document.querySelector(selector);
    if (!facebookVideoId) {
      addCandidate(meta?.content, "page_metadata", meta?.getAttribute("data-type"));
    }
  }
  const captionResourcePattern = /(?:caption|subtitle|\.vtt|\.srt|\.ttml|\.dfxp)(?:[/?#]|$)/i;
  const mediaResourcePattern = /(?:\.m4a|\.mp3|\.aac|\.mp4|\.m4s|\.webm|\.m3u8|\.mpd|\.ts)(?:[?#]|$)|googlevideo\.com|(?:[?&](?:mime|type|mime_type)=(?:audio|video)(?:%2f|\/|_))|(?:fbcdn\.net\/(?:o1\/v\/|[^?#]*\/v\/t42\.1790-2\/))/i;
  const resourceEntries = [...(performance.getEntriesByType?.("resource") || [])];
  for (const entry of resourceEntries.slice(-240)) {
    const url = String(entry.name || "");
    if (captionResourcePattern.test(url)) {
      const baseUrl = absoluteUrl(url);
      if (baseUrl && !htmlTracks.some((track) => track.baseUrl === baseUrl)) {
        htmlTracks.push({
          source: "performance_caption_resource",
          baseUrl,
          language: "",
          label: "Detected captions",
          kind: "subtitles",
          cues: [],
        });
      }
    }
    if (!facebookVideoId && (mediaResourcePattern.test(url) || ["audio", "video"].includes(entry.initiatorType))) {
      addCandidate(url, "performance_resource");
      const candidate = candidates.at(-1);
      if (candidate?.url === absoluteUrl(url)) {
        candidate.initiatorType = String(entry.initiatorType || "");
        candidate.transferSize = Number(entry.transferSize) || 0;
        candidate.startTime = Number(entry.startTime) || 0;
      }
    }
  }

  return {
    found: Boolean(element || youtubeTracks.length || candidates.length || facebookVideoId),
    pageTitle: document.title,
    pageUrl: location.href,
    frameUrl: location.href,
    media: element ? {
      kind: element.tagName.toLowerCase(),
      duration: Number.isFinite(element.duration) ? element.duration : null,
      currentTime: Number(element.currentTime) || 0,
      paused: Boolean(element.paused),
      visibleArea: (() => {
        const rect = element.getBoundingClientRect();
        return Math.max(0, rect.width) * Math.max(0, rect.height);
      })(),
      poster: absoluteUrl(element.poster),
      facebookVideoId: selectedElementFacebookVideoId,
    } : null,
    facebookVideoId,
    facebookMediaIdentityVerified: Boolean(
      facebookVideoId
      && (selectedElementFacebookVideoId === facebookVideoId
        || candidates.some((candidate) => candidate.facebookVideoId === facebookVideoId && candidate.identityVerified)
        || htmlTracks.some((track) => track.facebookVideoId === facebookVideoId && track.identityVerified)),
    ),
    captionTracks: [...htmlTracks, ...youtubeTracks],
    mediaCandidates: candidates.slice(-64),
  };
}
