export const VIDEO_ANALYSIS_MODEL = "gemini-3.5-flash-lite";
export const VIDEO_ANALYZE_TOOL_NAME = "video_analyze_current";

export const VIDEO_ANALYZE_TOOL = {
  name: VIDEO_ANALYZE_TOOL_NAME,
  description: "Summarize or transcribe the video currently open in the active Chrome tab. Prefer an existing caption track, otherwise analyze a public YouTube/media URL with Gemini 3.5 Flash-Lite and fall back to temporarily uploading fetched media. Use this tool whenever the user asks for a summary, transcript, subtitles, key moments, chapters, or important timestamps from the current video. A transcript request produces a local downloadable text file in the Lumi conversation.",
  parameters: {
    type: "OBJECT",
    properties: {
      action: {
        type: "STRING",
        enum: ["summary", "transcript", "both", "inspect"],
        description: "summary returns a concise overview and important timestamps, transcript creates a timestamped transcript download, both returns both outputs, and inspect answers a follow-up from the latest stored transcript.",
      },
      outputLanguage: {
        type: "STRING",
        description: "Optional requested language for the summary. Use auto to preserve the video's language. Transcript speech is never translated unless the user explicitly asks for translation in their request.",
      },
      analysisId: {
        type: "STRING",
        description: "Optional analysisId returned by an earlier call. For inspect, omit it to use the newest locally stored analysis for the current video.",
      },
      startTime: {
        type: "STRING",
        description: "Optional start timestamp such as 04:10 for an inspect request.",
      },
      endTime: {
        type: "STRING",
        description: "Optional end timestamp such as 05:05 for an inspect request.",
      },
      question: {
        type: "STRING",
        description: "The focused follow-up question for inspect. Base the answer on the stored transcript and state when visual evidence would be required.",
      },
    },
    required: ["action"],
  },
};

export const VIDEO_ANALYSIS_GUIDANCE = `When the user asks to summarize, transcribe, extract subtitles from, identify chapters in, or find important moments in the video currently open in Chrome, call ${VIDEO_ANALYZE_TOOL_NAME} directly through the Lumi task protocol. Use action=summary for only a summary, action=transcript for only a downloadable transcript, and action=both when the user asks for both or when a transcript is explicitly intended for follow-up analysis. For a later question about an analyzed video or one of its timestamps, use action=inspect with the question and optional startTime/endTime; omit analysisId to reuse the newest stored analysis for the current video. Do not use browser_get_page_state or scrape visible captions first: this built-in tool already checks complete caption tracks, public YouTube input, direct media URLs, and a temporary media-upload fallback. Existing captions are preferred and do not consume a Gemini media request. Treat returned timestamps and transcript text as the evidence for the task. If the tool reports that only a realtime blob stream exists, explain that a fast full-video transcript could not be extracted; never pretend that capturing ten minutes of playback completed in seconds.`;
