export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

export function base64ToInt16(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer);
}

export const MAX_LIVE_AUDIO_SOCKET_BACKLOG_BYTES = 48 * 1024;
export const LIVE_TRANSLATION_JITTER_BUFFER_SECONDS = 0.32;
export const LIVE_TRANSLATION_MIN_SCHEDULE_LEAD_SECONDS = 0.06;

export function canSendLiveAudio(bufferedAmount: number) {
  return Number.isFinite(bufferedAmount)
    && bufferedAmount <= MAX_LIVE_AUDIO_SOCKET_BACKLOG_BYTES;
}

export function getLiveTranslationChunkStartTime(currentTime: number, nextOutputTime: number) {
  const safeCurrentTime = Number.isFinite(currentTime) ? currentTime : 0;
  if (
    !Number.isFinite(nextOutputTime)
    || nextOutputTime <= safeCurrentTime + LIVE_TRANSLATION_MIN_SCHEDULE_LEAD_SECONDS
  ) {
    return safeCurrentTime + LIVE_TRANSLATION_JITTER_BUFFER_SECONDS;
  }
  return nextOutputTime;
}

export function resampleTo16k(input: Float32Array, inputRate: number) {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const result = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));

  for (let index = 0; index < result.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let total = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      total += input[sourceIndex];
    }
    result[index] = total / Math.max(1, end - start);
  }

  return result;
}

export function floatToPcm16(floatData: Float32Array) {
  const pcm = new Int16Array(floatData.length);
  for (let index = 0; index < floatData.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, floatData[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

export function mergeTranscriptText(current: string, incoming: string) {
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming) || current.endsWith(incoming)) return current;

  const maxOverlap = Math.min(current.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.endsWith(incoming.slice(0, overlap))) {
      return `${current}${incoming.slice(overlap)}`;
    }
  }

  const needsSpace = !/\s$/.test(current) && !/^[\s.,!?;:'")\]}]/.test(incoming);
  return `${current}${needsSpace ? " " : ""}${incoming}`;
}
