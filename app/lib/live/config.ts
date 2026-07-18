import type { VideoMode } from "./types";

export const MODEL = "gemini-3.1-flash-live-preview";
export const WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
export const DIRECT_WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const EXTENSION_API_KEY_STORAGE_KEY = "lumi-gemini-api-key";
export const MIC_CAPTURE_PROCESSOR = "lumi-pcm-capture";

export const BASE_SYSTEM_INSTRUCTION = `You are Lumi, a warm, playful anime roleplay companion. Stay in character, use vivid but concise replies, follow the player's chosen scenario, never claim to be human, and keep the conversation friendly and safe. Speak naturally and leave space for the player to respond. When current visual frames are provided, use them to answer questions about the user's shared screen or camera. Never pretend to see anything when vision is off or a current frame is unavailable.`;

export const scenes = [
  { id: "bedroom", name: "Cloud room", symbol: "☁" },
  { id: "observatory", name: "Observatory", symbol: "✦" },
  { id: "garden", name: "Moon garden", symbol: "❀" },
] as const;

export const voices = [
  ["Zephyr", "Female", "Bright"], ["Puck", "Male", "Upbeat"], ["Charon", "Male", "Informative"],
  ["Kore", "Female", "Firm"], ["Fenrir", "Male", "Excitable"], ["Leda", "Female", "Youthful"],
  ["Orus", "Male", "Firm"], ["Aoede", "Female", "Breezy"], ["Callirrhoe", "Female", "Easy-going"],
  ["Autonoe", "Female", "Bright"], ["Enceladus", "Male", "Breathy"], ["Iapetus", "Male", "Clear"],
  ["Umbriel", "Male", "Easy-going"], ["Algieba", "Male", "Smooth"], ["Despina", "Female", "Smooth"],
  ["Erinome", "Female", "Clear"], ["Algenib", "Male", "Gravelly"], ["Rasalgethi", "Male", "Informative"],
  ["Laomedeia", "Female", "Upbeat"], ["Achernar", "Female", "Soft"], ["Alnilam", "Male", "Firm"],
  ["Schedar", "Male", "Even"], ["Gacrux", "Female", "Mature"], ["Pulcherrima", "Female", "Forward"],
  ["Achird", "Male", "Friendly"], ["Zubenelgenubi", "Male", "Casual"], ["Vindemiatrix", "Female", "Gentle"],
  ["Sadachbia", "Male", "Lively"], ["Sadaltager", "Male", "Knowledgeable"], ["Sulafat", "Female", "Warm"],
] as const;

export type Scene = (typeof scenes)[number]["id"];
export type VoiceName = (typeof voices)[number][0];

export const DEFAULT_VIDEO_MODE: VideoMode = "screen";
export const videoModes: ReadonlyArray<{ id: VideoMode; label: string }> = [
  { id: "screen", label: "Screen" },
  { id: "camera", label: "Camera" },
  { id: "none", label: "None" },
];

export const TOOL_ACTIVITY_LABELS = {
  running: "Running",
  waiting: "Awaiting approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
} as const;
