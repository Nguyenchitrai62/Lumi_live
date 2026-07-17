export type PixelAvatarState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "ui_control"
  | "tool_call"
  | "success"
  | "error";

type PixelAnimation = {
  row: number;
  frameDurationMs: number;
  label: string;
};

export const PIXEL_AVATAR = {
  name: "Lumi Pixel Companion",
  spritesheetPath: "/avatars/pixel/spritesheet.png",
  columns: 8,
  rows: 9,
  animations: {
    idle: { row: 0, frameDurationMs: 280, label: "Resting" },
    connecting: { row: 1, frameDurationMs: 240, label: "Connecting" },
    listening: { row: 2, frameDurationMs: 260, label: "Listening" },
    thinking: { row: 3, frameDurationMs: 280, label: "Thinking" },
    speaking: { row: 4, frameDurationMs: 210, label: "Speaking" },
    ui_control: { row: 5, frameDurationMs: 200, label: "Controlling UI" },
    tool_call: { row: 6, frameDurationMs: 220, label: "Using MCP" },
    success: { row: 7, frameDurationMs: 220, label: "Done" },
    error: { row: 8, frameDurationMs: 260, label: "Needs attention" },
  } satisfies Record<PixelAvatarState, PixelAnimation>,
} as const;

export const VTUBER_AVATAR = {
  name: "Lumi VTuber",
  assetRoot: "/avatars/vtuber",
} as const;
