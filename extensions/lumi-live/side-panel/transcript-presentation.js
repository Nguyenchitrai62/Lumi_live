import {
  TASK_AUTO_FOLLOW_BOTTOM_TOLERANCE_PX,
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

export function getLiveModelPartTranscriptRole(part) {
  if (!String(part?.text || "").trim()) return null;
  return part.thought === true ? "thinking" : "lumi";
}

export function formatMessageTimestamp(timestamp = Date.now()) {
  const date = new Date(Number(timestamp) || Date.now());
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatTurnDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round((Number(durationMs) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} giây`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} phút ${seconds} giây` : `${minutes} phút`;
}

export function isScrollAtBottom({
  scrollHeight = 0,
  scrollTop = 0,
  clientHeight = 0,
} = {}, tolerancePx = TASK_AUTO_FOLLOW_BOTTOM_TOLERANCE_PX) {
  const remaining = Number(scrollHeight) - Number(scrollTop) - Number(clientHeight);
  return remaining <= Math.max(0, Number(tolerancePx) || 0);
}
