export async function collectVideoAnalysisSourceInPage(expectedFacebookVideoId = "") {
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
  const pageFacebookVideoId = facebookVideoIdFromUrl(location.href);
  const requestedFacebookVideoId = /^\d{5,}$/.test(String(expectedFacebookVideoId || ""))
    ? String(expectedFacebookVideoId)
    : "";
  const youtubeVideoIdFromUrl = (value) => {
    try {
      const parsed = new URL(String(value || ""), location.href);
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (hostname === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0] || "";
      if (hostname !== "youtube.com" && !hostname.endsWith(".youtube.com")) return "";
      return parsed.searchParams.get("v")
        || parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/i)?.[1]
        || "";
    } catch {
      return "";
    }
  };
  const youtubeVideoId = youtubeVideoIdFromUrl(location.href);
  const elementFacebookVideoId = (mediaElement) => {
    if (!mediaElement) return "";
    let node = mediaElement;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      for (const attribute of Array.from(node.attributes || [])) {
        const name = String(attribute?.name || "");
        const value = String(attribute?.value || "");
        if (
          /^(?:data-)?(?:video|reel)(?:[-_]?id)?$/i.test(name)
          && /^\d{5,}$/.test(value)
        ) {
          return value;
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
    const viewportWidth = Number(globalThis.innerWidth) || Number(document.documentElement?.clientWidth) || rect.width || 0;
    const viewportHeight = Number(globalThis.innerHeight) || Number(document.documentElement?.clientHeight) || rect.height || 0;
    const hasPosition = [rect.top, rect.right, rect.bottom, rect.left].every(Number.isFinite);
    const visibleWidth = hasPosition
      ? Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0))
      : Math.max(0, rect.width);
    const visibleHeight = hasPosition
      ? Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0))
      : Math.max(0, rect.height);
    const visibleArea = visibleWidth * visibleHeight;
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const playable = element.readyState >= HTMLMediaElement.HAVE_METADATA ? 1_000_000 : 0;
    const active = !element.paused && !element.ended ? 2_000_000 : 0;
    // Facebook keeps previous and next Reels mounted while the address bar can
    // still contain the previous ID. Select the player from live playback and
    // viewport evidence first; identity is validated after selection.
    return active + playable + (visibleArea > 0 ? 4_000_000 : 0) + visibleArea + Math.min(area, 1_000_000);
  };
  const element = mediaElements.sort((left, right) => scoreElement(right) - scoreElement(left))[0] || null;
  const selectedElementFacebookVideoId = elementFacebookVideoId(element);
  // A supplied tool URL is authoritative. Without one, the live player owns
  // the identity and the SPA address bar is only a fallback.
  const facebookVideoId = requestedFacebookVideoId
    || selectedElementFacebookVideoId
    || pageFacebookVideoId;
  let activePlayerToken = "";
  if (element) {
    const tokenProperty = "__lumiVideoAnalysisPlayerToken";
    activePlayerToken = String(element[tokenProperty] || "");
    if (!activePlayerToken) {
      activePlayerToken = globalThis.crypto?.randomUUID?.()
        || `lumi-player-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        Object.defineProperty(element, tokenProperty, {
          value: activePlayerToken,
          configurable: true,
        });
      } catch {
        try { element[tokenProperty] = activePlayerToken; } catch { activePlayerToken = ""; }
      }
    }
  }
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
  const youtubeMediaFormats = [];
  const playerResponses = [];
  const addPlayerResponse = (value) => {
    let response = value;
    if (typeof response === "string") {
      try { response = JSON.parse(response); } catch { return; }
    }
    if (!response || typeof response !== "object" || playerResponses.includes(response)) return;
    playerResponses.push(response);
  };
  addPlayerResponse(globalThis.ytInitialPlayerResponse);
  const configuredPlayerResponse = globalThis.ytplayer?.config?.args?.player_response;
  addPlayerResponse(configuredPlayerResponse);
  addPlayerResponse(globalThis.ytplayer?.config?.args?.raw_player_response);
  // The watch page is a long-lived SPA. Its global initial response is often
  // stale, while the live player and ytd-watch-flexy still expose the current
  // response (including caption tracks) synchronously.
  try { addPlayerResponse(document.getElementById?.("movie_player")?.getPlayerResponse?.()); } catch { /* Player API is optional. */ }
  const watchFlexy = document.querySelector?.("ytd-watch-flexy");
  addPlayerResponse(watchFlexy?.playerData);
  addPlayerResponse(watchFlexy?.data?.playerResponse);
  let youtubeDurationSeconds = 0;
  for (const response of playerResponses) {
    const responseVideoId = String(response?.videoDetails?.videoId || "");
    // YouTube is a single-page app and can leave ytInitialPlayerResponse from
    // the previously watched video in the page. Never bind those captions or
    // that duration to the new watch URL.
    if (youtubeVideoId && responseVideoId && responseVideoId !== youtubeVideoId) continue;
    const responseDuration = Number(response?.videoDetails?.lengthSeconds);
    if (!youtubeDurationSeconds && Number.isFinite(responseDuration) && responseDuration > 0) {
      youtubeDurationSeconds = responseDuration;
    }
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
    const formats = [
      ...(response?.streamingData?.adaptiveFormats || []),
      ...(response?.streamingData?.formats || []),
    ];
    for (const format of formats) {
      const mediaUrl = absoluteUrl(format?.url);
      const mimeType = String(format?.mimeType || "");
      if (!mediaUrl || !mimeType.startsWith("audio/")) continue;
      if (youtubeMediaFormats.some((candidate) => candidate.url === mediaUrl)) continue;
      youtubeMediaFormats.push({
        url: mediaUrl,
        mimeType,
        bitrate: Number(format?.bitrate) || 0,
        contentLength: Number(format?.contentLength) || 0,
        itag: Number(format?.itag) || 0,
        youtubeVideoId: responseVideoId || youtubeVideoId,
        identityVerified: Boolean((responseVideoId || youtubeVideoId) && (!youtubeVideoId || responseVideoId === youtubeVideoId)),
      });
    }
  }

  const candidates = [];
  const addCandidate = (value, origin, mimeType = "", metadata = {}) => {
    const url = absoluteUrl(value);
    if (!url || candidates.some((candidate) => candidate.url === url)) return;
    candidates.push({ url, origin, mimeType: String(mimeType || ""), ...metadata });
  };

  for (const format of youtubeMediaFormats) {
    addCandidate(format.url, "youtube_player_response", format.mimeType, format);
  }

  if (/(^|\.)udemy\.com$/i.test(location.hostname)) {
    const embeddedPayloads = [
      ...document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]'),
    ].map((node) => String(node.textContent || "").trim()).filter(Boolean);
    for (const node of document.querySelectorAll("[data-module-args]")) {
      const value = String(node.getAttribute("data-module-args") || "").trim();
      if (value) embeddedPayloads.push(value);
    }
    for (const payload of embeddedPayloads.slice(-80)) {
      let root;
      try { root = JSON.parse(payload); } catch { continue; }
      const stack = [{ value: root, hint: "" }];
      let visited = 0;
      while (stack.length && visited < 100_000) {
        const entry = stack.pop();
        const value = entry?.value;
        visited += 1;
        if (!value || typeof value !== "object") continue;
        if (Array.isArray(value)) {
          for (let index = value.length - 1; index >= 0; index -= 1) {
            stack.push({ value: value[index], hint: entry.hint });
          }
          continue;
        }
        const language = cleanText(
          value.srclang || value.language || value.locale || value.lang || "",
        );
        const label = cleanText(value.label || value.name || language || "Udemy captions");
        const declaredType = String(value.type || value.mimeType || value.mime_type || "");
        for (const [key, child] of Object.entries(value)) {
          const context = `${entry.hint} ${key} ${value.kind || ""} ${declaredType}`.toLowerCase();
          if (typeof child === "string") {
            const looksLikeResource = /^(?:https?:)?\/\/|^\//i.test(child.trim());
            if (!looksLikeResource) continue;
            const url = absoluteUrl(child);
            if (!url) continue;
            const captionLike = /caption|subtitle|transcript|text\/vtt|application\/(?:x-subrip|ttml\+xml)/i.test(context)
              || /\.(?:vtt|srt|ttml|dfxp)(?:[?#]|$)/i.test(url);
            if (captionLike) {
              if (!htmlTracks.some((track) => track.baseUrl === url)) {
                htmlTracks.push({
                  source: "udemy_embedded_caption",
                  baseUrl: url,
                  language,
                  label,
                  kind: "subtitles",
                  cues: [],
                });
              }
              continue;
            }
            const mediaLike = /media.?sources?|stream|playback|audio|video/i.test(context)
              && (/^(?:audio|video)\//i.test(declaredType)
                || /mpegurl|dash\+xml/i.test(declaredType)
                || /\.(?:m4a|mp3|aac|mp4|webm|m3u8|mpd)(?:[?#]|$)/i.test(url));
            if (mediaLike) addCandidate(url, "udemy_embedded_media", declaredType);
            continue;
          }
          if (child && typeof child === "object") {
            stack.push({ value: child, hint: `${entry.hint} ${key}`.trim() });
          }
        }
      }
    }
  }

  let facebookPermalinkProbeUsed = false;
  let facebookPermalinkProbeUrl = "";
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
    const addFacebookCaption = (value, language = "", identityEvidence = "facebook_embedded_payload") => {
      const source = String(value || "").trim();
      if (!/^(?:https?:)?\/\/|^\//i.test(source)) return;
      const captionsUrl = absoluteUrl(source);
      if (!captionsUrl || htmlTracks.some((track) => track.baseUrl === captionsUrl)) return;
      htmlTracks.push({
        source: identityEvidence === "facebook_permalink_payload"
          ? "facebook_permalink_caption_url"
          : "facebook_caption_url",
        baseUrl: captionsUrl,
        facebookVideoId,
        identityVerified: true,
        identityEvidence,
        language: String(language || ""),
        label: "Facebook captions",
        kind: "subtitles",
        cues: [],
      });
    };
    const addFacebookManifest = (xml, identityEvidence = "facebook_embedded_payload") => {
      const source = String(xml || "");
      if (!source.includes("<Representation")) return;
      const representationPattern = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
      const seenRepresentationUrls = new Set();
      const addRepresentation = (attributes, body, inheritedAttributes = "") => {
        const baseUrl = decodeXmlUrl(body.match(/<BaseURL>([\s\S]*?)<\/BaseURL>/i)?.[1])
          .replace(/^<!\[CDATA\[/i, "")
          .replace(/\]\]>$/i, "")
          .trim();
        const absoluteBaseUrl = absoluteUrl(baseUrl);
        if (!absoluteBaseUrl || seenRepresentationUrls.has(absoluteBaseUrl)) return;
        seenRepresentationUrls.add(absoluteBaseUrl);
        const codecs = readXmlAttribute(attributes, "codecs")
          || readXmlAttribute(inheritedAttributes, "codecs");
        const contentType = readXmlAttribute(attributes, "contentType")
          || readXmlAttribute(inheritedAttributes, "contentType");
        let mimeType = readXmlAttribute(attributes, "mimeType")
          || readXmlAttribute(inheritedAttributes, "mimeType");
        if (!/^(?:audio|video)\//i.test(mimeType)) {
          if (/^audio$/i.test(contentType) || /(?:mp4a|aac|opus|vorbis)/i.test(codecs)) {
            mimeType = /webm|opus|vorbis/i.test(`${mimeType} ${codecs}`) ? "audio/webm" : "audio/mp4";
          } else if (/^video$/i.test(contentType)) {
            mimeType = /webm/i.test(mimeType) ? "video/webm" : "video/mp4";
          }
        }
        addCandidate(
          absoluteBaseUrl,
          identityEvidence === "facebook_permalink_payload"
            ? "facebook_permalink_dash_manifest"
            : "facebook_dash_manifest",
          mimeType,
          {
            facebookVideoId,
            identityVerified: true,
            identityEvidence,
          },
        );
        const candidate = candidates.at(-1);
        if (candidate?.url === absoluteBaseUrl) {
          candidate.bandwidth = Number(readXmlAttribute(attributes, "bandwidth")) || 0;
          candidate.codecs = codecs;
          candidate.representationId = readXmlAttribute(attributes, "id");
          candidate.audioOnly = mimeType.startsWith("audio/");
        }
      };
      const adaptationPattern = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
      for (const adaptation of source.matchAll(adaptationPattern)) {
        for (const representation of adaptation[2].matchAll(representationPattern)) {
          addRepresentation(representation[1], representation[2], adaptation[1]);
        }
      }
      for (const representation of source.matchAll(representationPattern)) {
        addRepresentation(representation[1], representation[2]);
      }
    };
    const scanFacebookPayloadText = (textValue, identityEvidence = "facebook_embedded_payload") => {
      const text = String(textValue || "");
      if (
        !text.includes(facebookVideoId)
        || !/(?:dash.?manifest|caption|subtitle|audio_url|playable_url|browser_native)/i.test(text)
      ) return false;
      let root;
      try { root = JSON.parse(text); } catch { return false; }
      // Facebook publishes an exact video_id -> representations table for DASH
      // prefetch. This is both faster and safer than walking the surrounding
      // feed payload, which also contains the next Reel.
      let prefetchMatched = false;
      const prefetchStack = [root];
      let prefetchVisited = 0;
      while (prefetchStack.length && prefetchVisited < 200_000) {
        const value = prefetchStack.pop();
        prefetchVisited += 1;
        if (!value || typeof value !== "object") continue;
        if (
          String(value.video_id || "") === facebookVideoId
          && Array.isArray(value.representations)
        ) {
          for (const representation of value.representations) {
            const codecs = String(representation?.codecs || "");
            let mimeType = String(representation?.mime_type || representation?.mimeType || "");
            if (!mimeType && /(?:mp4a|aac|opus|vorbis)/i.test(codecs)) {
              mimeType = /(?:opus|vorbis)/i.test(codecs) ? "audio/webm" : "audio/mp4";
            }
            if (!mimeType.startsWith("audio/")) continue;
            const candidateCountBefore = candidates.length;
            addCandidate(
              representation?.base_url || representation?.baseUrl || representation?.url,
              "facebook_dash_prefetch_representation",
              mimeType,
              {
                facebookVideoId,
                identityVerified: true,
                identityEvidence: "facebook_video_id_prefetch",
              },
            );
            const candidate = candidates.at(-1);
            if (candidates.length > candidateCountBefore && candidate) {
              candidate.bandwidth = Number(representation?.bandwidth) || 0;
              candidate.codecs = codecs;
              candidate.representationId = String(
                representation?.representation_id || representation?.representationId || "",
              );
              candidate.audioOnly = true;
              prefetchMatched = true;
            }
          }
          if (prefetchMatched) break;
        }
        if (Array.isArray(value)) {
          for (let index = value.length - 1; index >= 0; index -= 1) prefetchStack.push(value[index]);
        } else {
          for (const child of Object.values(value)) {
            if (child && typeof child === "object") prefetchStack.push(child);
          }
        }
      }
      const stack = [root];
      let visited = 0;
      let matchedVideo = false;
      while (stack.length && visited < 200_000) {
        const value = stack.pop();
        visited += 1;
        if (!value || typeof value !== "object") continue;
        // Only direct IDs establish ownership. `value.video.id` is deliberately
        // excluded because Facebook's result.data also owns viewer/feed data
        // for the next Reel.
        const valueVideoIds = [value.id, value.video_id, value.videoId]
          .map((candidate) => String(candidate || ""))
          .filter(Boolean);
        if (valueVideoIds.includes(facebookVideoId)) {
          const captionCountBefore = htmlTracks.length;
          const candidateCountBefore = candidates.length;
          const locales = value.video_available_captions_locales
            || value.available_captions_locales
            || [];
          const language = String(Array.isArray(locales) ? locales[0] || "" : locales || "");
          const deliveryStack = [value];
          let deliveryVisited = 0;
          while (deliveryStack.length && deliveryVisited < 20_000) {
            const delivery = deliveryStack.pop();
            deliveryVisited += 1;
            if (!delivery || typeof delivery !== "object") continue;
            const scopedOwnerId = String(
              delivery.video_id
              || delivery.videoId
              || ((delivery.videoDeliveryResponseFragment
                || delivery.videoDeliveryResponseResult
                || delivery.dash_manifests
                || delivery.progressive_urls)
                ? delivery.id
                : "")
              || "",
            );
            if (delivery !== value && scopedOwnerId && scopedOwnerId !== facebookVideoId) {
              continue;
            }
            if (Array.isArray(delivery)) {
              for (let index = delivery.length - 1; index >= 0; index -= 1) {
                deliveryStack.push(delivery[index]);
              }
              continue;
            }
            for (const [key, child] of Object.entries(delivery)) {
              if (typeof child === "string") {
                if (/(?:caption|subtitle).*?(?:url|uri|src)|^(?:captions_url|subtitle_url)$/i.test(key)) {
                  addFacebookCaption(child, language, identityEvidence);
                }
                if (/(?:manifest_xml|dash_manifest)$/i.test(key)) addFacebookManifest(child, identityEvidence);
                if (/(?:browser_native_(?:hd|sd)_url|playable_url(?:_quality_hd)?|audio_url)$/i.test(key)) {
                  addCandidate(
                    child,
                    identityEvidence === "facebook_permalink_payload"
                      ? "facebook_permalink_media"
                      : "facebook_embedded_media",
                    /audio/i.test(key) ? "audio/mp4" : "video/mp4",
                    { facebookVideoId, identityVerified: true, identityEvidence },
                  );
                }
                continue;
              }
              if (child && typeof child === "object") deliveryStack.push(child);
            }
          }
          const foundDeliveryData = htmlTracks.length > captionCountBefore
            || candidates.length > candidateCountBefore;
          if (foundDeliveryData) {
            matchedVideo = true;
            stack.length = 0;
            break;
          }
        }
        if (Array.isArray(value)) {
          for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
        } else {
          for (const child of Object.values(value)) {
            if (child && typeof child === "object") stack.push(child);
          }
        }
      }
      return matchedVideo || prefetchMatched;
    };
    for (const script of scripts) {
      if (scanFacebookPayloadText(script.textContent)) break;
    }

    const hasVerifiedDelivery = () => (
      htmlTracks.some((track) => track.facebookVideoId === facebookVideoId && track.identityVerified)
      || candidates.some((candidate) => candidate.facebookVideoId === facebookVideoId && candidate.identityVerified)
    );
    const hasPermalinkDelivery = () => (
      htmlTracks.some((track) => track.identityEvidence === "facebook_permalink_payload")
      || candidates.some((candidate) => candidate.identityEvidence === "facebook_permalink_payload")
    );
    const isTopFrame = !globalThis.top || globalThis.top === globalThis;
    if (
      requestedFacebookVideoId
      && !hasPermalinkDelivery()
      && isTopFrame
      && typeof globalThis.fetch === "function"
      && typeof globalThis.DOMParser === "function"
    ) {
      try {
        const permalinkUrl = new URL(`/reel/${requestedFacebookVideoId}/`, location.origin).href;
        const response = await globalThis.fetch(permalinkUrl, {
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
        });
        if (response.ok) {
          const html = await response.text();
          const parsedDocument = new globalThis.DOMParser().parseFromString(html, "text/html");
          const payloadScripts = [...parsedDocument.querySelectorAll("script")]
            .map((node) => String(node.textContent || "").trim())
            .filter((text) => text.startsWith("{") || text.startsWith("["));
          let permalinkMatched = false;
          for (const payload of payloadScripts) {
            if (scanFacebookPayloadText(payload, "facebook_permalink_payload")) {
              permalinkMatched = true;
              break;
            }
          }
          if (permalinkMatched && hasVerifiedDelivery()) {
            facebookPermalinkProbeUsed = true;
            facebookPermalinkProbeUrl = permalinkUrl;
          }
        }
      } catch {
        // The live, identity-bound player path remains available when Facebook
        // blocks a same-origin permalink probe or changes its HTML bootstrap.
      }
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
    found: Boolean(element || htmlTracks.length || youtubeTracks.length || candidates.length || facebookVideoId),
    pageTitle: document.title,
    pageUrl: facebookPermalinkProbeUsed ? facebookPermalinkProbeUrl : location.href,
    frameUrl: location.href,
    durationSeconds: youtubeDurationSeconds || (
      element
      && (!facebookVideoId || selectedElementFacebookVideoId === facebookVideoId)
      && Number.isFinite(element.duration)
      && element.duration > 0
        ? element.duration
        : null
    ),
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
      playerToken: activePlayerToken,
    } : null,
    facebookVideoId,
    requestedFacebookVideoId,
    pageFacebookVideoId,
    selectedElementFacebookVideoId,
    activePlayerToken,
    facebookPlayerIdentityMismatch: Boolean(
      selectedElementFacebookVideoId
      && ((requestedFacebookVideoId && selectedElementFacebookVideoId !== requestedFacebookVideoId)
        || (!requestedFacebookVideoId && pageFacebookVideoId && selectedElementFacebookVideoId !== pageFacebookVideoId)),
    ),
    facebookPermalinkProbeUsed,
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

export async function fetchVideoCaptionTrackInPage(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7_000);
  try {
    const parsed = new URL(String(url || ""), location.href);
    if (parsed.protocol !== "https:") return { ok: false, status: 0, body: "", contentType: "" };
    const response = await fetch(parsed.href, {
      credentials: "include",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, body: "", contentType: response.headers.get("content-type") || "" };
    }
    const body = await response.text();
    // A subtitle file should remain comfortably below this boundary. Avoid
    // returning an accidental HTML/media response through executeScript.
    if (!body || body.length > 2_000_000) {
      return { ok: false, status: response.status, body: "", contentType: response.headers.get("content-type") || "" };
    }
    return {
      ok: true,
      status: response.status,
      body,
      contentType: response.headers.get("content-type") || "",
    };
  } catch {
    return { ok: false, status: 0, body: "", contentType: "" };
  } finally {
    clearTimeout(timeoutId);
  }
}
