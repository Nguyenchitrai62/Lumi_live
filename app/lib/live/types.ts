import type { ActiveMcpTool } from "../mcp";

export type Outfit = "casual" | "moonlit";
export type SessionStatus = "idle" | "connecting" | "ready" | "error";
export type ThemePreference = "system" | "light" | "dark";
export type VideoMode = "screen" | "camera" | "none";
export type Role = "user" | "lumi";

export type ChatMessage = {
  id: string;
  role: Role | "tool";
  text: string;
  title?: string;
  serverName?: string;
  args?: string;
  startedAt?: number;
  startedLabel?: string;
  durationLabel?: string;
  state?: "running" | "waiting" | "completed" | "failed" | "cancelled";
};

export type McpApprovalRequest = {
  id: string;
  tool: ActiveMcpTool;
  args: Record<string, unknown>;
  resolve: (allowed: boolean) => void;
  timeoutId: number;
};

export type LiveAuth =
  | { kind: "apiKey"; credential: string }
  | { kind: "ephemeral"; credential: string };

export type VoicePreviewPhase = "connecting" | "playing";
