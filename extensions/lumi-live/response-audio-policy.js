export const RESPONSE_AUDIO_DIRECTIVE_KEY = "lumiResponseAudio";

export function createTurnAudioGate(stopPlayback) {
  let suppressed = false;
  return {
    shouldPlay() {
      return !suppressed;
    },
    suppress() {
      if (suppressed) return;
      suppressed = true;
      stopPlayback();
    },
    reset() {
      suppressed = false;
    },
  };
}

export function consumeResponseAudioDirective(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { result, suppressForTurn: false };
  }
  const directive = result[RESPONSE_AUDIO_DIRECTIVE_KEY];
  if (!directive) return { result, suppressForTurn: false };
  const publicResult = { ...result };
  delete publicResult[RESPONSE_AUDIO_DIRECTIVE_KEY];
  return {
    result: publicResult,
    suppressForTurn: directive.suppressForTurn === true,
  };
}
