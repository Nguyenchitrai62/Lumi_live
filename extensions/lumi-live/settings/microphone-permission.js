import { STORAGE_KEYS } from "../core/extension-config.js";

const MICROPHONE_GRANTED_STORAGE_KEY = STORAGE_KEYS.microphoneGrantedAt;

const message = document.querySelector("#permissionMessage");
const detail = document.querySelector("#permissionDetail");
const requestButton = document.querySelector("#requestMicrophoneButton");
const settingsButton = document.querySelector("#openSettingsButton");

function setRequesting() {
  requestButton.disabled = true;
  requestButton.hidden = false;
  requestButton.textContent = "Waiting for Chrome...";
  settingsButton.hidden = true;
  message.className = "message";
  message.textContent = "Look for Chrome's microphone prompt near the address bar and choose Allow.";
}

function showBlocked(error) {
  requestButton.disabled = false;
  requestButton.textContent = "Try asking again";
  settingsButton.hidden = false;
  message.className = "message error";
  message.textContent = "Microphone access is blocked for this extension.";
  detail.textContent = error?.name === "SecurityError"
    ? "Chrome or your computer security policy blocked microphone capture. Open the settings below and allow Microphone for Lumi Live."
    : "If you chose Block earlier, Chrome will not show the prompt again until you change this extension's microphone permission in Site settings.";
}

async function requestMicrophone() {
  setRequesting();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable in this version of Chrome.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    stream.getTracks().forEach((track) => track.stop());
    await chrome.storage.local.set({ [MICROPHONE_GRANTED_STORAGE_KEY]: Date.now() });
    requestButton.hidden = true;
    settingsButton.hidden = true;
    message.className = "message success";
    message.textContent = "Microphone allowed. Lumi can now start a voice session.";
    detail.textContent = "Return to Lumi Live and press Start voice. You can close this tab.";
    setTimeout(() => window.close(), 1400);
  } catch (error) {
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      showBlocked(error);
      return;
    }
    requestButton.disabled = false;
    requestButton.textContent = "Try again";
    message.className = "message error";
    message.textContent = error?.name === "NotFoundError" ? "No microphone was found." : "Chrome could not open the microphone.";
    detail.textContent = error instanceof Error ? error.message : "Check your microphone and try again.";
  }
}

async function openExtensionSettings() {
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  const exactSettingsUrl = `chrome://settings/content/siteDetails?site=${encodeURIComponent(extensionOrigin)}`;
  try {
    await chrome.tabs.create({ url: exactSettingsUrl, active: true });
  } catch {
    await chrome.tabs.create({ url: "chrome://settings/content/microphone", active: true });
  }
}

requestButton.addEventListener("click", () => void requestMicrophone());
settingsButton.addEventListener("click", () => void openExtensionSettings());
void requestMicrophone();
