import { useCallback, useEffect, useState, type RefObject } from "react";

type UseMouthAnimationOptions = {
  analyserRef: RefObject<AnalyserNode | null>;
  audioContextRef: RefObject<AudioContext | null>;
  speakingRef: RefObject<boolean>;
  nextPlaybackTimeRef: RefObject<number>;
};

export function useMouthAnimation({
  analyserRef,
  audioContextRef,
  speakingRef,
  nextPlaybackTimeRef,
}: UseMouthAnimationOptions) {
  const [mouthFrame, setMouthFrame] = useState(0);

  useEffect(() => {
    let animationId = 0;
    const levels = new Uint8Array(128);
    let smoothedRms = 0;
    let displayedFrame = 0;
    let lastFrameChange = 0;

    const animate = (now: number) => {
      const analyser = analyserRef.current;
      const context = audioContextRef.current;
      const playbackActive = Boolean(
        analyser && context && (
          speakingRef.current || context.currentTime < nextPlaybackTimeRef.current + 0.14
        )
      );

      let targetFrame = displayedFrame;
      if (!playbackActive || !analyser) {
        smoothedRms *= 0.72;
        targetFrame = 0;
      } else {
        analyser.getByteTimeDomainData(levels);
        let energy = 0;
        for (const value of levels) {
          const centered = (value - 128) / 128;
          energy += centered * centered;
        }
        const rms = Math.sqrt(energy / levels.length);
        smoothedRms = smoothedRms * 0.68 + rms * 0.32;

        if (displayedFrame === 0) {
          if (smoothedRms > 0.026) targetFrame = 1;
        } else if (displayedFrame === 1) {
          if (smoothedRms > 0.105) targetFrame = 2;
          else if (smoothedRms < 0.014) targetFrame = 0;
        } else if (smoothedRms < 0.062) {
          targetFrame = 1;
        }
      }

      if (targetFrame !== displayedFrame && now - lastFrameChange >= 90) {
        displayedFrame = targetFrame;
        lastFrameChange = now;
        setMouthFrame(targetFrame);
      }
      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationId);
  }, [analyserRef, audioContextRef, nextPlaybackTimeRef, speakingRef]);

  const resetMouthFrame = useCallback(() => setMouthFrame(0), []);
  return { mouthFrame, resetMouthFrame };
}
