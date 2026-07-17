const FRAME_SIZE = 4096;

class LumiPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME_SIZE);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    let inputOffset = 0;
    while (inputOffset < input.length) {
      const sampleCount = Math.min(FRAME_SIZE - this.offset, input.length - inputOffset);
      this.frame.set(input.subarray(inputOffset, inputOffset + sampleCount), this.offset);
      this.offset += sampleCount;
      inputOffset += sampleCount;

      if (this.offset === FRAME_SIZE) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(FRAME_SIZE);
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("lumi-pcm-capture", LumiPcmCaptureProcessor);
