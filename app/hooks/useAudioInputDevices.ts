import { useCallback, useEffect, useState } from "react";

export function useAudioInputDevices() {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");

  const refreshAudioInputs = useCallback(async (clearOnError = true) => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) {
      if (clearOnError) setAudioInputs([]);
      return;
    }
    try {
      const devices = await mediaDevices.enumerateDevices();
      setAudioInputs(devices.filter((device) => device.kind === "audioinput"));
    } catch {
      if (clearOnError) setAudioInputs([]);
    }
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    const handleDeviceChange = () => void refreshAudioInputs();

    const initialRefreshTimer = window.setTimeout(() => void refreshAudioInputs(), 0);
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      window.clearTimeout(initialRefreshTimer);
      mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [refreshAudioInputs]);

  return {
    audioInputs,
    selectedDeviceId,
    setSelectedDeviceId,
    refreshAudioInputs,
  };
}
