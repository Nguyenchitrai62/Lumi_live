import {
  TRANSCRIPT_REVEAL_CHARACTERS_PER_SECOND,
  TRANSCRIPT_REVEAL_MINIMUM_DURATION_MS,
} from "../core/ui-config.js";

export function splitTranscriptCharacters(value) {
  return Array.from(String(value || ""));
}

export function findCommonCharacterPrefix(left, right) {
  const leftCharacters = splitTranscriptCharacters(left);
  const rightCharacters = splitTranscriptCharacters(right);
  let length = 0;
  while (
    length < leftCharacters.length
    && length < rightCharacters.length
    && leftCharacters[length] === rightCharacters[length]
  ) length += 1;
  return length;
}

export function getTranscriptRevealDurationMs(characterCount) {
  const count = Math.max(0, Number(characterCount) || 0);
  if (!count) return 0;
  return Math.max(
    TRANSCRIPT_REVEAL_MINIMUM_DURATION_MS,
    (count / TRANSCRIPT_REVEAL_CHARACTERS_PER_SECOND) * 1000,
  );
}
