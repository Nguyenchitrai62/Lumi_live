export const VIDEO_ANALYSIS_MODELS = Object.freeze([
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
]);
export const VIDEO_ANALYSIS_MODEL = VIDEO_ANALYSIS_MODELS[0];
export const VIDEO_ANALYZE_TOOL_NAME = "video_analyze_current";

export function prepareVideoAnalysisAgentResult(result = {}, args = {}) {
  const sanitized = { ...result };
  delete sanitized.transcriptDownload;
  const action = String(args.action || "summary");
  if (["summary", "both"].includes(action) && sanitized.summaryMarkdown) {
    sanitized.presentationMarkdown = sanitized.summaryMarkdown;
    sanitized.presentationInstruction = "This timestamped Markdown has already been rendered directly to the Lumi conversation. Do not replace it with the short summary field or generate a duplicate shortened answer.";
    delete sanitized.summaryMarkdown;
    delete sanitized.summary;
    delete sanitized.chapters;
    delete sanitized.importantSegments;
  }
  return sanitized;
}

export const VIDEO_ANALYZE_TOOL = {
  name: VIDEO_ANALYZE_TOOL_NAME,
  description: "Summarize or transcribe the video currently open in the active Chrome tab. Prefer an existing caption track, otherwise analyze a public YouTube/media URL with Gemini 3.5 Flash-Lite and immediately fail over to Gemini 3.1 Flash-Lite when a model is rate-limited. Use this tool whenever the user asks for a summary, transcript, subtitles, key moments, chapters, or important timestamps from the current video. A transcript request produces a local downloadable text file in the Lumi conversation.",
  parameters: {
    type: "OBJECT",
    properties: {
      action: {
        type: "STRING",
        enum: ["summary", "transcript", "both", "inspect"],
        description: "summary returns a concise overview plus timestamped content chapters without a detailed transcript, transcript creates a timestamped transcript download, both returns both outputs, and inspect answers a follow-up from the latest stored transcript.",
      },
      outputLanguage: {
        type: "STRING",
        description: "Language for the overview and timestamped chapters. Set this to the language used in the user's request (for example vi for Vietnamese) unless they explicitly request another language. Transcript speech remains in its original spoken language.",
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

export const VIDEO_ANALYSIS_GUIDANCE = `When the user asks to summarize, transcribe, extract subtitles from, identify chapters in, or find important moments in the video currently open in Chrome, call ${VIDEO_ANALYZE_TOOL_NAME} directly through the Lumi task protocol. Use action=summary for a concise chronological outline: one short main idea per timestamped content section, never transcript-level detail. Use action=transcript for only a downloadable transcript, and action=both when the user asks for both or when a transcript is explicitly intended for follow-up analysis. For summary, the tool always uses a full timestamped transcript as its evidence: it reuses complete captions when available, otherwise it first generates and context-corrects a transcript, then sends that transcript through a separate concise-summary pass. The internal transcript is stored for later inspection but is not shown in a summary-only response. On a later request, the tool automatically reuses that stored transcript only when the current tab resolves to the exact same YouTube video, Facebook Reel/video, Udemy lecture, or page URL; it never reuses a transcript across different videos. For summary or both, always set outputLanguage to the language used in the user's request (for example vi when the user asks in Vietnamese) unless they explicitly request a different language. A successful summary is rendered directly from presentationMarkdown in the conversation so every time range is preserved; do not expand it, replace it with another summary, or generate a second response. When Gemini must transcribe media because no complete captions exist, the tool asks it to perform a context-aware correction pass over recognition errors, terminology, names, punctuation, and nonsensical wording without changing the speaker's meaning. For a later question about an analyzed video or one of its timestamps, use action=inspect with the question and optional startTime/endTime; omit analysisId to reuse the newest locally stored transcript for the current video. Do not use browser_get_page_state or scrape visible captions first: this built-in tool already checks complete caption tracks, public YouTube input, direct media URLs, and a temporary media-upload fallback. Existing captions are preferred and do not consume a Gemini transcription request. Gemini 3.5 Flash-Lite automatically fails over to Gemini 3.1 Flash-Lite on model quota or rate-limit errors; do not retry the tool manually unless it explicitly says both models are limited. Treat returned timestamps and transcript text as the evidence for the task. If the tool reports that only a realtime blob stream exists, explain that a fast full-video transcript could not be extracted; never pretend that capturing ten minutes of playback completed in seconds.`;
