import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAacAdtsHeader,
  captionSegmentsCoverMedia,
  classifyVideoSourceUrl,
  chooseDirectMediaCandidate,
  createVideoAnalysisService,
  extractInteractionText,
  formatTranscriptFile,
  formatVideoSummaryMarkdown,
  formatVideoTimestamp,
  GROQ_TRANSCRIPTION_MODEL,
  GROQ_TRANSCRIPTION_MODELS,
  isGeminiModelCapacityError,
  MAX_GROQ_FREE_UPLOAD_BYTES,
  mergeVideoAnalysisSources,
  isTemporarySignedMediaUrl,
  normalizeSupportedVideoSourceUrl,
  normalizeGroqTranscription,
  normalizeVideoAnalysisResult,
  parseCaptionPayload,
  parseHlsPlaylist,
  parseStoredTranscriptSegments,
  rankDirectMediaCandidates,
  videoIdentityKey,
} from "../background/video-analysis-service.js";
import {
  GET_TRANSCRIPT_TOOL_NAME,
  prepareVideoAnalysisAgentResult,
  VIDEO_ANALYSIS_MODEL,
  VIDEO_ANALYSIS_MODELS,
  VIDEO_ANALYSIS_THINKING_LEVEL,
  VIDEO_SUMMARY_TOOL_NAME,
} from "../live/video-analysis.js";
import {
  BUILTIN_TOOLS,
  buildSessionInstruction,
} from "../live/session-config.js";
import { collectVideoAnalysisSourceInPage } from "../browser/video-analysis-source.js";

test("builds a valid MPEG-4 AAC-LC ADTS header", () => {
  assert.deepEqual(
    [...buildAacAdtsHeader(4, {
      audioObjectType: 2,
      sampleRateIndex: 4,
      channelConfiguration: 2,
    })],
    [0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc],
  );
});

test("parses YouTube JSON3, WebVTT, SubRip, and timed-text XML captions", () => {
  const jsonCues = parseCaptionPayload(JSON.stringify({
    events: [
      { tStartMs: 1000, dDurationMs: 1500, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
      { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: "Next point" }] },
    ],
  }), "application/json");
  assert.deepEqual(jsonCues, [
    { start: "00:01", end: "00:02", speaker: "Speaker", text: "Hello world" },
    { start: "00:03", end: "00:04", speaker: "Speaker", text: "Next point" },
  ]);

  const vttCues = parseCaptionPayload(`WEBVTT

00:00:01.000 --> 00:00:03.000
First caption

00:00:03.000 --> 00:00:05.500
Second caption
`, "text/vtt");
  assert.equal(vttCues.length, 2);
  assert.equal(vttCues[0].text, "First caption");
  assert.equal(vttCues[1].end, "00:05");

  const srtCues = parseCaptionPayload(`1
00:00:02,000 --> 00:00:04,500
Udemy subtitle
`, "application/x-subrip");
  assert.equal(srtCues.length, 1);
  assert.equal(srtCues[0].text, "Udemy subtitle");

  const xmlCues = parseCaptionPayload(
    '<transcript><text start="1.5" dur="2">One &amp; two</text></transcript>',
    "text/xml",
  );
  assert.deepEqual(xmlCues, [
    { start: "00:01", end: "00:03", speaker: "Speaker", text: "One & two" },
  ]);
});

test("normalizes transcript timestamps and downloadable plain text", () => {
  assert.equal(formatVideoTimestamp(65.8), "01:05");
  assert.equal(formatVideoTimestamp(3665), "01:01:05");
  const result = normalizeVideoAnalysisResult({
    summary: "  Summary  ",
    language: "en",
    chapters: [{ start: "00:00", end: "00:10", title: "Context", summary: "Introduces the subject" }],
    segments: [{ start: "00:01", end: "00:03", speaker: "A", text: "Hello" }],
    importantSegments: [{ start: "00:01", end: "00:03", title: "Opening", reason: "Sets context" }],
  });
  const transcript = formatTranscriptFile({
    title: "Example",
    pageUrl: "https://example.com/video",
    language: result.language,
    segments: result.segments,
  });
  assert.match(transcript, /^Example\nSource: https:\/\/example\.com\/video\nLanguage: en/);
  assert.match(transcript, /\[00:01 - 00:03\] A: Hello/);
  assert.match(formatVideoSummaryMarkdown(result), /## Content timeline/);
  assert.match(formatVideoSummaryMarkdown(result), /From 00:00 to 00:10 — Context:/);

  const bounded = normalizeVideoAnalysisResult({
    language: "en",
    chapters: [
      { start: "00:00", end: "14:14", title: "Main topic", summary: "Covers the main topic." },
      { start: "14:14", end: "24:19", title: "Conclusion", summary: "Finishes the explanation." },
      { start: "24:19", end: "25:00", title: "Impossible", summary: "Must be discarded." },
    ],
    segments: [
      { start: "00:00", end: "14:14", speaker: "A", text: "Main content" },
      { start: "14:14", end: "24:19", speaker: "A", text: "Conclusion" },
      { start: "24:19", end: "25:00", speaker: "A", text: "Hallucinated tail" },
    ],
    importantSegments: [
      { start: "17:30", end: "24:19", title: "Ending", reason: "Final point" },
      { start: "24:19", end: "25:00", title: "Impossible", reason: "Outside the video" },
    ],
  }, [], 18 * 60);
  assert.equal(bounded.chapters.at(-1).end, "18:00");
  assert.equal(bounded.segments.at(-1).end, "18:00");
  assert.equal(bounded.importantSegments.at(-1).end, "18:00");
  assert.equal(bounded.chapters.some((chapter) => chapter.title === "Impossible"), false);
  assert.equal(bounded.segments.some((segment) => segment.text === "Hallucinated tail"), false);
});

test("accepts supported video page URLs and identifies temporary audio links", () => {
  assert.equal(
    normalizeSupportedVideoSourceUrl("https://youtu.be/video123?t=4"),
    "https://youtu.be/video123?t=4",
  );
  assert.equal(
    normalizeSupportedVideoSourceUrl("https://www.facebook.com/reel/123456"),
    "https://www.facebook.com/reel/123456",
  );
  assert.equal(
    normalizeSupportedVideoSourceUrl("https://team.udemy.com/course/example/learn/lecture/99"),
    "https://team.udemy.com/course/example/learn/lecture/99",
  );
  assert.equal(normalizeSupportedVideoSourceUrl("https://example.com/video"), "");
  assert.equal(normalizeSupportedVideoSourceUrl("http://youtube.com/watch?v=1"), "");
  assert.equal(isTemporarySignedMediaUrl("https://cdn.example/audio.m4a?expire=123&sig=abc"), true);
  assert.equal(isTemporarySignedMediaUrl("https://cdn.example/audio.mp3"), false);
});

test("normalizes Groq Whisper segments against the verified media duration", () => {
  const result = normalizeGroqTranscription({
    language: "vi",
    duration: 1459,
    text: "Hello. Ending.",
    segments: [
      { start: 0.2, end: 2.8, text: " Hello. " },
      { start: 1078.4, end: 1459, text: " Ending. " },
    ],
  }, 18 * 60);
  assert.equal(result.language, "vi");
  assert.equal(result.durationSeconds, 18 * 60);
  assert.deepEqual(result.segments, [
    { start: "00:00", end: "00:02", speaker: "Speaker", text: "Hello." },
    { start: "17:58", end: "18:00", speaker: "Speaker", text: "Ending." },
  ]);
  assert.equal(MAX_GROQ_FREE_UPLOAD_BYTES, Math.floor(19.5 * 1024 * 1024));
});

test("rejects partial or stale captions before treating them as a complete transcript", () => {
  assert.equal(captionSegmentsCoverMedia([
    { start: 0, end: 4, text: "Only the currently loaded cue" },
  ], 600), false);
  assert.equal(captionSegmentsCoverMedia([
    { start: 0, end: 290, text: "First half" },
    { start: 290, end: 590, text: "Second half" },
  ], 600), true);
  assert.equal(captionSegmentsCoverMedia([
    { start: 0, end: 900, text: "Stale caption track from another video" },
  ], 600), false);
});

test("identifies the same video across playback URLs and restores stored transcript segments", () => {
  assert.equal(
    videoIdentityKey("https://www.youtube.com/watch?v=abc123&t=90"),
    videoIdentityKey("https://youtu.be/abc123?si=share"),
  );
  assert.notEqual(
    videoIdentityKey("https://www.youtube.com/watch?v=abc123"),
    videoIdentityKey("https://www.youtube.com/watch?v=other456"),
  );
  assert.equal(
    videoIdentityKey("https://www.facebook.com/reel/1554671672755534?mibextid=share"),
    "facebook:1554671672755534",
  );
  assert.deepEqual(parseStoredTranscriptSegments([
    "Example",
    "Language: en",
    "",
    "[00:00 - 00:03] Narrator: First idea",
    "[00:03 - 00:06] Second idea",
  ].join("\n")), [
    { start: "00:00", end: "00:03", speaker: "Narrator", text: "First idea" },
    { start: "00:03", end: "00:06", speaker: "Speaker", text: "Second idea" },
  ]);
});

test("renders Vietnamese summary chapters as one ordered timeline starting at zero", () => {
  const markdown = formatVideoSummaryMarkdown({
    language: "vi",
    summary: "Video giải thích hai chủ đề chính.",
    chapters: [
      { start: "00:20", end: "00:30", title: "Phần hai", summary: "Thảo luận chủ đề thứ hai." },
      { start: "00:05", end: "00:15", title: "Giới thiệu", summary: "Giới thiệu chủ đề đầu tiên." },
    ],
  });
  assert.match(markdown, /Từ 00:00 đến 00:15 — Giới thiệu:/);
  assert.match(markdown, /Từ 00:15 đến 00:30 — Phần hai:/);
});

test("extracts Interactions API text and prefers complete safe media URLs", () => {
  const json = '{"summary":"Ready","language":"en","segments":[],"importantSegments":[]}';
  assert.equal(extractInteractionText({
    outputs: [{ type: "text", content: [{ type: "text", text: json }] }],
  }), json);
  const candidate = chooseDirectMediaCandidate([
    { url: "blob:https://facebook.com/id", origin: "current_src" },
    { url: "https://127.0.0.1/private.mp4", origin: "page_metadata" },
    { url: "https://video.xx.fbcdn.net/reel.mp4?token=abc", origin: "page_metadata" },
    { url: "https://video.xx.fbcdn.net/chunk.m4s", origin: "performance_resource" },
  ]);
  assert.equal(candidate.url, "https://video.xx.fbcdn.net/reel.mp4?token=abc");
  assert.equal(extractInteractionText({
    steps: [
      { type: "user_input", content: [{ type: "text", text: "Ignore this input" }] },
      { type: "model_output", content: [{ type: "text", text: json }] },
    ],
  }), json);
});

test("merges video sources across Udemy-style frames and ranks Facebook audio", () => {
  const merged = mergeVideoAnalysisSources([
    { frameId: 0, result: {
      found: true,
      pageTitle: "Course lecture",
      pageUrl: "https://www.udemy.com/course/example/learn/lecture/1",
      captionTracks: [],
      mediaCandidates: [],
    } },
    { frameId: 4, result: {
      found: true,
      pageTitle: "Player",
      pageUrl: "https://player.example/",
      media: { paused: false, visibleArea: 500_000 },
      captionTracks: [{ source: "html_track_url", baseUrl: "https://cdn.example/subtitles.vtt" }],
      mediaCandidates: [{ url: "https://cdn.example/master.m3u8", origin: "performance_resource" }],
    } },
  ]);
  assert.equal(merged.pageTitle, "Course lecture");
  assert.equal(merged.captionTracks[0].frameId, 4);
  assert.equal(merged.mediaCandidates[0].frameId, 4);

  const ranked = rankDirectMediaCandidates([
    { url: "https://video.xx.fbcdn.net/reel.mp4?mime_type=video_mp4", origin: "performance_resource" },
    { url: "https://video.xx.fbcdn.net/reel.mp4?mime_type=audio_mp4", origin: "performance_resource" },
  ], { preferAudio: true });
  assert.match(ranked[0].url, /audio_mp4/);
});

test("merges only media verified against the exact Facebook Reel ID", () => {
  const targetId = "1554671672755534";
  const merged = mergeVideoAnalysisSources([
    { frameId: 0, result: {
      found: true,
      pageTitle: "Target Reel",
      pageUrl: `https://www.facebook.com/reel/${targetId}`,
      facebookVideoId: targetId,
      facebookMediaIdentityVerified: true,
      captionTracks: [],
      mediaCandidates: [{
        url: "https://scontent.fbcdn.net/target-audio.mp4",
        origin: "facebook_dash_manifest",
        mimeType: "audio/mp4",
        facebookVideoId: targetId,
        identityVerified: true,
      }],
    } },
    { frameId: 1, result: {
      found: true,
      pageTitle: "Adjacent Reel",
      pageUrl: "https://www.facebook.com/reel/9999999999999999",
      captionTracks: [{ source: "performance_caption_resource", baseUrl: "https://fbcdn.net/wrong.vtt" }],
      mediaCandidates: [{
        url: "https://scontent.fbcdn.net/wrong-audio.mp4",
        origin: "facebook_dash_manifest",
        mimeType: "audio/mp4",
        facebookVideoId: "9999999999999999",
        identityVerified: true,
      }],
    } },
  ]);
  assert.equal(merged.facebookVideoId, targetId);
  assert.equal(merged.facebookMediaIdentityVerified, true);
  assert.deepEqual(merged.captionTracks, []);
  assert.deepEqual(merged.mediaCandidates.map((candidate) => candidate.url), [
    "https://scontent.fbcdn.net/target-audio.mp4",
  ]);
});

test("parses HLS audio renditions and unencrypted media segments", () => {
  const master = parseHlsPlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2"
video/index.m3u8
`, "https://cdn.example/course/master.m3u8");
  assert.equal(master.type, "master");
  assert.equal(master.audioPlaylists[0].url, "https://cdn.example/course/audio/index.m3u8");

  const media = parseHlsPlaylist(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
segment-1.m4s
#EXTINF:4.0,
segment-2.m4s
#EXT-X-ENDLIST
`, "https://cdn.example/course/audio/index.m3u8");
  assert.equal(media.type, "media");
  assert.equal(media.encrypted, false);
  assert.deepEqual(media.segments, [
    "https://cdn.example/course/audio/segment-1.m4s",
    "https://cdn.example/course/audio/segment-2.m4s",
  ]);
});

test("rejects unbound Facebook performance media instead of guessing an adjacent Reel", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  try {
    globalThis.document = {
      title: "Facebook Reel",
      querySelectorAll() { return []; },
      querySelector() { return null; },
    };
    globalThis.location = {
      href: "https://www.facebook.com/reel/1554671672755534",
      hostname: "www.facebook.com",
      pathname: "/reel/1554671672755534",
    };
    globalThis.performance = {
      getEntriesByType() {
        return [
          {
            name: "https://scontent.xx.fbcdn.net/v/t39.30808-6/image.jpg",
            initiatorType: "img",
            transferSize: 1000,
            startTime: 1,
          },
          {
            name: "https://video.xx.fbcdn.net/o1/v/t2/f2/m69/audio?mime_type=audio_mp4&token=signed",
            initiatorType: "xmlhttprequest",
            transferSize: 4000,
            startTime: 2,
          },
        ];
      },
    };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    const source = await collectVideoAnalysisSourceInPage();
    assert.equal(source.found, true);
    assert.equal(source.facebookVideoId, "1554671672755534");
    assert.equal(source.facebookMediaIdentityVerified, false);
    assert.equal(source.mediaCandidates.length, 0);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
  }
});

test("extracts the exact Facebook Reel audio representation from embedded DASH metadata", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  try {
    const targetId = "1554671672755534";
    const manifestXml = `<MPD><Period><AdaptationSet><Representation id="video-track" bandwidth="100000" mimeType="video/mp4" codecs="av01"><BaseURL>https://scontent.example.fbcdn.net/o1/v/video.mp4?token=video&amp;expires=1</BaseURL></Representation><Representation id="audio-track" bandwidth="45836" mimeType="audio/mp4" codecs="mp4a.40.5"><BaseURL>https://scontent.example.fbcdn.net/o1/v/audio.mp4?token=audio&amp;expires=1</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const pageData = JSON.stringify({
      require: [{
        result: {
          data: {
            video: {
              id: targetId,
              captions_url: "https://scontent.example.fbcdn.net/captions/reel-en.vtt?token=caption",
              video_available_captions_locales: ["en_US"],
              browser_native_hd_url: "https://scontent.example.fbcdn.net/o1/v/reel-video.mp4?token=video",
              videoDeliveryResponseFragment: {
                videoDeliveryResponseResult: {
                  dash_manifests: [{ manifest_xml: manifestXml }],
                },
              },
            },
          },
        },
      }],
      // Facebook commonly emits shallow references to the same Reel ID after
      // the full delivery object. The collector must not stop at this decoy.
      trailingVideoReference: { id: targetId },
    });
    globalThis.document = {
      title: "Facebook Reel",
      querySelectorAll(selector) {
        return selector.startsWith("script[") ? [{ textContent: pageData }] : [];
      },
      querySelector() { return null; },
    };
    globalThis.location = {
      href: `https://www.facebook.com/reel/${targetId}`,
      hostname: "www.facebook.com",
      pathname: `/reel/${targetId}`,
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    const source = await collectVideoAnalysisSourceInPage();
    assert.equal(source.facebookVideoId, targetId);
    assert.equal(source.facebookMediaIdentityVerified, true);
    assert.equal(source.captionTracks.length, 1);
    assert.equal(source.captionTracks[0].source, "facebook_caption_url");
    assert.equal(source.captionTracks[0].identityVerified, true);
    assert.match(source.captionTracks[0].baseUrl, /reel-en\.vtt/);
    assert.ok(source.mediaCandidates.some((candidate) => (
      candidate.origin === "facebook_embedded_media"
      && candidate.identityVerified === true
    )));
    const candidates = source.mediaCandidates.filter((candidate) => candidate.origin === "facebook_dash_manifest");
    assert.equal(candidates.length, 2);
    const audio = candidates.find((candidate) => candidate.mimeType === "audio/mp4");
    assert.ok(audio);
    assert.equal(audio.bandwidth, 45836);
    assert.equal(audio.facebookVideoId, targetId);
    assert.equal(audio.identityVerified, true);
    assert.equal(audio.representationId, "audio-track");
    assert.match(audio.url, /token=audio&expires=1/);
    assert.match(rankDirectMediaCandidates(candidates, { preferAudio: true })[0].url, /audio\.mp4/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
  }
});

test("inherits Facebook audio MIME metadata from its DASH AdaptationSet", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  try {
    const targetId = "1666666666666666";
    const audioUrl = "https://scontent.example.fbcdn.net/o1/v/inherited-audio.mp4?token=audio";
    const manifestXml = `<MPD><Period><AdaptationSet contentType="audio" mimeType="application/mp4" codecs="mp4a.40.5"><Representation id="audio-track" bandwidth="48000"><BaseURL><![CDATA[${audioUrl}]]></BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const pageData = JSON.stringify({ video: { id: targetId, dash_manifest: manifestXml } });
    globalThis.document = {
      title: "Facebook Reel",
      querySelectorAll(selector) {
        return selector.startsWith("script[") ? [{ textContent: pageData }] : [];
      },
      querySelector() { return null; },
    };
    globalThis.location = {
      href: `https://www.facebook.com/reel/${targetId}`,
      hostname: "www.facebook.com",
      pathname: `/reel/${targetId}`,
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    const source = await collectVideoAnalysisSourceInPage();
    const audio = source.mediaCandidates.find((candidate) => candidate.representationId === "audio-track");
    assert.equal(audio?.mimeType, "audio/mp4");
    assert.equal(audio?.audioOnly, true);
    assert.equal(audio?.url, audioUrl);
    assert.equal(rankDirectMediaCandidates(source.mediaCandidates, { preferAudio: true })[0]?.url, audioUrl);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
  }
});

test("uses Facebook video_id prefetch audio without crossing into the next Reel payload", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  try {
    const targetId = "1554671672755534";
    const nextId = "1559482142197723";
    const targetPrefetchAudio = "https://scontent.example.fbcdn.net/o1/v/target-prefetch-audio.mp4?token=target";
    const targetManifestAudio = "https://scontent.example.fbcdn.net/o1/v/target-manifest-audio.mp4?token=target";
    const nextAudio = "https://scontent.example.fbcdn.net/o1/v/next-reel-audio.mp4?token=next";
    const manifest = (url) => `<MPD><Period><AdaptationSet><Representation id="audio" mimeType="audio/mp4" codecs="mp4a.40.5"><BaseURL>${url.replace(/&/g, "&amp;")}</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const delivery = (id, url) => ({
      id,
      dash_manifests: [{ manifest_xml: manifest(url) }],
    });
    const pageData = JSON.stringify({
      extensions: {
        all_video_dash_prefetch_representations: [
          {
            video_id: targetId,
            representations: [{
              base_url: targetPrefetchAudio,
              mime_type: "audio/mp4",
              codecs: "mp4a.40.5",
              bandwidth: 45_836,
              representation_id: "target-audio",
            }],
          },
          {
            video_id: nextId,
            representations: [{
              base_url: nextAudio,
              mime_type: "audio/mp4",
              codecs: "mp4a.40.5",
              representation_id: "next-audio",
            }],
          },
        ],
      },
      data: {
        // This broad object caused the production bug: video.id is the current
        // Reel while viewer contains the already-prefetched Reel below it.
        video: {
          id: targetId,
          creation_story: {
            attachments: [{
              media: {
                id: targetId,
                videoDeliveryResponseFragment: {
                  id: targetId,
                  videoDeliveryResponseResult: delivery(targetId, targetManifestAudio),
                },
              },
            }],
          },
        },
        viewer: {
          video_feed_unit_feed: {
            edges: [{
              node: {
                attachments: [{
                  media: {
                    id: nextId,
                    videoDeliveryResponseFragment: {
                      id: nextId,
                      videoDeliveryResponseResult: delivery(nextId, nextAudio),
                    },
                  },
                }],
              },
            }],
          },
        },
      },
    });
    globalThis.document = {
      title: "Facebook Reel",
      querySelectorAll(selector) {
        return selector.startsWith("script[") ? [{ textContent: pageData }] : [];
      },
      querySelector() { return null; },
    };
    globalThis.location = {
      href: `https://www.facebook.com/reel/${targetId}`,
      hostname: "www.facebook.com",
      pathname: `/reel/${targetId}`,
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    const source = await collectVideoAnalysisSourceInPage();
    const audioCandidates = source.mediaCandidates.filter((candidate) => candidate.mimeType === "audio/mp4");
    assert.ok(audioCandidates.some((candidate) => (
      candidate.url === targetPrefetchAudio
      && candidate.origin === "facebook_dash_prefetch_representation"
      && candidate.identityEvidence === "facebook_video_id_prefetch"
    )));
    assert.ok(audioCandidates.some((candidate) => candidate.url === targetManifestAudio));
    assert.equal(audioCandidates.some((candidate) => candidate.url === nextAudio), false);
    assert.equal(rankDirectMediaCandidates(audioCandidates, { preferAudio: true })[0]?.url, targetPrefetchAudio);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
  }
});

test("derives the active Reel ID from the current player on the scrolling Facebook feed", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  try {
    const targetId = "1554671672755534";
    const audioUrl = "https://scontent.example.fbcdn.net/o1/v/audio.mp4?token=active-feed";
    const manifestXml = `<MPD><Period><AdaptationSet><Representation id="audio-track" bandwidth="45836" mimeType="audio/mp4" codecs="mp4a.40.5"><BaseURL>${audioUrl.replace(/&/g, "&amp;")}</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const pageData = JSON.stringify({
      payload: {
        video: {
          id: targetId,
          dash_manifest: manifestXml,
        },
      },
    });
    const player = {
      attributes: [{ name: "data-video-id", value: targetId }],
      parentElement: null,
      readyState: 4,
      paused: false,
      ended: false,
      duration: 32,
      currentTime: 3,
      currentSrc: "blob:https://www.facebook.com/active-reel",
      src: "",
      poster: "",
      textTracks: [],
      tagName: "VIDEO",
      getBoundingClientRect() { return { width: 540, height: 960 }; },
      getAttribute() { return ""; },
      querySelectorAll() { return []; },
    };
    globalThis.document = {
      title: "Facebook Reels",
      querySelectorAll(selector) {
        if (selector === "video, audio") return [player];
        if (selector.startsWith("script[")) return [{ textContent: pageData }];
        return [];
      },
      querySelector() { return null; },
    };
    globalThis.location = {
      href: "https://www.facebook.com/reels/",
      hostname: "www.facebook.com",
      pathname: "/reels/",
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };

    const source = await collectVideoAnalysisSourceInPage();
    assert.equal(source.facebookVideoId, targetId);
    assert.equal(source.media.facebookVideoId, targetId);
    assert.equal(source.facebookMediaIdentityVerified, true);
    assert.equal(source.mediaCandidates.find((candidate) => candidate.mimeType === "audio/mp4")?.url, audioUrl);
    const constrained = await collectVideoAnalysisSourceInPage("9999999999999999");
    assert.equal(constrained.facebookVideoId, "9999999999999999");
    assert.equal(constrained.facebookMediaIdentityVerified, false);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
  }
});

test("ignores a stale YouTube SPA player response and reads the current video's duration", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  const previousInitialPlayerResponse = globalThis.ytInitialPlayerResponse;
  const previousYtPlayer = globalThis.ytplayer;
  try {
    globalThis.document = {
      title: "Current YouTube video",
      querySelectorAll() { return []; },
      querySelector() { return null; },
    };
    globalThis.location = {
      href: "https://www.youtube.com/watch?v=current123",
      hostname: "www.youtube.com",
      pathname: "/watch",
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    globalThis.ytInitialPlayerResponse = {
      videoDetails: { videoId: "previous999", lengthSeconds: "1459" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: "https://www.youtube.com/api/timedtext?v=previous999",
        languageCode: "en",
      }] } },
    };
    globalThis.ytplayer = { config: { args: { player_response: JSON.stringify({
      videoDetails: { videoId: "current123", lengthSeconds: "1080" },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        baseUrl: "https://www.youtube.com/api/timedtext?v=current123",
        languageCode: "en",
      }] } },
    }) } } };

    const source = await collectVideoAnalysisSourceInPage();
    assert.equal(source.durationSeconds, 1080);
    assert.equal(source.captionTracks.length, 1);
    assert.match(source.captionTracks[0].baseUrl, /current123/);
    assert.doesNotMatch(source.captionTracks[0].baseUrl, /previous999/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
    if (previousInitialPlayerResponse === undefined) delete globalThis.ytInitialPlayerResponse;
    else globalThis.ytInitialPlayerResponse = previousInitialPlayerResponse;
    if (previousYtPlayer === undefined) delete globalThis.ytplayer;
    else globalThis.ytplayer = previousYtPlayer;
  }
});

test("reads current YouTube captions from the live movie player when initial SPA data is stale", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  const previousInitialPlayerResponse = globalThis.ytInitialPlayerResponse;
  try {
    globalThis.document = {
      title: "Live YouTube player",
      querySelectorAll() { return []; },
      querySelector() { return null; },
      getElementById(id) {
        if (id !== "movie_player") return null;
        return {
          getPlayerResponse() {
            return {
              videoDetails: { videoId: "live456", lengthSeconds: "95" },
              captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
                baseUrl: "https://www.youtube.com/api/timedtext?v=live456&lang=en",
                languageCode: "en",
                name: { simpleText: "English" },
              }] } },
            };
          },
        };
      },
    };
    globalThis.location = {
      href: "https://www.youtube.com/watch?v=live456",
      hostname: "www.youtube.com",
      pathname: "/watch",
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    globalThis.ytInitialPlayerResponse = {
      videoDetails: { videoId: "stale123", lengthSeconds: "400" },
    };
    const source = await collectVideoAnalysisSourceInPage();
    assert.equal(source.durationSeconds, 95);
    assert.equal(source.captionTracks.length, 1);
    assert.equal(source.captionTracks[0].source, "youtube_caption_track");
    assert.match(source.captionTracks[0].baseUrl, /live456/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
    if (previousInitialPlayerResponse === undefined) delete globalThis.ytInitialPlayerResponse;
    else globalThis.ytInitialPlayerResponse = previousInitialPlayerResponse;
  }
});

test("extracts a verified direct YouTube audio format for dedicated transcription", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  const previousInitialPlayerResponse = globalThis.ytInitialPlayerResponse;
  try {
    globalThis.document = {
      title: "YouTube audio",
      querySelectorAll() { return []; },
      querySelector() { return null; },
    };
    globalThis.location = {
      href: "https://www.youtube.com/watch?v=audio123",
      hostname: "www.youtube.com",
      pathname: "/watch",
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    globalThis.ytInitialPlayerResponse = {
      videoDetails: { videoId: "audio123", lengthSeconds: "1080" },
      streamingData: { adaptiveFormats: [{
        itag: 140,
        url: "https://rr.example.googlevideo.com/videoplayback?id=audio123",
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 129000,
        contentLength: "17400000",
      }] },
    };
    const source = await collectVideoAnalysisSourceInPage();
    const audio = source.mediaCandidates.find((candidate) => candidate.origin === "youtube_player_response");
    assert.ok(audio);
    assert.equal(audio.mimeType, 'audio/mp4; codecs="mp4a.40.2"');
    assert.equal(audio.contentLength, 17400000);
    assert.equal(audio.youtubeVideoId, "audio123");
    assert.equal(audio.identityVerified, true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
    if (previousInitialPlayerResponse === undefined) delete globalThis.ytInitialPlayerResponse;
    else globalThis.ytInitialPlayerResponse = previousInitialPlayerResponse;
  }
});

test("extracts Udemy captions and media URLs from embedded player JSON before playback", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  try {
    const payload = JSON.stringify({
      lecture: {
        captions: [{
          src: "https://mp4-c.udemycdn.com/captions/lecture-en.vtt?token=signed",
          srclang: "en",
          label: "English",
        }],
        media_sources: [{
          src: "https://mp4-c.udemycdn.com/lecture/master.m3u8?token=signed",
          type: "application/x-mpegURL",
        }],
      },
    });
    globalThis.document = {
      title: "Udemy embedded player",
      querySelectorAll(selector) {
        if (selector === "video, audio") return [];
        if (selector.startsWith("script[")) return [{ textContent: payload }];
        return [];
      },
      querySelector() { return null; },
    };
    globalThis.location = {
      href: "https://www.udemy.com/course/example/learn/lecture/123456",
      hostname: "www.udemy.com",
      pathname: "/course/example/learn/lecture/123456",
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    const source = await collectVideoAnalysisSourceInPage();
    assert.equal(source.found, true);
    assert.equal(source.captionTracks.length, 1);
    assert.equal(source.captionTracks[0].source, "udemy_embedded_caption");
    assert.match(source.captionTracks[0].baseUrl, /lecture-en\.vtt/);
    const media = source.mediaCandidates.find((candidate) => candidate.origin === "udemy_embedded_media");
    assert.ok(media);
    assert.match(media.url, /master\.m3u8/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
  }
});

test("keeps an Udemy frame that exposes only embedded captions before its player loads", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  try {
    const payload = JSON.stringify({
      lecture: {
        captions: [{
          src: "https://mp4-c.udemycdn.com/captions/caption-only.vtt?token=signed",
          locale: "en_US",
        }],
      },
    });
    globalThis.document = {
      title: "Udemy caption-only frame",
      querySelectorAll(selector) {
        if (selector === "video, audio") return [];
        if (selector.startsWith("script[")) return [{ textContent: payload }];
        return [];
      },
      querySelector() { return null; },
      getElementById() { return null; },
    };
    globalThis.location = {
      href: "https://www.udemy.com/course/example/learn/lecture/999",
      hostname: "www.udemy.com",
      pathname: "/course/example/learn/lecture/999",
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    const source = await collectVideoAnalysisSourceInPage();
    assert.equal(source.found, true);
    assert.equal(source.media, null);
    assert.equal(source.mediaCandidates.length, 0);
    assert.equal(source.captionTracks.length, 1);
    assert.equal(source.captionTracks[0].source, "udemy_embedded_caption");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
  }
});

function createMemoryStorage() {
  const state = {};
  return {
    state,
    area: {
      async get(key) { return { [key]: state[key] }; },
      async set(values) { Object.assign(state, values); },
    },
  };
}

for (const scenario of [
  {
    name: "YouTube",
    pageUrl: "https://www.youtube.com/watch?v=caption-summary",
    captionSource: "youtube_caption_track",
  },
  {
    name: "Facebook Reel",
    pageUrl: "https://www.facebook.com/reel/1554671672755534",
    captionSource: "facebook_caption_url",
    facebookVideoId: "1554671672755534",
  },
  {
    name: "Udemy",
    pageUrl: "https://www.udemy.com/course/example/learn/lecture/123456",
    captionSource: "udemy_embedded_caption",
  },
]) {
  test(`summarizes ${scenario.name} from complete captions without calling Groq`, async () => {
    const storage = createMemoryStorage();
    const captionTrack = {
      source: scenario.captionSource,
      language: "en",
      cues: [
        { start: 0, end: 10, text: `${scenario.name} opening` },
        { start: 10, end: 20, text: `${scenario.name} conclusion` },
      ],
      ...(scenario.facebookVideoId ? {
        facebookVideoId: scenario.facebookVideoId,
        identityVerified: true,
      } : {}),
    };
    const service = createVideoAnalysisService({
      chromeApi: {
        scripting: {
          async executeScript() {
            return [{ frameId: 0, result: {
              found: true,
              pageTitle: `${scenario.name} caption summary`,
              pageUrl: scenario.pageUrl,
              durationSeconds: 20,
              facebookVideoId: scenario.facebookVideoId || "",
              facebookMediaIdentityVerified: Boolean(scenario.facebookVideoId),
              captionTracks: [captionTrack],
              mediaCandidates: [],
            } }];
          },
        },
        storage: { local: storage.area },
      },
      fetchImpl: async (url, init = {}) => {
        assert.notEqual(url, "https://api.groq.com/openai/v1/audio/transcriptions");
        assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
        const request = JSON.parse(init.body);
        assert.match(request.input[0].text, new RegExp(`${scenario.name} conclusion`, "i"));
        return new Response(JSON.stringify({
          outputText: JSON.stringify({
            summary: `${scenario.name} summary from captions.`,
            language: "en",
            chapters: [{ start: "00:00", end: "00:20", title: "Lesson", summary: "Complete caption summary." }],
            importantSegments: [],
          }),
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      getTargetTab: async () => ({ id: 70, title: scenario.name, url: scenario.pageUrl }),
      storageKey: "analyses",
    });
    const result = await service.analyze({
      apiKey: "test-gemini-key",
      groqApiKey: "test-groq-key",
      args: { action: "summary", outputLanguage: "en" },
    });
    assert.equal(result.sourceMethod, scenario.captionSource);
    assert.equal(result.groqAttempted, false);
    assert.equal(result.summary, `${scenario.name} summary from captions.`);
  });
}

test("uses a complete existing caption track without spending a Gemini request", async () => {
  const storage = createMemoryStorage();
  let fetchCount = 0;
  const chromeApi = {
    scripting: {
      async executeScript() {
        return [{ result: {
          found: true,
          pageTitle: "Captioned video",
          pageUrl: "https://example.com/watch",
          media: { kind: "video", duration: 10 },
          captionTracks: [{
            source: "html_text_track",
            language: "en",
            label: "English",
            cues: [
              { start: 0, end: 2, text: "Welcome" },
              { start: 2, end: 5, text: "Main point" },
            ],
          }],
          mediaCandidates: [],
        } }];
      },
    },
    storage: { local: storage.area },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("Gemini should not be called for transcript-only captions.");
    },
    getTargetTab: async () => ({ id: 7, title: "Captioned video", url: "https://example.com/watch" }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.equal(fetchCount, 0);
  assert.equal(result.sourceMethod, "html_text_track");
  assert.equal(result.model, null);
  assert.match(result.transcript, /Welcome/);
  assert.match(result.transcriptDownload.filename, /Captioned-video-transcript\.txt/);
  assert.equal(result.groqAttempted, false);
  assert.equal(storage.state.analyses, undefined);
});

test("prefers a complete English transcript when several caption languages exist", async () => {
  const progress = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Multilingual video",
            pageUrl: "https://www.youtube.com/watch?v=multilingual",
            durationSeconds: 10,
            captionTracks: [
              {
                source: "youtube_caption_track",
                language: "es",
                label: "Español",
                cues: [{ start: 0, end: 10, text: "Texto en español" }],
              },
              {
                source: "youtube_caption_track",
                language: "en-US",
                label: "English (US)",
                cues: [{ start: 0, end: 10, text: "English transcript" }],
              },
            ],
            mediaCandidates: [],
          } }];
        },
      },
    },
    fetchImpl: async () => { throw new Error("Embedded English captions should avoid network requests."); },
    onProgress(event) { progress.push(event); },
    getTargetTab: async () => ({
      id: 71,
      title: "Multilingual video",
      url: "https://www.youtube.com/watch?v=multilingual",
    }),
  });
  const result = await service.analyze({
    apiKey: "test-key",
    args: {
      action: "transcript",
      outputLanguage: "auto",
      progressRequestId: "progress-english",
    },
  });
  assert.equal(result.language, "en-US");
  assert.match(result.transcript, /English transcript/);
  assert.doesNotMatch(result.transcript, /Texto en español/);
  assert.deepEqual(progress.map((event) => event.stage), [
    "target",
    "source",
    "captions",
    "captions_found",
    "finalizing",
  ]);
  assert.ok(progress.every((event) => event.requestId === "progress-english"));
});

test("opens only a supplied source page and uses its captions before resolving audio", async () => {
  const storage = createMemoryStorage();
  const tabCreates = [];
  const sourceUrl = "https://www.youtube.com/watch?v=audio-tab-test";
  const audioUrl = "https://rr.example.googlevideo.com/videoplayback?mime=audio%2Fwebm&expire=1999999999&sig=test";
  const chromeApi = {
    scripting: {
      async executeScript({ target }) {
        assert.equal(target.tabId, 40);
        return [{ result: {
          found: true,
          pageTitle: "Linked YouTube video",
          pageUrl: sourceUrl,
          media: { kind: "video", duration: 12 },
          captionTracks: [{
            source: "youtube_caption_track",
            language: "en",
            cues: [
              { start: 0, end: 4, text: "Opening point" },
              { start: 4, end: 10, text: "Closing point" },
            ],
          }],
          mediaCandidates: [{
            url: audioUrl,
            mimeType: "audio/webm",
            origin: "youtube_player_response",
          }],
        } }];
      },
    },
    storage: { local: storage.area },
    tabs: {
      async create(properties) {
        tabCreates.push(properties);
        return { id: 40, url: sourceUrl, title: "Linked YouTube video", status: "loading", windowId: 3 };
      },
      async get(tabId) {
        assert.equal(tabId, 40);
        return { id: 40, url: sourceUrl, title: "Linked YouTube video", status: "complete", windowId: 3 };
      },
    },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async () => {
      throw new Error("Embedded captions should avoid network requests.");
    },
    getTargetTab: async () => ({ id: 7, title: "Other page", url: "https://example.com" }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript", url: sourceUrl },
  });
  assert.deepEqual(tabCreates, [{ url: sourceUrl, active: true }]);
  assert.equal(result.sourcePageTabId, 40);
  assert.equal(result.sourcePageOpened, true);
  assert.equal(result.audioUrl, null);
  assert.equal(result.audioTabId, null);
  assert.equal(result.audioSourceMethod, null);
  assert.equal(result.audioLinkEphemeral, false);
  assert.equal(result.sourceMethod, "youtube_caption_track");
  assert.equal(result.groqAttempted, false);
});

test("requires a verified audio URL only for an audio-link request", async () => {
  const storage = createMemoryStorage();
  const chromeApi = {
    scripting: {
      async executeScript() {
        return [{ result: {
          found: true,
          pageTitle: "Caption only",
          pageUrl: "https://www.youtube.com/watch?v=no-audio-reference",
          media: { kind: "video", duration: 12 },
          captionTracks: [{
            source: "youtube_caption_track",
            language: "en",
            cues: [{ start: 0, end: 4, text: "Caption exists" }],
          }],
          mediaCandidates: [],
        } }];
      },
    },
    storage: { local: storage.area },
    tabs: { async create() { throw new Error("No tab should be opened without a verified audio URL."); } },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async () => { throw new Error("No fetch expected."); },
    getTargetTab: async () => ({
      id: 8,
      title: "Caption only",
      url: "https://www.youtube.com/watch?v=no-audio-reference",
    }),
    storageKey: "analyses",
  });
  await assert.rejects(
    service.analyze({ args: { action: "audio" } }),
    /could not resolve a verified audio link/i,
  );
});

test("returns an audio link without opening it or requiring a Gemini request", async () => {
  const storage = createMemoryStorage();
  const audioUrl = "https://cdn.example/video-audio.m4a?token=temporary";
  const tabCreates = [];
  const removedTabs = [];
  const chromeApi = {
    scripting: {
      async executeScript() {
        return [{ result: {
          found: true,
          pageTitle: "Audio only request",
          pageUrl: "https://www.facebook.com/reel/777",
          facebookVideoId: "777",
          facebookMediaIdentityVerified: true,
          durationSeconds: 20,
          captionTracks: [],
          mediaCandidates: [{
            url: audioUrl,
            mimeType: "audio/mp4",
            origin: "facebook_dash_manifest",
            facebookVideoId: "777",
            identityVerified: true,
          }],
        } }];
      },
    },
    storage: { local: storage.area },
    tabs: {
      async create(properties) {
        tabCreates.push(properties);
        return { id: 52, url: properties.url, status: "complete", windowId: 4 };
      },
      async remove(tabId) { removedTabs.push(tabId); },
    },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async () => { throw new Error("The audio action must not call a model or download media."); },
    getTargetTab: async () => ({
      id: 51,
      title: "Audio only request",
      url: "https://www.facebook.com/reel/777",
      windowId: 4,
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({ args: { action: "audio" } });
  assert.equal(result.sourceMethod, "audio_reference");
  assert.equal(result.model, null);
  assert.equal(result.audioUrl, audioUrl);
  assert.equal(result.audioTabId, null);
  assert.equal(result.audioLinkEphemeral, true);
  assert.deepEqual(tabCreates, []);
  assert.equal(result.sourcePageOpened, false);
  assert.equal(result.sourcePageTabId, 51);
  assert.equal(result.sourcePageClosedAfterAnalysis, false);
  assert.deepEqual(removedTabs, []);
  assert.equal(storage.state.analyses, undefined);
});

test("sends an explicit direct audio URL to Groq without scanning or downloading it", async () => {
  const storage = createMemoryStorage();
  const audioUrl = "https://cdn.example.com/direct-audio?id=7&token=signed";
  const openedTabs = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: { async executeScript() { throw new Error("Direct audio must not scan the page."); } },
      storage: { local: storage.area },
      tabs: {
        async create(properties) {
          openedTabs.push(properties);
          return { id: 61, url: properties.url, windowId: 5 };
        },
      },
    },
    fetchImpl: async (url, init = {}) => {
      assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
      assert.equal(init.body.get("url"), audioUrl);
      assert.equal(init.body.get("file"), null);
      return new Response(JSON.stringify({
        language: "en",
        duration: 8,
        segments: [{ start: 0, end: 8, text: "Direct URL transcript" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({ id: 60, title: "Current tab", url: "https://example.com", windowId: 5 }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript", audioUrl },
  });
  assert.deepEqual(openedTabs, []);
  assert.equal(result.audioUrl, audioUrl);
  assert.equal(result.groqInputMethod, "audio_url");
  assert.match(result.transcript, /Direct URL transcript/);
});

test("fetches a complete Udemy VTT track from the player frame without a media upload", async () => {
  const storage = createMemoryStorage();
  const requests = [];
  const chromeApi = {
    scripting: {
      async executeScript() {
        return [
          { frameId: 0, result: {
            found: true,
            pageTitle: "Udemy lecture",
            pageUrl: "https://www.udemy.com/course/example/learn/lecture/1",
            captionTracks: [],
            mediaCandidates: [],
          } },
          { frameId: 3, result: {
            found: true,
            pageTitle: "Udemy player",
            pageUrl: "https://player.example/lecture",
            media: { kind: "video", duration: 600, paused: false },
            captionTracks: [{
              source: "html_track_url",
              baseUrl: "https://cdn.example/lecture-en.vtt?token=signed",
              language: "en",
              label: "English",
              cues: [],
            }],
            mediaCandidates: [{ url: "blob:https://player.example/media", origin: "current_src" }],
          } },
        ];
      },
    },
    storage: { local: storage.area },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(`WEBVTT

00:00:01.000 --> 00:00:03.000
Welcome to the course

00:09:45.000 --> 00:09:50.000
Course conclusion
`, { status: 200, headers: { "content-type": "text/vtt" } });
    },
    getTargetTab: async () => ({
      id: 11,
      title: "Udemy lecture",
      url: "https://www.udemy.com/course/example/learn/lecture/1",
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://cdn.example/lecture-en.vtt?token=signed");
  assert.equal(requests[0].init.credentials, "include");
  assert.equal(result.sourceMethod, "html_track_url");
  assert.equal(result.model, null);
  assert.match(result.transcript, /Welcome to the course/);
  assert.equal(result.groqAttempted, false);
});

test("retries an authenticated Udemy caption inside its player frame when background fetch is denied", async () => {
  const storage = createMemoryStorage();
  const captionUrl = "https://mp4-c.udemycdn.com/captions/session-only.vtt?token=signed";
  let pageCaptionFetches = 0;
  let groqCalls = 0;
  const chromeApi = {
    scripting: {
      async executeScript(options) {
        if (Array.isArray(options.target?.frameIds)) {
          pageCaptionFetches += 1;
          assert.deepEqual(options.target, { tabId: 12, frameIds: [4] });
          assert.equal(options.args[0], captionUrl);
          return [{ result: {
            ok: true,
            status: 200,
            contentType: "text/vtt",
            body: `WEBVTT

00:00:00.000 --> 00:00:25.000
Authenticated Udemy opening

00:00:25.000 --> 00:00:59.000
Authenticated Udemy conclusion
`,
          } }];
        }
        return [{ frameId: 4, result: {
          found: true,
          pageTitle: "Authenticated Udemy lecture",
          pageUrl: "https://www.udemy.com/course/example/learn/lecture/12",
          durationSeconds: 60,
          captionTracks: [{
            source: "udemy_embedded_caption",
            baseUrl: captionUrl,
            language: "en",
            cues: [],
          }],
          mediaCandidates: [],
        } }];
      },
    },
    storage: { local: storage.area },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async (url) => {
      if (url === captionUrl) return new Response("login required", { status: 403 });
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") groqCalls += 1;
      throw new Error(`Unexpected request: ${url}`);
    },
    getTargetTab: async () => ({
      id: 12,
      title: "Authenticated Udemy lecture",
      url: "https://www.udemy.com/course/example/learn/lecture/12",
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.equal(pageCaptionFetches, 1);
  assert.equal(groqCalls, 0);
  assert.equal(result.sourceMethod, "udemy_embedded_caption");
  assert.match(result.transcript, /Authenticated Udemy conclusion/);
});

test("uses Gemini 3.5 Flash-Lite when no Groq key is configured", async () => {
  const storage = createMemoryStorage();
  await storage.area.set({ lumiGeminiThinkingLevel: "high" });
  const requests = [];
  const modelResult = {
    summary: "A concise summary.",
    language: "en",
    chapters: [
      { start: "00:00", end: "00:05", title: "Opening", summary: "Introduces the topic." },
    ],
    segments: [
      { start: "00:00", end: "00:05", speaker: "Narrator", text: "Opening statement" },
    ],
    importantSegments: [
      { start: "00:00", end: "00:05", title: "Opening", reason: "Introduces the topic" },
    ],
  };
  const chromeApi = {
    scripting: {
      async executeScript() {
        return [{ result: {
          found: true,
          pageTitle: "YouTube example",
          pageUrl: "https://www.youtube.com/watch?v=abc123",
          media: { kind: "video", duration: 600 },
          captionTracks: [],
          mediaCandidates: [{ url: "blob:https://www.youtube.com/id", origin: "current_src" }],
        } }];
      },
    },
    storage: { local: storage.area },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        outputs: [{ type: "text", content: [{ type: "text", text: JSON.stringify(modelResult) }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({ id: 8, title: "YouTube example", url: "https://www.youtube.com/watch?v=abc123" }),
    storageKey: "analyses",
  });
  const result = await service.analyze({ apiKey: "test-key", args: { action: "both", outputLanguage: "vi" } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, VIDEO_ANALYSIS_MODEL);
  assert.equal(VIDEO_ANALYSIS_THINKING_LEVEL, "minimal");
  assert.deepEqual(requests[0].body.generation_config, {
    thinking_level: "minimal",
    thinking_summaries: "none",
  });
  assert.equal(requests[0].body.input[0].uri, "https://www.youtube.com/watch?v=abc123");
  assert.equal(requests[0].body.input[0].resolution, "low");
  assert.equal(Object.hasOwn(requests[0].body.input[0], "mime_type"), false);
  assert.deepEqual(requests[0].body.response_format, {
    type: "text",
    mime_type: "application/json",
    schema: requests[0].body.response_format.schema,
  });
  assert.equal(requests[0].body.response_format.schema.type, "object");
  assert.equal(requests[0].body.response_format.schema.properties.chapters.minItems, 1);
  assert.match(requests[0].body.input[1].text, /context-aware editorial pass/i);
  assert.equal(result.sourceMethod, "youtube_url");
  assert.equal(result.groqAttempted, false);
  assert.equal(result.summary, "A concise summary.");
  assert.match(result.summaryMarkdown, /Nội dung theo từng phần/);
  assert.match(result.summaryMarkdown, /Từ 00:00 đến 00:05/);
  assert.match(result.transcriptDownload.text, /Opening statement/);
});

test("falls back from YouTube UMP directly to the public Gemini URL without a backend", async () => {
  const storage = createMemoryStorage();
  const youtubeUrl = "https://www.youtube.com/watch?v=ump-fallback";
  const umpUrl = "https://rr.example.googlevideo.com/videoplayback?id=ump-fallback&ump=1";
  const interactionRequests = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "YouTube UMP fallback",
            pageUrl: youtubeUrl,
            durationSeconds: 30,
            captionTracks: [],
            mediaCandidates: [{
              url: umpUrl,
              origin: "performance_resource",
              mimeType: "application/vnd.yt-ump",
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      if (url === umpUrl) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/vnd.yt-ump" },
        });
      }
      if (url.endsWith("/interactions")) {
        const request = JSON.parse(init.body);
        interactionRequests.push(request);
        return new Response(JSON.stringify({ outputText: JSON.stringify({
          language: "en",
          segments: [
            { start: "00:00", end: "00:15", speaker: "Speaker", text: "Gemini URL opening" },
            { start: "00:15", end: "00:30", speaker: "Speaker", text: "Gemini URL conclusion" },
          ],
          importantSegments: [],
        }) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    getTargetTab: async () => ({ id: 81, title: "YouTube UMP fallback", url: youtubeUrl }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.equal(interactionRequests.length, 1);
  assert.equal(interactionRequests[0].input[0].uri, youtubeUrl);
  assert.equal(result.sourceMethod, "youtube_url");
  assert.equal(result.groqAttempted, false);
  assert.equal(result.groqFallbackUsed, false);
  assert.equal(result.groqFallbackReason, "");
  assert.match(result.transcript, /Gemini URL conclusion/);
});

test("summarizes media directly without generating or caching an intermediate transcript", async () => {
  const storage = createMemoryStorage();
  const requests = [];
  let currentUrl = "https://www.youtube.com/watch?v=summary123";
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Chaptered video",
            pageUrl: currentUrl,
            media: { kind: "video", duration: 600 },
            captionTracks: [],
            mediaCandidates: [],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      return new Response(JSON.stringify({
        outputText: JSON.stringify({
          summary: "A concise overview.",
          language: "en",
          chapters: [
            { start: "00:00", end: "02:30", title: "Setup", summary: "Establishes the central problem." },
            { start: "02:30", end: "12:00", title: "Solution", summary: "Explains the proposed solution." },
          ],
          importantSegments: [],
        }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({
      id: 18,
      title: "Chaptered video",
      url: currentUrl,
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({ apiKey: "test-key", args: { action: "summary" } });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].response_format.schema.properties.chapters);
  assert.equal(requests[0].response_format.schema.properties.segments, undefined);
  assert.equal(requests[0].input[0].uri, currentUrl);
  assert.match(requests[0].input[1].text, /summary-only request/i);
  assert.doesNotMatch(requests[0].input[1].text, /Create a complete, readable transcript/i);
  assert.match(requests[0].input[1].text, /10:00 long \(600 seconds\)/i);
  assert.equal(Object.hasOwn(result, "transcript"), false);
  assert.equal(result.transcriptDownload, null);
  assert.equal(result.transcriptSourceQuality, null);
  assert.equal(result.chapters.length, 2);
  assert.equal(result.durationSeconds, 600);
  assert.match(result.summaryMarkdown, /From 02:30 to 10:00 — Solution:/);
  assert.equal(storage.state.analyses, undefined);

  const repeated = await service.analyze({ apiKey: "test-key", args: { action: "summary" } });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].input[0].uri, currentUrl);
  assert.equal(repeated.sourceMethod, "youtube_url");
  assert.equal(Object.hasOwn(repeated, "transcriptReused"), false);
  assert.equal(repeated.transcriptSourceQuality, null);

  currentUrl = "https://www.youtube.com/watch?v=different456";
  const differentVideo = await service.analyze({ apiKey: "test-key", args: { action: "summary" } });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].input[0].uri, currentUrl);
  assert.equal(differentVideo.sourceMethod, "youtube_url");
  assert.equal(Object.hasOwn(differentVideo, "transcriptReused"), false);
});

test("uses Groq Whisper for a timestamped transcript when a direct audio track is available", async () => {
  const storage = createMemoryStorage();
  storage.state.analyses = [{
    id: "old-gemini-analysis",
    pageTitle: "Uncaptioned lesson",
    pageUrl: "https://example.com/lesson",
    sourceMethod: "inline_media",
    transcript: "[00:00 - 24:19] Old inaccurate Gemini transcript",
    segments: [{
      start: "00:00",
      end: "24:19",
      speaker: "Speaker",
      text: "Old inaccurate Gemini transcript",
    }],
  }];
  const requests = [];
  const chromeApi = {
    scripting: {
      async executeScript() {
        return [{ result: {
          found: true,
          pageTitle: "Uncaptioned lesson",
          pageUrl: "https://example.com/lesson",
          durationSeconds: 18 * 60,
          media: { kind: "video", duration: 18 * 60 },
          captionTracks: [],
          mediaCandidates: [{
            url: "https://cdn.example.com/lesson.aac",
            origin: "current_src",
            mimeType: "audio/aac",
            contentLength: 2048,
          }],
        } }];
      },
    },
    storage: { local: storage.area },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
      assert.equal(init.headers.Authorization, "Bearer test-groq-key");
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("url"), "https://cdn.example.com/lesson.aac");
      assert.equal(init.body.get("file"), null);
      assert.equal(init.body.get("model"), GROQ_TRANSCRIPTION_MODEL);
      assert.equal(init.body.get("response_format"), "verbose_json");
      assert.equal(init.body.get("timestamp_granularities[]"), "segment");
      assert.equal(init.body.get("temperature"), "0");
      return new Response(JSON.stringify({
        language: "vi",
        duration: 18 * 60,
        text: "Má»Ÿ Ä‘áº§u. Káº¿t thÃºc.",
        segments: [
          { start: 0, end: 4.2, text: "Má»Ÿ Ä‘áº§u." },
          { start: 1075.4, end: 1080, text: "Káº¿t thÃºc." },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({
      id: 15,
      title: "Uncaptioned lesson",
      url: "https://example.com/lesson",
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.equal(requests.length, 1);
  assert.equal(result.sourceMethod, "groq_whisper");
  assert.equal(result.model, GROQ_TRANSCRIPTION_MODEL);
  assert.equal(result.transcriptModel, GROQ_TRANSCRIPTION_MODEL);
  assert.equal(result.transcriptSourceQuality, "groq_whisper");
  assert.equal(result.groqAttempted, true);
  assert.equal(result.groqFallbackUsed, false);
  assert.match(result.transcript, /\[17:55 - 18:00\] Káº¿t thÃºc\./);
  assert.doesNotMatch(result.transcript, /Old inaccurate Gemini transcript/);
  assert.equal(storage.state.analyses[0].transcriptModel, undefined);
});

test("switches immediately from Whisper Turbo to Whisper Large V3 on Groq rate limit", async () => {
  const storage = createMemoryStorage();
  const attemptedModels = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Groq model failover",
            pageUrl: "https://example.com/model-failover",
            durationSeconds: 20,
            captionTracks: [],
            mediaCandidates: [{
              url: "https://cdn.example.com/model-failover.mp3",
              origin: "current_src",
              mimeType: "audio/mpeg",
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
      assert.equal(init.body.get("url"), "https://cdn.example.com/model-failover.mp3");
      const model = init.body.get("model");
      attemptedModels.push(model);
      if (model === "whisper-large-v3-turbo") {
        return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "1" },
        });
      }
      return new Response(JSON.stringify({
        language: "en",
        duration: 20,
        segments: [{ start: 0, end: 20, text: "Large V3 transcript" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({ id: 21, title: "Groq failover", url: "https://example.com/model-failover" }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.deepEqual(attemptedModels, GROQ_TRANSCRIPTION_MODELS);
  assert.equal(result.transcriptModel, "whisper-large-v3");
  assert.equal(result.groqModelFallbackUsed, true);
  assert.equal(result.groqFallbackUsed, false);
  assert.match(result.transcript, /Large V3 transcript/);
});

test("treats any Groq failure as optional and summarizes audio directly with Gemini", async () => {
  const storage = createMemoryStorage();
  let requestCount = 0;
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Invalid Groq key",
            pageUrl: "https://example.com/invalid-key",
            durationSeconds: 10,
            captionTracks: [],
            mediaCandidates: [{
              url: "https://cdn.example.com/invalid-key.mp3",
              origin: "current_src",
              mimeType: "audio/mpeg",
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      requestCount += 1;
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
        return new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://cdn.example.com/invalid-key.mp3") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "content-length": "4" },
        });
      }
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
      const request = JSON.parse(init.body);
      assert.equal(request.response_format.schema.properties.segments, undefined);
      assert.match(request.input[1].text, /summary-only request/i);
      return new Response(JSON.stringify({ outputText: JSON.stringify({
        summary: "Gemini direct summary.",
        language: "en",
        chapters: [{ start: "00:00", end: "00:10", title: "Topic", summary: "Summarizes the audio directly." }],
        importantSegments: [],
      }) }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({ id: 22, title: "Invalid key", url: "https://example.com/invalid-key" }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "invalid-groq-key",
    args: { action: "summary" },
  });
  assert.equal(requestCount, 3);
  assert.equal(result.groqAttempted, true);
  assert.equal(result.groqFallbackUsed, true);
  assert.match(result.groqFallbackReason, /Invalid API Key/i);
  assert.equal(result.summary, "Gemini direct summary.");
  assert.equal(Object.hasOwn(result, "transcript"), false);
});

test("sends a YouTube URL directly to Gemini even when Groq is configured", async () => {
  const storage = createMemoryStorage();
  const youtubeUrl = "https://www.youtube.com/watch?v=direct-groq-audio";
  const audioUrl = "https://rr.example.googlevideo.com/videoplayback?id=direct-groq-audio&expire=9999999999";
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Direct YouTube audio",
            pageUrl: youtubeUrl,
            durationSeconds: 9,
            captionTracks: [{
              source: "html_text_track",
              language: "en",
              cues: [{ start: 0, end: 1, text: "Only a partial player cue" }],
            }],
            mediaCandidates: [{
              url: audioUrl,
              origin: "youtube_player_response",
              mimeType: "audio/webm",
              contentLength: 9000,
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
      const request = JSON.parse(init.body);
      assert.equal(request.input[0].uri, youtubeUrl);
      return new Response(JSON.stringify({ outputText: JSON.stringify({
        language: "en",
        segments: [{ start: "00:00", end: "00:09", speaker: "Speaker", text: "YouTube fast path transcript" }],
      }) }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({ id: 23, title: "YouTube", url: youtubeUrl }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.equal(result.groqAttempted, false);
  assert.equal(result.groqInputMethod, null);
  assert.match(result.transcript, /YouTube fast path transcript/);
});

test("does not download YouTube audio before direct Gemini URL transcription", async () => {
  const storage = createMemoryStorage();
  const youtubeUrl = "https://www.youtube.com/watch?v=extension-upload";
  const audioUrl = "https://rr.example.googlevideo.com/videoplayback?id=extension-upload&expire=9999999999";
  let groqRequests = 0;
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Extension upload",
            pageUrl: youtubeUrl,
            durationSeconds: 7,
            captionTracks: [],
            mediaCandidates: [{
              url: audioUrl,
              origin: "youtube_player_response",
              mimeType: "audio/webm",
              contentLength: 4,
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
      const request = JSON.parse(init.body);
      assert.equal(request.input[0].uri, youtubeUrl);
      return new Response(JSON.stringify({ outputText: JSON.stringify({
        language: "en",
        segments: [{ start: "00:00", end: "00:07", speaker: "Speaker", text: "Direct Gemini transcript" }],
      }) }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({ id: 24, title: "YouTube", url: youtubeUrl }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.equal(groqRequests, 0);
  assert.equal(result.groqAttempted, false);
  assert.equal(result.groqInputMethod, null);
  assert.match(result.transcript, /Direct Gemini transcript/);
});

test("uses the public Gemini URL without probing oversized YouTube audio", async () => {
  const storage = createMemoryStorage();
  const youtubeUrl = "https://www.youtube.com/watch?v=chunked-audio";
  const audioUrl = "https://googlevideo.example/audio.webm?expire=9999999999";
  const requestedUrls = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Chunked YouTube audio",
            pageUrl: youtubeUrl,
            durationSeconds: 20,
            captionTracks: [],
            mediaCandidates: [{
              url: audioUrl,
              origin: "youtube_player_response",
              mimeType: "audio/webm",
              contentLength: 21 * 1024 * 1024,
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      requestedUrls.push(url);
      assert.doesNotMatch(url, /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i);
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
        assert.equal(init.body.get("url"), audioUrl);
        return new Response(JSON.stringify({ error: { message: "Groq could not fetch this signed URL" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/interactions")) {
        const request = JSON.parse(init.body);
        assert.equal(request.model, VIDEO_ANALYSIS_MODEL);
        assert.equal(request.input[0].uri, youtubeUrl);
        return new Response(JSON.stringify({ outputText: JSON.stringify({
          language: "en",
          segments: [
            { start: "00:00", end: "00:10", speaker: "Speaker", text: "Gemini fallback opening" },
            { start: "00:10", end: "00:20", speaker: "Speaker", text: "Gemini fallback conclusion" },
          ],
          importantSegments: [],
        }) }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${init.method || "GET"} ${url}`);
    },
    getTargetTab: async () => ({ id: 23, title: "YouTube", url: youtubeUrl }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.deepEqual(requestedUrls, [
    "https://generativelanguage.googleapis.com/v1beta/interactions",
  ]);
  assert.equal(result.sourceMethod, "youtube_url");
  assert.equal(result.groqAttempted, false);
  assert.equal(result.groqFallbackUsed, false);
  assert.equal(result.groqFallbackReason, "");
  assert.match(result.transcript, /Gemini fallback conclusion/);
});

test("builds a summary from complete page captions before calling Groq", async () => {
  const storage = createMemoryStorage();
  const requests = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Caption-first summary",
            pageUrl: "https://example.com/caption-summary",
            durationSeconds: 30,
            captionTracks: [{
              source: "html_text_track",
              language: "en",
              cues: [{ start: 0, end: 30, text: "Authoritative page caption" }],
            }],
            mediaCandidates: [{
              url: "https://cdn.example.com/caption-summary.mp3",
              origin: "current_src",
              mimeType: "audio/mpeg",
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      requests.push(url);
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
        throw new Error("Groq must not run when complete captions are available.");
      }
      const request = JSON.parse(init.body);
      assert.match(request.input[0].text, /Authoritative page caption/);
      return new Response(JSON.stringify({
        outputText: JSON.stringify({
          summary: "Summary based on page captions.",
          language: "en",
          chapters: [{ start: "00:00", end: "00:30", title: "Topic", summary: "The transcript's main point." }],
          importantSegments: [],
        }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({ id: 24, title: "Caption summary", url: "https://example.com/caption-summary" }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "summary", outputLanguage: "en" },
  });
  assert.deepEqual(requests, ["https://generativelanguage.googleapis.com/v1beta/interactions"]);
  assert.equal(result.sourceMethod, "html_text_track");
  assert.equal(result.transcriptModel, null);
  assert.equal(storage.state.analyses, undefined);
});

test("falls back to Gemini transcription only after both Groq Whisper models are limited", async () => {
  const storage = createMemoryStorage();
  const requestedUrls = [];
  const pageUrl = "https://example.com/fallback-video";
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Fallback video",
            pageUrl,
            durationSeconds: 30,
            captionTracks: [],
            mediaCandidates: [{
              url: "https://cdn.example.com/fallback.aac",
              origin: "youtube_player_response",
              mimeType: "audio/aac",
              contentLength: 4,
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      requestedUrls.push(url);
      if (url === "https://cdn.example.com/fallback.aac") {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/aac" },
        });
      }
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
        const model = init.body.get("model");
        assert.ok(GROQ_TRANSCRIPTION_MODELS.includes(model));
        return new Response(JSON.stringify({ error: { message: `${model} rate limit reached` } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "1" },
        });
      }
      const request = JSON.parse(init.body);
      assert.equal(request.input[0].type, "audio");
      assert.equal(request.input[0].mime_type, "audio/aac");
      return new Response(JSON.stringify({
        outputText: JSON.stringify({
          language: "en",
          segments: [{ start: "00:00", end: "00:30", speaker: "Narrator", text: "Fallback transcript" }],
        }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({ id: 16, title: "Fallback video", url: pageUrl }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "limited-groq-key",
    args: { action: "transcript" },
  });
  assert.deepEqual(requestedUrls, [
    "https://api.groq.com/openai/v1/audio/transcriptions",
    "https://api.groq.com/openai/v1/audio/transcriptions",
    "https://cdn.example.com/fallback.aac",
    "https://generativelanguage.googleapis.com/v1beta/interactions",
  ]);
  assert.equal(result.sourceMethod, "inline_media");
  assert.equal(result.groqAttempted, true);
  assert.equal(result.groqFallbackUsed, true);
  assert.deepEqual(result.groqModelsAttempted, GROQ_TRANSCRIPTION_MODELS);
  assert.equal(result.groqModelFallbackUsed, true);
  assert.match(result.groqFallbackReason, /Both Groq Whisper models/i);
  assert.match(result.transcript, /Fallback transcript/);
});

test("gives the Live agent only the complete timestamped summary presentation", () => {
  const result = prepareVideoAnalysisAgentResult({
    success: true,
    summary: "A short summary that must not replace the timeline.",
    summaryMarkdown: "## Nội dung theo từng phần\n\n- **Từ 00:00 đến 00:15 — Mở đầu:** Giới thiệu chủ đề.",
    chapters: [{ start: "00:00", end: "00:15", title: "Mở đầu", summary: "Giới thiệu chủ đề." }],
    importantSegments: [],
    transcriptDownload: { text: "private download payload" },
  }, { action: "summary" });
  assert.match(result.presentationMarkdown, /Từ 00:00 đến 00:15/);
  assert.match(result.presentationInstruction, /rendered directly/i);
  assert.equal(Object.hasOwn(result, "summary"), false);
  assert.equal(Object.hasOwn(result, "summaryMarkdown"), false);
  assert.equal(Object.hasOwn(result, "chapters"), false);
  assert.equal(Object.hasOwn(result, "transcriptDownload"), false);
});

test("binds Facebook media to the visible playing Reel when the SPA address bar is stale", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  try {
    const staleId = "1111111111111111";
    const activeId = "2222222222222222";
    const activeAudioUrl = "https://scontent.example.fbcdn.net/o1/v/active-audio.mp4?token=active";
    const manifestXml = `<MPD><Period><AdaptationSet><Representation id="audio" mimeType="audio/mp4"><BaseURL>${activeAudioUrl}</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const pageData = JSON.stringify({ video: { id: activeId, dash_manifest: manifestXml } });
    const makePlayer = ({ id, paused, rect }) => ({
      attributes: [{ name: "data-video-id", value: id }],
      parentElement: null,
      readyState: 4,
      paused,
      ended: false,
      duration: 30,
      currentTime: 2,
      currentSrc: `blob:https://www.facebook.com/${id}`,
      src: "",
      poster: "",
      textTracks: [],
      tagName: "VIDEO",
      getBoundingClientRect() { return rect; },
      getAttribute() { return ""; },
      querySelectorAll() { return []; },
    });
    const stalePlayer = makePlayer({
      id: staleId,
      paused: true,
      rect: { top: -900, right: 540, bottom: -100, left: 0, width: 540, height: 800 },
    });
    const activePlayer = makePlayer({
      id: activeId,
      paused: false,
      rect: { top: 0, right: 540, bottom: 900, left: 0, width: 540, height: 900 },
    });
    globalThis.document = {
      title: "Facebook Reels",
      documentElement: { clientWidth: 1200, clientHeight: 900 },
      querySelectorAll(selector) {
        if (selector === "video, audio") return [stalePlayer, activePlayer];
        if (selector.startsWith("script[")) return [{ textContent: pageData }];
        return [];
      },
      querySelector() { return null; },
    };
    globalThis.location = {
      href: `https://www.facebook.com/reel/${staleId}`,
      origin: "https://www.facebook.com",
      hostname: "www.facebook.com",
      pathname: `/reel/${staleId}`,
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    const source = await collectVideoAnalysisSourceInPage();
    assert.equal(source.pageFacebookVideoId, staleId);
    assert.equal(source.selectedElementFacebookVideoId, activeId);
    assert.equal(source.facebookVideoId, activeId);
    assert.equal(source.facebookPlayerIdentityMismatch, true);
    assert.equal(source.mediaCandidates.find((candidate) => candidate.mimeType === "audio/mp4")?.url, activeAudioUrl);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
  }
});

test("probes the exact Facebook permalink when the scrolling feed has no bound audio", async () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousPerformance = globalThis.performance;
  const previousHtmlMediaElement = globalThis.HTMLMediaElement;
  const previousDomParser = globalThis.DOMParser;
  const previousFetch = globalThis.fetch;
  try {
    const targetId = "3333333333333333";
    const audioUrl = "https://scontent.example.fbcdn.net/o1/v/permalink-audio.mp4?token=exact";
    const manifestXml = `<MPD><Period><AdaptationSet><Representation id="audio" mimeType="audio/mp4"><BaseURL>${audioUrl}</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const permalinkPayload = JSON.stringify({ payload: { video: { id: targetId, dash_manifest: manifestXml } } });
    globalThis.document = {
      title: "Facebook Reels",
      querySelectorAll() { return []; },
      querySelector() { return null; },
    };
    globalThis.location = {
      href: "https://www.facebook.com/reels/",
      origin: "https://www.facebook.com",
      hostname: "www.facebook.com",
      pathname: "/reels/",
    };
    globalThis.performance = { getEntriesByType() { return []; } };
    globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
    globalThis.DOMParser = class {
      parseFromString() {
        return { querySelectorAll() { return [{ textContent: permalinkPayload }]; } };
      }
    };
    globalThis.fetch = async (url, init) => {
      assert.equal(url, `https://www.facebook.com/reel/${targetId}/`);
      assert.equal(init.credentials, "include");
      return new Response("<html></html>", { status: 200 });
    };
    const source = await collectVideoAnalysisSourceInPage(targetId);
    assert.equal(source.facebookVideoId, targetId);
    assert.equal(source.facebookPermalinkProbeUsed, true);
    assert.equal(source.pageUrl, `https://www.facebook.com/reel/${targetId}/`);
    const audio = source.mediaCandidates.find((candidate) => candidate.mimeType === "audio/mp4");
    assert.equal(audio?.url, audioUrl);
    assert.equal(audio?.origin, "facebook_permalink_dash_manifest");
    assert.equal(audio?.identityEvidence, "facebook_permalink_payload");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousPerformance === undefined) delete globalThis.performance;
    else globalThis.performance = previousPerformance;
    if (previousHtmlMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = previousHtmlMediaElement;
    if (previousDomParser === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = previousDomParser;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});

test("keeps the full transcript out of agent and task-history state", () => {
  const result = prepareVideoAnalysisAgentResult({
    success: true,
    transcript: "[00:00 - 00:10] Complete private transcript payload",
    transcriptDownload: { text: "Complete private transcript payload" },
    transcriptCharacterCount: 43,
  }, { action: "transcript" });
  assert.equal(result.transcriptAvailable, true);
  assert.equal(Object.hasOwn(result, "transcript"), false);
  assert.equal(Object.hasOwn(result, "transcriptDownload"), false);
  assert.match(result.presentationInstruction, /Download transcript card/i);
});

test("immediately fails over on temporary model capacity errors but retries 3.5 on a new prompt", async () => {
  const storage = createMemoryStorage();
  const requestedModels = [];
  const requestedThinkingLevels = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Failover video",
            pageUrl: "https://www.youtube.com/watch?v=failover123",
            media: { kind: "video", duration: 120 },
            captionTracks: [],
            mediaCandidates: [],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      requestedModels.push(request.model);
      requestedThinkingLevels.push(request.generation_config?.thinking_level);
      if (requestedModels.length === 1) {
        return new Response(JSON.stringify({
          error: {
            code: 503,
            status: "UNAVAILABLE",
            message: "gemini-3.5-flash-lite is currently experiencing high demand, spikes in demand are usually temporary. Please try again later.",
          },
        }), { status: 503, headers: { "content-type": "application/json" } });
      }
      const isTranscriptPass = Boolean(request.response_format.schema.properties.segments);
      return new Response(JSON.stringify({
        outputText: JSON.stringify(isTranscriptPass
          ? {
              language: "en",
              segments: [{ start: "00:00", end: "02:00", speaker: "Narrator", text: "The video was analyzed." }],
            }
          : {
              summary: "Failover succeeded.",
              language: "en",
              chapters: [{ start: "00:00", end: "02:00", title: "Complete video", summary: "Explains the video's main idea." }],
              importantSegments: [],
            }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({
      id: 19,
      title: "Failover video",
      url: "https://www.youtube.com/watch?v=failover123",
    }),
    storageKey: "analyses",
  });

  const first = await service.analyze({ apiKey: "test-key", args: { action: "summary" } });
  const second = await service.analyze({ apiKey: "test-key", args: { action: "summary" } });

  assert.deepEqual(VIDEO_ANALYSIS_MODELS, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  assert.deepEqual(requestedModels, [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
  ]);
  assert.deepEqual(requestedThinkingLevels, requestedModels.map(() => "minimal"));
  assert.equal(first.model, "gemini-3.1-flash-lite");
  assert.deepEqual(first.modelAttempts, VIDEO_ANALYSIS_MODELS);
  assert.equal(first.modelFallbackUsed, true);
  assert.equal(second.model, "gemini-3.5-flash-lite");
  assert.deepEqual(second.modelAttempts, ["gemini-3.5-flash-lite"]);
  assert.equal(second.modelFallbackUsed, false);
});

test("classifies overload as failover-safe without masking authentication errors", () => {
  assert.equal(isGeminiModelCapacityError({
    httpStatus: 503,
    geminiStatus: "UNAVAILABLE",
    message: "The model is currently experiencing high demand.",
  }), true);
  assert.equal(isGeminiModelCapacityError({
    httpStatus: 401,
    geminiStatus: "UNAUTHENTICATED",
    message: "API key not valid.",
  }), false);
});

test("reports an error only after both video models are unavailable", async () => {
  const storage = createMemoryStorage();
  const requestedModels = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Limited video",
            pageUrl: "https://www.youtube.com/watch?v=limited123",
            media: { kind: "video", duration: 120 },
            captionTracks: [],
            mediaCandidates: [],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      requestedModels.push(request.model);
      return new Response(JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: `${request.model} RPM quota exceeded.`,
        },
      }), { status: 429, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({
      id: 20,
      title: "Limited video",
      url: "https://www.youtube.com/watch?v=limited123",
    }),
    storageKey: "analyses",
  });

  await assert.rejects(
    service.analyze({ apiKey: "test-key", args: { action: "summary" } }),
    (error) => {
      assert.equal(error.code, "ALL_VIDEO_MODELS_UNAVAILABLE");
      assert.deepEqual(error.models, VIDEO_ANALYSIS_MODELS);
      assert.match(error.message, /Both Gemini video models are currently rate-limited or temporarily overloaded/);
      return true;
    },
  );
  assert.deepEqual(requestedModels, VIDEO_ANALYSIS_MODELS);
});

test("always isolates a supplied Facebook Reel URL in a grouped temporary background tab", async () => {
  const storage = createMemoryStorage();
  const targetId = "5555555555555555";
  const audioUrl = "https://scontent.fbcdn.net/o1/v/isolated-audio.mp4?token=signed";
  const createdTabs = [];
  const preparedTabs = [];
  const removedTabs = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript({ target }) {
          assert.equal(target.tabId, 91);
          return [{ frameId: 0, result: {
            found: true,
            pageTitle: "Isolated Facebook Reel",
            pageUrl: `https://www.facebook.com/reel/${targetId}`,
            facebookVideoId: targetId,
            facebookMediaIdentityVerified: true,
            captionTracks: [],
            mediaCandidates: [{
              url: audioUrl,
              origin: "facebook_permalink_dash_manifest",
              mimeType: "audio/mp4",
              facebookVideoId: targetId,
              identityVerified: true,
            }],
          } }];
        },
      },
      storage: { local: storage.area },
      tabs: {
        async create(properties) {
          createdTabs.push(properties);
          return {
            id: 91,
            status: "complete",
            title: "Isolated Facebook Reel",
            url: properties.url,
          };
        },
        async remove(tabId) { removedTabs.push(tabId); },
      },
    },
    fetchImpl: async () => { throw new Error("An audio-link request must not download media."); },
    getTargetTab: async () => ({
      id: 10,
      windowId: 7,
      title: "Same Facebook Reel in a long-lived feed tab",
      url: `https://www.facebook.com/reel/${targetId}`,
    }),
    prepareTemporaryTab: async (tab, context) => {
      preparedTabs.push({ tabId: tab.id, sourceUrl: context.sourceUrl });
    },
    storageKey: "analyses",
  });
  const result = await service.analyze({
    args: { action: "audio", url: `https://www.facebook.com/reel/${targetId}` },
  });
  assert.deepEqual(createdTabs, [{
    url: `https://www.facebook.com/reel/${targetId}`,
    active: false,
    windowId: 7,
  }]);
  assert.deepEqual(preparedTabs, [{
    tabId: 91,
    sourceUrl: `https://www.facebook.com/reel/${targetId}`,
  }]);
  assert.deepEqual(removedTabs, [91]);
  assert.equal(result.sourcePageOpened, true);
  assert.equal(result.sourcePageClosedAfterAnalysis, true);
  assert.equal(result.audioUrl, audioUrl);
});

test("closes the temporary Facebook tab when Agent Space preparation fails", async () => {
  const storage = createMemoryStorage();
  const targetId = "6666666666666666";
  const removedTabs = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          throw new Error("Source discovery must not start before Agent Space preparation.");
        },
      },
      storage: { local: storage.area },
      tabs: {
        async create(properties) {
          return { id: 96, status: "complete", url: properties.url };
        },
        async remove(tabId) { removedTabs.push(tabId); },
      },
    },
    getTargetTab: async () => ({
      id: 10,
      windowId: 7,
      title: "Facebook Reels feed",
      url: `https://www.facebook.com/reel/${targetId}`,
    }),
    prepareTemporaryTab: async () => {
      throw new Error("Agent Space grouping failed");
    },
    storageKey: "analyses",
  });

  await assert.rejects(
    service.analyze({ args: { action: "audio", url: `https://www.facebook.com/reel/${targetId}` } }),
    /Agent Space grouping failed/,
  );
  assert.deepEqual(removedTabs, [96]);
});

test("retries the active Facebook Reel in place without creating or reloading a tab", async () => {
  const storage = createMemoryStorage();
  const targetId = "1554671672755534";
  const audioUrl = "https://scontent.fbcdn.net/o1/v/fresh-reel-audio.mp4?token=signed";
  let sourceAttempts = 0;
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript({ target }) {
          sourceAttempts += 1;
          assert.equal(target.tabId, 90);
          return [{ result: {
            found: true,
            pageTitle: "Exact Facebook Reel",
            pageUrl: `https://www.facebook.com/reel/${targetId}`,
            facebookVideoId: targetId,
            facebookMediaIdentityVerified: true,
            captionTracks: [],
            mediaCandidates: sourceAttempts > 1 ? [{
              url: audioUrl,
              origin: "facebook_dash_manifest",
              mimeType: "audio/mp4",
              facebookVideoId: targetId,
              identityVerified: true,
            }] : [],
          } }];
        },
      },
      storage: { local: storage.area },
      tabs: {
        async create() { throw new Error("Facebook analysis must not create a tab."); },
        async reload() { throw new Error("Facebook analysis must not reload the active tab."); },
        async remove() { throw new Error("Facebook analysis must not close the active tab."); },
      },
    },
    fetchImpl: async () => { throw new Error("The audio action must not fetch media."); },
    getTargetTab: async () => ({
      id: 90,
      title: "Exact Facebook Reel",
      url: `https://www.facebook.com/reel/${targetId}`,
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({ args: { action: "audio" } });
  assert.equal(sourceAttempts, 2);
  assert.equal(result.sourcePageTabId, 90);
  assert.equal(result.sourcePageOpened, false);
  assert.equal(result.sourcePageClosedAfterAnalysis, false);
  assert.equal(result.audioUrl, audioUrl);
  assert.equal(result.audioTabId, null);
});

test("uses an exact Facebook Reel caption track before its Groq audio fallback", async () => {
  const storage = createMemoryStorage();
  const targetId = "1554671672755534";
  const captionUrl = "https://scontent.fbcdn.net/captions/reel-en.vtt?token=signed";
  let groqCalls = 0;
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ frameId: 0, result: {
            found: true,
            pageTitle: "Captioned Facebook Reel",
            pageUrl: `https://www.facebook.com/reel/${targetId}`,
            facebookVideoId: targetId,
            facebookMediaIdentityVerified: true,
            durationSeconds: 20,
            captionTracks: [{
              source: "facebook_caption_url",
              baseUrl: captionUrl,
              facebookVideoId: targetId,
              identityVerified: true,
              language: "en",
              cues: [],
            }],
            mediaCandidates: [{
              url: "https://scontent.fbcdn.net/o1/v/reel-audio.mp4?token=signed",
              origin: "facebook_dash_manifest",
              mimeType: "audio/mp4",
              facebookVideoId: targetId,
              identityVerified: true,
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url) => {
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
        groqCalls += 1;
        throw new Error("Groq must not run when exact Reel captions are complete.");
      }
      assert.equal(url, captionUrl);
      return new Response(`WEBVTT

00:00:00.000 --> 00:00:08.000
Facebook Reel opening

00:00:08.000 --> 00:00:19.000
Facebook Reel conclusion
`, { status: 200, headers: { "content-type": "text/vtt" } });
    },
    getTargetTab: async () => ({
      id: 92,
      title: "Captioned Facebook Reel",
      url: `https://www.facebook.com/reel/${targetId}`,
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.equal(groqCalls, 0);
  assert.equal(result.sourceMethod, "facebook_caption_url");
  assert.equal(result.groqAttempted, false);
  assert.match(result.transcript, /Facebook Reel conclusion/);
});

test("transcribes an exact Facebook Reel audio URL with Groq when captions are absent", async () => {
  const storage = createMemoryStorage();
  const targetId = "1554671672755534";
  const audioUrl = "https://scontent.fbcdn.net/o1/v/reel-audio.mp4?token=signed";
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ frameId: 0, result: {
            found: true,
            pageTitle: "Uncaptioned Facebook Reel",
            pageUrl: `https://www.facebook.com/reel/${targetId}`,
            facebookVideoId: targetId,
            facebookMediaIdentityVerified: true,
            durationSeconds: 18,
            captionTracks: [],
            mediaCandidates: [{
              url: audioUrl,
              origin: "facebook_dash_manifest",
              mimeType: "audio/mp4",
              facebookVideoId: targetId,
              identityVerified: true,
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
      assert.equal(init.body.get("url"), audioUrl);
      return new Response(JSON.stringify({
        language: "vi",
        duration: 18,
        segments: [{ start: 0, end: 18, text: "Nội dung Reel từ Groq" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({
      id: 93,
      title: "Uncaptioned Facebook Reel",
      url: `https://www.facebook.com/reel/${targetId}`,
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.equal(result.sourceMethod, "groq_whisper");
  assert.equal(result.groqInputMethod, "audio_url");
  assert.match(result.transcript, /Nội dung Reel từ Groq/);
});

test("tries another verified Facebook audio representation when the first signed URL expires", async () => {
  const storage = createMemoryStorage();
  const targetId = "1554671672755534";
  const expiredAudioUrl = "https://scontent.fbcdn.net/o1/v/reel-audio-old.mp4?token=expired";
  const workingAudioUrl = "https://scontent.fbcdn.net/o1/v/reel-audio-new.mp4?token=fresh";
  const groqUrlAttempts = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ frameId: 0, result: {
            found: true,
            pageTitle: "Facebook Reel with alternate audio",
            pageUrl: `https://www.facebook.com/reel/${targetId}`,
            facebookVideoId: targetId,
            facebookMediaIdentityVerified: true,
            durationSeconds: 18,
            captionTracks: [],
            mediaCandidates: [expiredAudioUrl, workingAudioUrl].map((url, index) => ({
              url,
              origin: "facebook_dash_manifest",
              mimeType: "audio/mp4",
              facebookVideoId: targetId,
              identityVerified: true,
              startTime: 2 - index,
            })),
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
        const audioUrl = init.body.get("url");
        groqUrlAttempts.push(audioUrl);
        if (audioUrl === expiredAudioUrl) {
          return new Response(JSON.stringify({ error: { message: "audio URL expired" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        assert.equal(audioUrl, workingAudioUrl);
        return new Response(JSON.stringify({
          language: "vi",
          duration: 18,
          segments: [{ start: 0, end: 18, text: "Alternate Facebook audio works" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(url, expiredAudioUrl);
      return new Response("expired", { status: 403 });
    },
    getTargetTab: async () => ({
      id: 94,
      title: "Facebook Reel with alternate audio",
      url: `https://www.facebook.com/reel/${targetId}`,
    }),
    storageKey: "analyses",
  });

  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.deepEqual(groqUrlAttempts, [expiredAudioUrl, workingAudioUrl]);
  assert.equal(result.sourceMethod, "groq_whisper");
  assert.match(result.transcript, /Alternate Facebook audio works/);
});

test("retries Facebook source discovery while a newly selected Reel is settling", async () => {
  const storage = createMemoryStorage();
  const targetId = "1554671672755534";
  let sourceAttempts = 0;
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          sourceAttempts += 1;
          const ready = sourceAttempts > 1;
          return [{ frameId: 0, result: {
            found: true,
            pageTitle: "Facebook Reel",
            pageUrl: `https://www.facebook.com/reel/${targetId}`,
            facebookVideoId: targetId,
            facebookMediaIdentityVerified: true,
            captionTracks: [],
            mediaCandidates: ready ? [{
              url: "https://scontent.fbcdn.net/o1/v/current-audio.mp4",
              origin: "facebook_dash_manifest",
              mimeType: "audio/mp4",
              facebookVideoId: targetId,
              identityVerified: true,
            }] : [{
              url: "https://scontent.fbcdn.net/o1/v/current-video.mp4",
              origin: "current_src",
              mimeType: "video/mp4",
              facebookVideoId: targetId,
              identityVerified: true,
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      if (/fbcdn\.net/.test(url)) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mp4", "content-length": "4" },
        });
      }
      if (url.endsWith("/interactions")) {
        const request = JSON.parse(init.body);
        assert.ok(request.response_format.schema.properties.chapters);
        assert.equal(request.response_format.schema.properties.segments, undefined);
        assert.match(request.input[1].text, /summary-only request/i);
        return new Response(JSON.stringify({
          outputText: JSON.stringify({
            summary: "Reel overview.",
            language: "vi",
            chapters: [{
              start: "00:00",
              end: "00:03",
              title: "Mở đầu",
              summary: "Giới thiệu nội dung chính.",
            }],
            importantSegments: [],
          }),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url} ${init.method || "GET"}`);
    },
    getTargetTab: async () => ({
      id: 21,
      title: "Facebook Reel",
      url: `https://www.facebook.com/reel/${targetId}`,
    }),
    storageKey: "analyses",
    remuxMp4AudioImpl: async (blob) => blob.slice(0, blob.size, "audio/aac"),
  });

  const result = await service.analyze({ apiKey: "test-key", args: { action: "summary" } });
  assert.equal(sourceAttempts, 2);
  assert.equal(result.facebookVideoId, targetId);
  assert.equal(result.mediaIdentityVerified, true);
  assert.equal(result.summary, "Reel overview.");
  assert.equal(result.transcriptDownload, null);
  assert.equal(Object.hasOwn(result, "transcript"), false);
  assert.equal(storage.state.analyses, undefined);
});

test("requires two observations of the same Facebook player before accepting its audio", async () => {
  const storage = createMemoryStorage();
  const targetId = "4444444444444444";
  const staleAudioUrl = "https://scontent.fbcdn.net/o1/v/stale-player-audio.mp4";
  const stableAudioUrl = "https://scontent.fbcdn.net/o1/v/stable-player-audio.mp4";
  let sourceAttempts = 0;
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          sourceAttempts += 1;
          const stablePlayer = sourceAttempts > 1;
          return [{ frameId: 0, result: {
            found: true,
            pageTitle: "Facebook Reel",
            pageUrl: `https://www.facebook.com/reel/${targetId}`,
            facebookVideoId: targetId,
            activePlayerToken: stablePlayer ? "player-b" : "player-a",
            facebookMediaIdentityVerified: true,
            captionTracks: [],
            mediaCandidates: [{
              url: stablePlayer ? stableAudioUrl : staleAudioUrl,
              origin: "facebook_dash_manifest",
              mimeType: "audio/mp4",
              facebookVideoId: targetId,
              identityVerified: true,
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async () => { throw new Error("An audio-link request must not download the candidate."); },
    getTargetTab: async () => ({
      id: 22,
      title: "Facebook Reel",
      url: `https://www.facebook.com/reel/${targetId}`,
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({ args: { action: "audio" } });
  assert.equal(sourceAttempts, 3);
  assert.equal(result.audioUrl, stableAudioUrl);
});

test("accepts exact Facebook prefetch audio on the first source scan", async () => {
  const storage = createMemoryStorage();
  const targetId = "7777777777777777";
  const exactAudioUrl = "https://scontent.fbcdn.net/o1/v/exact-prefetch-audio.mp4?token=signed";
  let sourceAttempts = 0;
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript({ target }) {
          assert.equal(target.tabId, 24);
          sourceAttempts += 1;
          return [{ frameId: 0, result: {
            found: true,
            pageTitle: "Facebook Reel",
            pageUrl: `https://www.facebook.com/reel/${targetId}`,
            facebookVideoId: targetId,
            selectedElementFacebookVideoId: targetId,
            activePlayerToken: `video:${targetId}`,
            facebookMediaIdentityVerified: true,
            captionTracks: [],
            mediaCandidates: [{
              url: exactAudioUrl,
              origin: "facebook_dash_prefetch_representation",
              mimeType: "audio/mp4",
              facebookVideoId: targetId,
              identityVerified: true,
              identityEvidence: "facebook_video_id_prefetch",
            }],
          } }];
        },
      },
      storage: { local: storage.area },
      tabs: {
        async create(properties) {
          return { id: 24, status: "complete", title: "Facebook Reel", url: properties.url };
        },
        async remove() {},
      },
    },
    fetchImpl: async () => { throw new Error("An audio-link request must not download the candidate."); },
    getTargetTab: async () => ({
      id: 23,
      title: "Facebook Reel",
      url: `https://www.facebook.com/reel/${targetId}`,
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    args: { action: "audio", url: `https://www.facebook.com/reel/${targetId}` },
  });
  assert.equal(sourceAttempts, 1);
  assert.equal(result.audioUrl, exactAudioUrl);
});

test("remuxes a small Facebook MP4 audio container to inline AAC for Gemini", async () => {
  const storage = createMemoryStorage();
  await storage.area.set({ analyses: [{
    id: "legacy-poisoned-cache",
    pageUrl: "https://www.facebook.com/reel/1554671672755534",
    videoIdentity: "facebook:1554671672755534",
    transcript: "Wrong cached transcript\n\n[00:00 - 00:03] Wrong Reel",
    segments: [{ start: "00:00", end: "00:03", speaker: "Speaker", text: "Wrong Reel" }],
  }] });
  const calls = [];
  const modelResult = {
    summary: "",
    language: "vi",
    segments: [{ start: "00:00", end: "00:03", speaker: "Speaker", text: "Xin chào" }],
    importantSegments: [],
  };
  const chromeApi = {
    scripting: {
      async executeScript() {
        return [{ frameId: 0, result: {
          found: true,
          pageTitle: "Facebook Reel",
          pageUrl: "https://www.facebook.com/reel/1554671672755534",
          facebookVideoId: "1554671672755534",
          facebookMediaIdentityVerified: true,
          media: { kind: "video", duration: 60, paused: true },
          captionTracks: [],
          mediaCandidates: [
            { url: "https://video.xx.fbcdn.net/reel.mp4?mime_type=video_mp4", origin: "facebook_dash_manifest", facebookVideoId: "1554671672755534", identityVerified: true },
            { url: "https://video.xx.fbcdn.net/reel.mp4?mime_type=audio_mp4", origin: "facebook_dash_manifest", facebookVideoId: "1554671672755534", identityVerified: true },
          ],
        } }];
      },
    },
    storage: { local: storage.area },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (/fbcdn\.net/.test(url)) {
        assert.match(url, /audio_mp4/);
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mp4", "content-length": "4" },
        });
      }
      if (url.includes("/upload/v1beta/files")) {
        assert.equal(init.headers["x-goog-upload-header-content-type"], "video/mp4");
        return new Response("{}", {
          status: 200,
          headers: { "x-goog-upload-url": "https://upload.example/media" },
        });
      }
      if (url === "https://upload.example/media") {
        return new Response(JSON.stringify({
          file: {
            name: "files/facebook-audio",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/facebook-audio",
            mimeType: "video/mp4",
            state: "ACTIVE",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/interactions")) {
        const request = JSON.parse(init.body);
        assert.equal(request.input[0].type, "audio");
        assert.equal(request.input[0].mime_type, "audio/aac");
        assert.equal(request.input[0].data, "AQIDBA==");
        assert.equal(Object.hasOwn(request.input[0], "uri"), false);
        assert.equal(request.response_format.schema.properties.chapters, undefined);
        assert.match(request.input[1].text, /context-aware editorial pass/i);
        assert.match(request.input[1].text, /\[không rõ\]/i);
        assert.equal(request.response_format.mime_type, "application/json");
        return new Response(JSON.stringify({
          steps: [
            { type: "user_input", content: [{ type: "text", text: "Do not parse this" }] },
            { type: "model_output", content: [{ type: "text", text: JSON.stringify(modelResult) }] },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (/files\/facebook-audio$/.test(url) && init.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    getTargetTab: async () => ({
      id: 10,
      title: "Facebook Reel",
      url: "https://www.facebook.com/reel/1554671672755534",
    }),
    storageKey: "analyses",
    remuxMp4AudioImpl: async (blob) => blob.slice(0, blob.size, "audio/aac"),
  });
  const result = await service.analyze({ apiKey: "test-key", args: { action: "transcript" } });
  assert.equal(result.sourceMethod, "inline_media");
  assert.equal(result.facebookVideoId, "1554671672755534");
  assert.equal(result.mediaIdentityVerified, true);
  assert.equal(Object.hasOwn(result, "transcriptReused"), false);
  assert.equal(result.uploadedMediaDeleted, false);
  assert.match(result.transcript, /Xin chào/);
  assert.equal(calls.filter((call) => call.url.endsWith("/interactions")).length, 1);
  assert.equal(calls.some((call) => call.url.includes("/upload/v1beta/files")), false);
  assert.equal(storage.state.analyses.length, 1);
  assert.match(storage.state.analyses[0].transcript, /Wrong Reel/);
});

test("stops when the Facebook player Reel ID disagrees with the active tab", async () => {
  const storage = createMemoryStorage();
  let fetchCalled = false;
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ frameId: 0, result: {
            found: true,
            pageTitle: "Adjacent Reel",
            pageUrl: "https://www.facebook.com/reel/9999999999999999",
            facebookVideoId: "9999999999999999",
            facebookMediaIdentityVerified: true,
            captionTracks: [],
            mediaCandidates: [{
              url: "https://scontent.fbcdn.net/wrong-audio.mp4",
              origin: "facebook_dash_manifest",
              mimeType: "audio/mp4",
              facebookVideoId: "9999999999999999",
              identityVerified: true,
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("must not fetch mismatched Reel media");
    },
    getTargetTab: async () => ({
      id: 10,
      title: "Target Reel",
      url: "https://www.facebook.com/reel/1554671672755534",
    }),
    storageKey: "analyses",
  });
  await assert.rejects(
    service.analyze({ apiKey: "test-key", args: { action: "transcript" } }),
    /Facebook Reel changed/i,
  );
  assert.equal(fetchCalled, false);
  assert.equal(storage.state.analyses, undefined);
});

test("does not retry silent Facebook video representations after the dedicated audio track fails", async () => {
  const storage = createMemoryStorage();
  const requestedUrls = [];
  const chromeApi = {
    scripting: {
      async executeScript() {
        return [{ frameId: 0, result: {
          found: true,
          pageTitle: "Facebook Reel",
          pageUrl: "https://www.facebook.com/reel/1554671672755534",
          facebookVideoId: "1554671672755534",
          facebookMediaIdentityVerified: true,
          media: { kind: "video", duration: 1330, paused: true },
          captionTracks: [],
          mediaCandidates: [
            { url: "https://scontent.fbcdn.net/o1/v/video.mp4", origin: "facebook_dash_manifest", mimeType: "video/mp4", facebookVideoId: "1554671672755534", identityVerified: true },
            { url: "https://scontent.fbcdn.net/o1/v/audio.mp4", origin: "facebook_dash_manifest", mimeType: "audio/mp4", facebookVideoId: "1554671672755534", identityVerified: true },
          ],
        } }];
      },
    },
    storage: { local: storage.area },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      throw new Error("signed Facebook audio download failed");
    },
    getTargetTab: async () => ({
      id: 13,
      title: "Facebook Reel",
      url: "https://www.facebook.com/reel/1554671672755534",
    }),
    storageKey: "analyses",
  });
  await assert.rejects(
    service.analyze({ apiKey: "test-key", args: { action: "transcript" } }),
    /dedicated audio track[\s\S]+signed Facebook audio download failed/i,
  );
  assert.deepEqual(requestedUrls, ["https://scontent.fbcdn.net/o1/v/audio.mp4"]);
});

test("falls back from an unavailable Udemy caption URL to its audio URL and Groq", async () => {
  const storage = createMemoryStorage();
  const captionUrl = "https://mp4-c.udemycdn.com/captions/missing.vtt?token=expired";
  const audioUrl = "https://mp4-c.udemycdn.com/lecture/audio.m4a?token=signed";
  const requests = [];
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Udemy audio fallback",
            pageUrl: "https://www.udemy.com/course/example/learn/lecture/123456",
            durationSeconds: 45,
            captionTracks: [{
              source: "udemy_embedded_caption",
              baseUrl: captionUrl,
              language: "en",
              cues: [],
            }],
            mediaCandidates: [{
              url: audioUrl,
              origin: "udemy_embedded_media",
              mimeType: "audio/mp4",
            }],
          } }];
        },
      },
      storage: { local: storage.area },
    },
    fetchImpl: async (url, init = {}) => {
      requests.push(url);
      if (url === captionUrl) return new Response("expired", { status: 403 });
      assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
      assert.equal(init.body.get("url"), audioUrl);
      return new Response(JSON.stringify({
        language: "en",
        duration: 45,
        segments: [{ start: 0, end: 45, text: "Udemy transcript recovered from audio" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({
      id: 31,
      title: "Udemy audio fallback",
      url: "https://www.udemy.com/course/example/learn/lecture/123456",
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-gemini-key",
    groqApiKey: "test-groq-key",
    args: { action: "transcript" },
  });
  assert.deepEqual(requests, [captionUrl, "https://api.groq.com/openai/v1/audio/transcriptions"]);
  assert.equal(result.sourceMethod, "groq_whisper");
  assert.equal(result.groqInputMethod, "audio_url");
  assert.match(result.transcript, /Udemy transcript recovered from audio/);
});

test("assembles an unencrypted Udemy HLS audio rendition before transcription", async () => {
  const storage = createMemoryStorage();
  const requestedUrls = [];
  const chromeApi = {
    scripting: {
      async executeScript() {
        return [{ frameId: 2, result: {
          found: true,
          pageTitle: "Udemy lecture",
          pageUrl: "https://www.udemy.com/course/example/learn/lecture/2",
          media: { kind: "video", duration: 600, paused: false },
          captionTracks: [],
          mediaCandidates: [{
            url: "https://cdn.example/course/master.m3u8",
            origin: "performance_resource",
            mimeType: "application/vnd.apple.mpegurl",
          }],
        } }];
      },
    },
    storage: { local: storage.area },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async (url, init = {}) => {
      requestedUrls.push(url);
      if (url === "https://cdn.example/course/master.m3u8") {
        return new Response(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.4d401f,mp4a.40.2"
video/index.m3u8
`, { status: 200 });
      }
      if (url === "https://cdn.example/course/audio/index.m3u8") {
        return new Response(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
part-1.m4s
#EXTINF:4,
part-2.m4s
#EXT-X-ENDLIST
`, { status: 200 });
      }
      if (/\/(?:init\.mp4|part-[12]\.m4s)$/.test(url)) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-length": "3" },
        });
      }
      if (url.includes("/upload/v1beta/files")) {
        return new Response("{}", {
          status: 200,
          headers: { "x-goog-upload-url": "https://upload.example/udemy" },
        });
      }
      if (url === "https://upload.example/udemy") {
        return new Response(JSON.stringify({
          file: {
            name: "files/udemy-audio",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/udemy-audio",
            mimeType: "video/mp4",
            state: "ACTIVE",
          },
        }), { status: 200 });
      }
      if (url.endsWith("/interactions")) {
        const request = JSON.parse(init.body);
        assert.equal(request.input[0].type, "audio");
        assert.equal(request.input[0].mime_type, "audio/aac");
        return new Response(JSON.stringify({
          outputText: JSON.stringify({
            summary: "",
            language: "en",
            segments: [{ start: "00:00", end: "00:04", speaker: "Instructor", text: "Course introduction" }],
            importantSegments: [],
          }),
        }), { status: 200 });
      }
      if (/files\/udemy-audio$/.test(url) && init.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    getTargetTab: async () => ({
      id: 12,
      title: "Udemy lecture",
      url: "https://www.udemy.com/course/example/learn/lecture/2",
    }),
    storageKey: "analyses",
    maxInlineMediaBytes: 0,
    remuxMp4AudioImpl: async (blob) => blob.slice(0, blob.size, "audio/aac"),
  });
  const result = await service.analyze({ apiKey: "test-key", args: { action: "transcript" } });
  assert.equal(result.sourceMethod, "temporary_hls_upload");
  assert.match(result.transcript, /Course introduction/);
  assert.ok(requestedUrls.includes("https://cdn.example/course/audio/part-2.m4s"));
});

test("waits for an aborted video request to finish before accepting new work", async () => {
  const youtubeUrl = "https://www.youtube.com/watch?v=cancel-cleanly";
  let interactionCount = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const service = createVideoAnalysisService({
    chromeApi: {
      scripting: {
        async executeScript() {
          return [{ result: {
            found: true,
            pageTitle: "Cancellation test",
            pageUrl: youtubeUrl,
            durationSeconds: 5,
            captionTracks: [],
            mediaCandidates: [],
          } }];
        },
      },
    },
    fetchImpl: async (_url, init = {}) => {
      interactionCount += 1;
      if (interactionCount === 1) {
        markStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("cancelled", "AbortError"));
          }, { once: true });
        });
      }
      return new Response(JSON.stringify({ outputText: JSON.stringify({
        language: "en",
        segments: [{ start: "00:00", end: "00:05", speaker: "Speaker", text: "Fresh request" }],
      }) }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({ id: 90, title: "Cancellation test", url: youtubeUrl }),
  });

  const running = service.analyze({
    apiKey: "test-key",
    args: { action: "transcript", url: youtubeUrl },
  });
  await started;
  assert.deepEqual(await service.cancelActive(), { cancelled: true });
  await assert.rejects(running, { name: "AbortError" });

  const fresh = await service.analyze({
    apiKey: "test-key",
    args: { action: "transcript", url: youtubeUrl },
  });
  assert.match(fresh.transcript, /Fresh request/);
});

test("publishes the built-in video tool and its routing guidance", () => {
  const transcriptTool = BUILTIN_TOOLS.find((candidate) => candidate.name === GET_TRANSCRIPT_TOOL_NAME);
  const summaryTool = BUILTIN_TOOLS.find((candidate) => candidate.name === VIDEO_SUMMARY_TOOL_NAME);
  assert.ok(transcriptTool);
  assert.ok(summaryTool);
  assert.deepEqual(transcriptTool.parameters.required, ["url"]);
  assert.deepEqual(summaryTool.parameters.required, ["url"]);
  assert.equal(transcriptTool.parameters.properties.url.type, "STRING");
  assert.equal(summaryTool.parameters.properties.url.type, "STRING");
  assert.equal(transcriptTool.parameters.properties.action, undefined);
  assert.equal(summaryTool.parameters.properties.action, undefined);
  assert.equal(classifyVideoSourceUrl("https://youtu.be/video-id"), "youtube");
  assert.equal(classifyVideoSourceUrl("https://www.facebook.com/reel/123"), "facebook");
  assert.equal(classifyVideoSourceUrl("https://www.udemy.com/course/demo/learn/lecture/456"), "udemy");
  assert.equal(classifyVideoSourceUrl("https://example.com/video"), "unsupported");
  const instruction = buildSessionInstruction();
  assert.match(instruction, /call get_transcript/i);
  assert.match(instruction, /call video_summary/i);
  assert.match(instruction, /Gemini 3\.5 Flash-Lite/i);
  assert.match(instruction, /Gemini 3\.1 Flash-Lite/i);
  assert.match(instruction, /high-demand, or temporary-capacity errors/i);
  assert.match(instruction, /caption or subtitle track/i);
  assert.match(instruction, /Do not reuse a transcript/i);
  assert.match(instruction, /whisper-large-v3-turbo first/i);
  assert.match(instruction, /whisper-large-v3 second/i);
  assert.match(instruction, /YouTube.*public watch URL directly to Gemini/is);
  assert.match(instruction, /Groq is only a speed optimization/i);
  assert.match(instruction, /summarize it directly in one pass/i);
  assert.match(instruction, /authenticated player frame/i);
});
