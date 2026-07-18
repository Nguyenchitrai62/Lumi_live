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
