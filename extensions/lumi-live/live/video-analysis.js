export const VIDEO_ANALYSIS_MODELS = Object.freeze([
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
]);
export const VIDEO_ANALYSIS_MODEL = VIDEO_ANALYSIS_MODELS[0];
export const VIDEO_ANALYSIS_THINKING_LEVEL = "minimal";

export const GET_TRANSCRIPT_TOOL_NAME = "get_transcript";
export const VIDEO_SUMMARY_TOOL_NAME = "video_summary";
export const VIDEO_ANALYSIS_TOOL_NAMES = Object.freeze([
  GET_TRANSCRIPT_TOOL_NAME,
  VIDEO_SUMMARY_TOOL_NAME,
]);

const VIDEO_URL_PROPERTY = {
  type: "STRING",
  description: "Required full HTTPS URL of the YouTube video, Facebook video/Reel, or Udemy lecture to process. Lumi classifies the provider from this URL inside the tool.",
};

export function isVideoAnalysisToolName(value) {
  return VIDEO_ANALYSIS_TOOL_NAMES.includes(String(value || ""));
}

export function prepareVideoAnalysisAgentResult(result = {}, args = {}) {
  const sanitized = { ...result };
  delete sanitized.transcriptDownload;

  const action = String(args.action || "summary");
  if (action === "transcript" && sanitized.transcript) {
    delete sanitized.transcript;
    sanitized.transcriptAvailable = true;
    sanitized.presentationInstruction = "The complete transcript is already available in the Lumi conversation as a Download transcript card. Confirm completion briefly; do not repeat or reconstruct the transcript in chat.";
  }
  if (action === "summary" && sanitized.summaryMarkdown) {
    sanitized.presentationMarkdown = sanitized.summaryMarkdown;
    sanitized.presentationInstruction = "This timestamped Markdown has already been rendered directly to the Lumi conversation. Do not replace it with the short summary field or generate a duplicate shortened answer.";
    delete sanitized.summaryMarkdown;
    delete sanitized.summary;
    delete sanitized.chapters;
    delete sanitized.importantSegments;
  }
  return sanitized;
}

export const GET_TRANSCRIPT_TOOL = {
  name: GET_TRANSCRIPT_TOOL_NAME,
  description: "Get a complete timestamped transcript for a YouTube video, Facebook video/Reel, or Udemy lecture URL. The tool classifies the URL itself and always tries an exact existing caption/subtitle track first. YouTube falls back to direct Gemini Flash-Lite URL transcription. Facebook and Udemy try verified audio with optional Groq Whisper for speed, then fall back to Gemini when Groq is unavailable or fails. The transcript is provided as a download for the current request and is not retained as reusable chat state.",
  parameters: {
    type: "OBJECT",
    properties: {
      url: VIDEO_URL_PROPERTY,
    },
    required: ["url"],
  },
};

export const VIDEO_SUMMARY_TOOL = {
  name: VIDEO_SUMMARY_TOOL_NAME,
  description: "Summarize a YouTube video, Facebook video/Reel, or Udemy lecture URL. The tool classifies the URL itself and always tries an exact existing caption/subtitle track first. YouTube can be summarized directly by Gemini Flash-Lite. For Facebook and Udemy, optional Groq Whisper is used only as a speed optimization: when it succeeds Gemini summarizes that transcript; when Groq is missing, limited, or fails, Gemini summarizes the downloaded verified audio directly in one pass.",
  parameters: {
    type: "OBJECT",
    properties: {
      url: VIDEO_URL_PROPERTY,
      outputLanguage: {
        type: "STRING",
        description: "Language for the overview and timestamped chapters. Use the language of the user's request unless they explicitly ask for another language.",
      },
    },
    required: ["url"],
  },
};

export const VIDEO_ANALYSIS_TOOLS = Object.freeze([
  GET_TRANSCRIPT_TOOL,
  VIDEO_SUMMARY_TOOL,
]);

export const VIDEO_ANALYSIS_GUIDANCE = `For a request to obtain a transcript, call ${GET_TRANSCRIPT_TOOL_NAME}; for a request to summarize a video, call ${VIDEO_SUMMARY_TOOL_NAME}. Pass the complete user-provided YouTube, Facebook video/Reel, or Udemy lecture link in the required url parameter. Never ask the model to classify the URL and never split provider logic across browser steps: each tool validates and classifies url internally.

Both tools always try a complete, exact caption or subtitle track belonging to that URL first. When several complete tracks exist, prefer English before other languages. Reject partial, stale, or mismatched captions. Do not reuse a transcript from an earlier tool call or chat, and do not call an inspect/follow-up transcript cache. A transcript result is exposed only through the current Download transcript card and must not be repeated into the chat or retained as reusable task state.

For YouTube, after exact captions, send the public watch URL directly to Gemini 3.5 Flash-Lite for transcription or summary. Gemini automatically fails over to Gemini 3.1 Flash-Lite on quota, rate-limit, high-demand, or temporary-capacity errors. Do not spend time extracting YouTube audio for Groq.

For Facebook and Udemy, after exact captions, locate a verified audio track belonging to the requested video. If a Groq key is configured, try whisper-large-v3 first for higher transcription quality, then whisper-large-v3-turbo when the first model is rate-limited or temporarily unavailable. Groq is only a speed optimization. For ${VIDEO_SUMMARY_TOOL_NAME}, summarize the Groq transcript when Groq succeeds; if the key is missing or any Groq attempt fails, download the verified audio and ask Gemini to summarize it directly in one pass, without a separate Gemini transcription call. For ${GET_TRANSCRIPT_TOOL_NAME}, use Gemini to transcribe the verified audio when Groq is unavailable or fails. Udemy caption requests may be retried inside the authenticated player frame. Facebook media must match the requested Reel identity; reject adjacent Reel media and never bypass DRM or ambiguous blob streams.`;
