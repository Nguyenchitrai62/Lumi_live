import { EXTENSION_API_KEY_STORAGE_KEY } from "./config";
import type { LiveAuth, VideoMode } from "./types";

export async function requestVideoStream(mode: VideoMode) {
  if (mode === "none") return Promise.resolve<MediaStream | null>(null);

  if (mode === "screen") {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return Promise.reject(new Error("Screen sharing is not supported by this browser."));
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 1, max: 1 },
        displaySurface: "browser",
      },
      audio: false,
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "exclude",
    } as DisplayMediaStreamOptions);
    const displaySurface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
    if (displaySurface && displaySurface !== "browser") {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Choose a Chrome Tab so Lumi can see and control the same page.");
    }
    return stream;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error("Camera access is not supported by this browser."));
  }
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 5, max: 10 },
      facingMode: "user",
    },
    audio: false,
  });
}

export async function getLiveAuth(): Promise<LiveAuth> {
  if (window.location.protocol === "chrome-extension:") {
    const apiKey = localStorage.getItem(EXTENSION_API_KEY_STORAGE_KEY)?.trim();
    if (!apiKey) {
      throw new Error("Open Lumi Live settings and save a Gemini API key first.");
    }
    return { kind: "apiKey", credential: apiKey };
  }

  const response = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "The voice token could not be created.");
  }
  const { token } = await response.json();
  if (!token) throw new Error("The voice token response was empty.");
  return { kind: "ephemeral", credential: token };
}

export function describeVideoError(error: unknown, mode: VideoMode) {
  const source = mode === "screen" ? "Screen sharing" : "Camera access";
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return `${source} was skipped; voice chat is still available.`;
  }
  if (error instanceof Error && error.message) {
    return `${source} failed: ${error.message}`;
  }
  return `${source} could not be started; voice chat is still available.`;
}

export function describeMicrophoneError(error: unknown) {
  if (!(error instanceof DOMException)) {
    return error instanceof Error ? error.message : "Couldn’t start voice chat";
  }

  if (error.name === "NotAllowedError") {
    return "Microphone access is blocked for this site. Allow it from the lock icon, then reconnect.";
  }
  if (error.name === "NotFoundError") {
    return "No microphone was found. Connect one, then reconnect.";
  }
  if (error.name === "NotReadableError") {
    return "The microphone is busy or unavailable. Close another app using it, then reconnect.";
  }
  if (error.name === "OverconstrainedError") {
    return "The selected microphone is no longer available. Choose System default, then reconnect.";
  }
  return error.message || "Couldn’t start voice chat";
}
