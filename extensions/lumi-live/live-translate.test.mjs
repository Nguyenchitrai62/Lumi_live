import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLiveTranslationSetup,
  LIVE_TRANSLATE_TOOL,
  normalizeLiveTranslationLanguageCode,
  SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES,
} from "./live-translate.js";

test("normalizes only supported Live Translate language codes", () => {
  assert.equal(normalizeLiveTranslationLanguageCode("VI"), "vi");
  assert.equal(normalizeLiveTranslationLanguageCode("vi-VN"), "vi");
  assert.equal(normalizeLiveTranslationLanguageCode("pt_br"), "pt-BR");
  assert.equal(normalizeLiveTranslationLanguageCode("zh-hans"), "zh-Hans");
  assert.equal(normalizeLiveTranslationLanguageCode("bg-BG"), "bg");
  assert.equal(normalizeLiveTranslationLanguageCode("xx"), null);
});

test("publishes every documented Live Translate target language without a default", () => {
  assert.ok(SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES.length > 70);
  assert.ok(SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES.includes("bg"));
  assert.ok(SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES.includes("vi"));
  assert.ok(SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES.includes("ja"));
  assert.deepEqual(
    LIVE_TRANSLATE_TOOL.parameters.properties.targetLanguageCode.enum,
    SUPPORTED_LIVE_TRANSLATION_LANGUAGE_CODES,
  );
  assert.match(LIVE_TRANSLATE_TOOL.parameters.properties.targetLanguageCode.description, /Never silently default/i);
});

test("builds the documented audio-to-audio Live Translate setup", () => {
  const setup = buildLiveTranslationSetup("vi");
  assert.equal(setup.setup.model, "models/gemini-3.5-live-translate-preview");
  assert.deepEqual(setup.setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.deepEqual(setup.setup.generationConfig.translationConfig, {
    targetLanguageCode: "vi",
    echoTargetLanguage: false,
  });
  assert.equal("inputAudioTranscription" in setup.setup, false);
  assert.equal("outputAudioTranscription" in setup.setup, false);
  assert.equal("inputAudioTranscription" in setup.setup.generationConfig, false);
  assert.equal("outputAudioTranscription" in setup.setup.generationConfig, false);
});

test("publishes one agent tool with explicit lifecycle actions", () => {
  assert.equal(LIVE_TRANSLATE_TOOL.name, "live_translate");
  assert.deepEqual(LIVE_TRANSLATE_TOOL.parameters.properties.action.enum, ["start", "stop", "status"]);
  assert.deepEqual(LIVE_TRANSLATE_TOOL.parameters.required, ["action"]);
});
