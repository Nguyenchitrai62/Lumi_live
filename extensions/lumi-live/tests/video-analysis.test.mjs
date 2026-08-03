import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAacAdtsHeader,
  chooseDirectMediaCandidate,
  createVideoAnalysisService,
  extractInteractionText,
  formatTranscriptFile,
  formatVideoSummaryMarkdown,
  formatVideoTimestamp,
  mergeVideoAnalysisSources,
  normalizeVideoAnalysisResult,
  parseCaptionPayload,
  parseHlsPlaylist,
  parseStoredTranscriptSegments,
  rankDirectMediaCandidates,
  videoIdentityKey,
} from "../background/video-analysis-service.js";
import {
  prepareVideoAnalysisAgentResult,
  VIDEO_ANALYSIS_MODEL,
  VIDEO_ANALYSIS_MODELS,
  VIDEO_ANALYZE_TOOL_NAME,
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
              videoDeliveryResponseFragment: {
                videoDeliveryResponseResult: {
                  dash_manifests: [{ manifest_xml: manifestXml }],
                },
              },
            },
          },
        },
      }],
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
  const result = await service.analyze({ apiKey: "test-key", args: { action: "transcript" } });
  assert.equal(fetchCount, 0);
  assert.equal(result.sourceMethod, "html_text_track");
  assert.equal(result.model, null);
  assert.match(result.transcript, /Welcome/);
  assert.match(result.transcriptDownload.filename, /Captioned-video-transcript\.txt/);
  assert.equal(storage.state.analyses.length, 1);
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
`, { status: 200, headers: { "content-type": "text/vtt" } });
    },
    getTargetTab: async () => ({
      id: 11,
      title: "Udemy lecture",
      url: "https://www.udemy.com/course/example/learn/lecture/1",
    }),
    storageKey: "analyses",
  });
  const result = await service.analyze({ apiKey: "test-key", args: { action: "transcript" } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.credentials, "include");
  assert.equal(result.sourceMethod, "html_track_url");
  assert.equal(result.model, null);
  assert.match(result.transcript, /Welcome to the course/);
});

test("sends a public YouTube URL directly to Gemini 3.5 Flash-Lite", async () => {
  const storage = createMemoryStorage();
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
  assert.equal(result.summary, "A concise summary.");
  assert.match(result.summaryMarkdown, /Nội dung theo từng phần/);
  assert.match(result.summaryMarkdown, /Từ 00:00 đến 00:05/);
  assert.match(result.transcriptDownload.text, /Opening statement/);
});

test("builds a concise summary from a generated transcript and hides transcript detail", async () => {
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
      const isTranscriptPass = Boolean(request.response_format.schema.properties.segments);
      const output = isTranscriptPass
        ? {
            language: "en",
            segments: [
              { start: "00:00", end: "02:30", speaker: "Narrator", text: "The speaker establishes the problem." },
              { start: "02:30", end: "10:00", speaker: "Narrator", text: "The speaker explains the solution." },
            ],
          }
        : {
            summary: "A concise overview.",
            language: "en",
            chapters: [
              { start: "00:00", end: "02:30", title: "Setup", summary: "Establishes the central problem." },
              { start: "02:30", end: "10:00", title: "Solution", summary: "Explains the proposed solution." },
            ],
            importantSegments: [],
          };
      return new Response(JSON.stringify({
        outputText: JSON.stringify(output),
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
  assert.equal(requests.length, 2);
  assert.equal(requests[0].response_format.schema.properties.chapters, undefined);
  assert.ok(requests[0].response_format.schema.properties.segments);
  assert.match(requests[0].input[1].text, /context-aware editorial pass/i);
  assert.match(requests[1].input[0].text, /The speaker establishes the problem/);
  assert.equal(requests[1].response_format.schema.properties.segments, undefined);
  assert.match(requests[1].input[1].text, /abstractive, concise outline/i);
  assert.match(requests[1].input[1].text, /exactly one short sentence/i);
  assert.match(requests[1].input[1].text, /first section must start at 00:00/i);
  assert.equal(Object.hasOwn(result, "transcript"), false);
  assert.equal(result.transcriptDownload, null);
  assert.equal(result.transcriptSourceQuality, "model_context_corrected");
  assert.equal(result.chapters.length, 2);
  assert.match(result.summaryMarkdown, /From 02:30 to 10:00 — Solution:/);

  const repeated = await service.analyze({ apiKey: "test-key", args: { action: "summary" } });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].input[0].type, "text");
  assert.match(requests[2].input[0].text, /The speaker establishes the problem/);
  assert.equal(repeated.sourceMethod, "stored_transcript");
  assert.equal(repeated.transcriptReused, true);
  assert.equal(repeated.transcriptSourceQuality, "stored_transcript");

  currentUrl = "https://www.youtube.com/watch?v=different456";
  const differentVideo = await service.analyze({ apiKey: "test-key", args: { action: "summary" } });
  assert.equal(requests.length, 5);
  assert.equal(requests[3].input[0].uri, currentUrl);
  assert.equal(differentVideo.sourceMethod, "youtube_url");
  assert.equal(differentVideo.transcriptReused, false);
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

test("immediately fails over between Flash-Lite models but retries 3.5 first on every new prompt", async () => {
  const storage = createMemoryStorage();
  const requestedModels = [];
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
      if (requestedModels.length === 1) {
        return new Response(JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "TPM quota exceeded for this model.",
            details: [{ retryDelay: "42s" }],
          },
        }), { status: 429, headers: { "content-type": "application/json" } });
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
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
  ]);
  assert.equal(first.model, "gemini-3.1-flash-lite");
  assert.deepEqual(first.modelAttempts, VIDEO_ANALYSIS_MODELS);
  assert.equal(first.modelFallbackUsed, true);
  assert.equal(second.model, "gemini-3.5-flash-lite");
  assert.deepEqual(second.modelAttempts, ["gemini-3.5-flash-lite"]);
  assert.equal(second.modelFallbackUsed, false);
});

test("reports an error only after both video models are rate-limited", async () => {
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
      assert.equal(error.code, "ALL_VIDEO_MODELS_RATE_LIMITED");
      assert.deepEqual(error.models, VIDEO_ANALYSIS_MODELS);
      assert.match(error.message, /Both Gemini video models are currently rate-limited/);
      return true;
    },
  );
  assert.deepEqual(requestedModels, VIDEO_ANALYSIS_MODELS);
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
  assert.equal(result.transcriptReused, false);
  assert.equal(result.uploadedMediaDeleted, false);
  assert.match(result.transcript, /Xin chào/);
  assert.equal(calls.filter((call) => call.url.endsWith("/interactions")).length, 1);
  assert.equal(calls.some((call) => call.url.includes("/upload/v1beta/files")), false);
  assert.equal(storage.state.analyses.length, 1);
  assert.equal(storage.state.analyses[0].mediaIdentityVerified, true);
  assert.equal(storage.state.analyses[0].facebookVideoId, "1554671672755534");
  assert.equal(storage.state.analyses[0].videoIdentity, "facebook:1554671672755534");
  assert.equal(storage.state.analyses[0].pageUrl, "https://www.facebook.com/reel/1554671672755534");
  assert.doesNotMatch(storage.state.analyses[0].transcript, /Wrong Reel/);
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

test("reuses a locally stored transcript for focused follow-up inspection", async () => {
  const storage = createMemoryStorage();
  storage.state.analyses = [{
    id: "analysis-1",
    createdAt: Date.now(),
    pageTitle: "Stored video",
    pageUrl: "https://example.com/watch?id=1",
    transcript: [
      "Stored video",
      "Source: https://example.com/watch?id=1",
      "",
      "[00:00 - 00:30] Introduction",
      "[04:10 - 04:40] The central claim",
      "[04:40 - 05:05] Supporting evidence",
    ].join("\n"),
  }];
  const requests = [];
  const chromeApi = {
    scripting: { async executeScript() { throw new Error("inspect should not scan media again"); } },
    storage: { local: storage.area },
  };
  const service = createVideoAnalysisService({
    chromeApi,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        outputText: JSON.stringify({
          answer: "The central claim is supported by the following evidence.",
          citedSegments: [{ start: "04:10", end: "05:05", evidence: "Claim and evidence" }],
        }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    getTargetTab: async () => ({ id: 9, title: "Stored video", url: "https://example.com/watch?id=1" }),
    storageKey: "analyses",
  });
  const result = await service.analyze({
    apiKey: "test-key",
    args: {
      action: "inspect",
      startTime: "04:10",
      endTime: "05:05",
      question: "What is the evidence?",
    },
  });
  assert.equal(result.analysisId, "analysis-1");
  assert.equal(result.sourceMethod, "stored_transcript");
  assert.match(result.answer, /central claim/i);
  assert.match(requests[0].input[0].text, /The central claim/);
  assert.doesNotMatch(requests[0].input[0].text, /Introduction/);
});

test("publishes the built-in video tool and its routing guidance", () => {
  const tool = BUILTIN_TOOLS.find((candidate) => candidate.name === VIDEO_ANALYZE_TOOL_NAME);
  assert.ok(tool);
  assert.deepEqual(tool.parameters.properties.action.enum, ["summary", "transcript", "both", "inspect"]);
  const instruction = buildSessionInstruction();
  assert.match(instruction, /summarize, transcribe, extract subtitles/i);
  assert.match(instruction, /downloadable transcript/i);
  assert.match(instruction, /Gemini 3\.5 Flash-Lite/i);
  assert.match(instruction, /Gemini 3\.1 Flash-Lite/i);
  assert.match(instruction, /action=inspect/i);
});
