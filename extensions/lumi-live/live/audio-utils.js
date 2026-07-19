export function mergeTranscriptText(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming) || current.endsWith(incoming)) return current;
  const maxOverlap = Math.min(current.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.endsWith(incoming.slice(0, overlap))) return `${current}${incoming.slice(overlap)}`;
  }
  const needsSpace = !/\s$/.test(current) && !/^[\s.,!?;:'")\]}]/.test(incoming);
  return `${current}${needsSpace ? " " : ""}${incoming}`;
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

export function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer);
}

export const MAX_LIVE_AUDIO_SOCKET_BACKLOG_BYTES = 48 * 1024;
export const LIVE_TRANSLATION_JITTER_BUFFER_SECONDS = .32;
export const LIVE_TRANSLATION_MIN_SCHEDULE_LEAD_SECONDS = .06;

export function canSendLiveAudio(bufferedAmount) {
  return Number.isFinite(bufferedAmount)
    && bufferedAmount <= MAX_LIVE_AUDIO_SOCKET_BACKLOG_BYTES;
}

export function getLiveTranslationChunkStartTime(currentTime, nextOutputTime) {
  const safeCurrentTime = Number.isFinite(currentTime) ? currentTime : 0;
  if (!Number.isFinite(nextOutputTime)
    || nextOutputTime <= safeCurrentTime + LIVE_TRANSLATION_MIN_SCHEDULE_LEAD_SECONDS) {
    return safeCurrentTime + LIVE_TRANSLATION_JITTER_BUFFER_SECONDS;
  }
  return nextOutputTime;
}

export function resampleTo16k(input, inputRate) {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const output = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let total = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      total += input[sourceIndex];
    }
    output[index] = total / Math.max(1, end - start);
  }
  return output;
}

export function floatToPcm16(input) {
  const pcm = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}
