import { useCallback, useEffect, useRef, useState } from "react";
import { voices, type VoiceName } from "../lib/live/config";
import type { SessionStatus, VoicePreviewPhase } from "../lib/live/types";
import { playGeminiVoicePreview } from "../lib/live/voice-preview";

type UseVoicePreviewOptions = {
  status: SessionStatus;
  onStatusMessage: (message: string) => void;
};

export function useVoicePreview({ status, onStatusMessage }: UseVoicePreviewOptions) {
  const [voiceName, setVoiceName] = useState<VoiceName>("Zephyr");
  const [voicePreviewPhase, setVoicePreviewPhase] = useState<VoicePreviewPhase | "idle">("idle");
  const voicePreviewAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const savedVoice = localStorage.getItem("lumi-voice");
    if (voices.some(([name]) => name === savedVoice)) {
      const timer = window.setTimeout(() => setVoiceName(savedVoice as VoiceName), 0);
      return () => window.clearTimeout(timer);
    }
  }, []);

  const stopVoicePreview = useCallback(() => {
    const activePreview = voicePreviewAbortRef.current;
    if (!activePreview) return;
    voicePreviewAbortRef.current = null;
    activePreview.abort();
    setVoicePreviewPhase("idle");
  }, []);

  const chooseVoice = (voice: VoiceName) => {
    stopVoicePreview();
    localStorage.setItem("lumi-voice", voice);
    setVoiceName(voice);
    const profile = voices.find(([name]) => name === voice) ?? voices[0];
    onStatusMessage(`${voice} selected · ${profile[1]} · ${profile[2]}`);
  };

  const previewSelectedVoice = async () => {
    if (voicePreviewPhase !== "idle" || status === "ready" || status === "connecting") return;
    const previewController = new AbortController();
    voicePreviewAbortRef.current = previewController;
    setVoicePreviewPhase("connecting");
    onStatusMessage(`Preparing a short ${voiceName} preview…`);
    try {
      await playGeminiVoicePreview(voiceName, setVoicePreviewPhase, previewController.signal);
      onStatusMessage(`${voiceName} preview finished — start a new session when this voice feels right`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        onStatusMessage(error instanceof Error ? error.message : "Could not play the voice preview");
      }
    } finally {
      if (voicePreviewAbortRef.current === previewController) {
        voicePreviewAbortRef.current = null;
        setVoicePreviewPhase("idle");
      }
    }
  };

  useEffect(() => () => {
    voicePreviewAbortRef.current?.abort();
  }, []);

  return {
    voiceName,
    voicePreviewPhase,
    selectedVoiceProfile: voices.find(([name]) => name === voiceName) ?? voices[0],
    chooseVoice,
    previewSelectedVoice,
    stopVoicePreview,
  };
}
