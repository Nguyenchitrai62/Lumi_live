export const LIVE_TRANSLATION_MODEL = "gemini-3.5-live-translate-preview";

export const LIVE_TRANSLATE_TOOL_NAME = "live_translate";

export const SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES = [
  "af", "ak", "sq", "am", "ar", "hy", "az", "eu", "be", "bn", "bg", "my", "ca",
  "zh-Hans", "zh-Hant", "hr", "cs", "da", "nl", "en", "et", "fil", "fi", "fr",
  "gl", "ka", "de", "el", "gu", "ha", "he", "hi", "hu", "is", "id", "it", "ja",
  "jv", "kn", "kk", "km", "rw", "ko", "lo", "lv", "lt", "mk", "ms", "ml", "mr",
  "mn", "ne", "no", "nb", "fa", "pl", "pt-BR", "pt-PT", "pa", "ro", "ru", "sr",
  "sd", "si", "sk", "sl", "es", "su", "sw", "sv", "ta", "te", "th", "tr", "uk",
  "ur", "uz", "vi", "zu",
] as const;

export const LIVE_TRANSLATE_TOOL_DECLARATION = {
  name: LIVE_TRANSLATE_TOOL_NAME,
  description: "Start, stop, or inspect live speech-to-speech translation for the audio of the video currently playing in the shared browser tab. Use this tool for requests such as translate, interpret, or dub the current video. Do not use it for translating typed text or a static page. The target language must come from the user's request or an explicitly established conversation preference. The tool itself plays the translated voice; never imitate or repeat the translation with the assistant voice.",
  parameters: {
    type: "OBJECT",
    properties: {
      action: {
        type: "STRING",
        enum: ["start", "stop", "status"],
        description: "start begins or changes live translation, stop ends it, and status reports the current state.",
      },
      targetLanguageCode: {
        type: "STRING",
        enum: SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES,
        description: "Required for start. The requested target language as one of the supported BCP-47 codes. Never silently default this field to any language.",
      },
    },
    required: ["action"],
  },
} as const;

export const LIVE_TRANSLATION_GUIDANCE = `When the user asks to translate, interpret, or dub speech from the video that is currently playing, call ${LIVE_TRANSLATE_TOOL_NAME}. For action=start, determine targetLanguageCode from the language requested in the current instruction or from an explicit preference already established in the conversation. Never assume a default target language based on the UI language, locale, examples, or earlier unrelated requests. If no target language is known, ask the user which language they want and do not start the tool yet. Use action=stop when the user asks to stop live translation. Do not call this tool for ordinary text translation. The tool owns translated audio playback, so after a successful start do not speak, imitate, summarize, or repeat the translated dialogue with your assistant voice.`;

const supportedLanguageCodeLookup = new Map(
  SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES.map((code) => [code.toLowerCase(), code]),
);

export function normalizeLiveTranslationLanguageCode(value: unknown) {
  const candidate = String(value ?? "").trim().replace(/_/g, "-");
  const normalized = candidate.toLowerCase();
  return supportedLanguageCodeLookup.get(normalized)
    ?? supportedLanguageCodeLookup.get(normalized.split("-")[0])
    ?? null;
}

export function getLiveTranslationLanguageLabel(code: string) {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

export function buildLiveTranslationSetup(targetLanguageCode: string) {
  return {
    setup: {
      model: `models/${LIVE_TRANSLATION_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode,
          echoTargetLanguage: false,
        },
      },
    },
  };
}
