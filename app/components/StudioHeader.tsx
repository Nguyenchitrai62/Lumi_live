import type { LiveTranslationState } from "../lib/live/translation-client";
import type { SessionStatus, ThemePreference } from "../lib/live/types";

type StudioHeaderProps = {
  status: SessionStatus;
  liveTranslationState: LiveTranslationState;
  liveTranslationTarget: string;
  enabledMcpToolCount: number;
  connectedMcpCount: number;
  mcpServerCount: number;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
};

export function StudioHeader({
  status,
  liveTranslationState,
  liveTranslationTarget,
  enabledMcpToolCount,
  connectedMcpCount,
  mcpServerCount,
  themePreference,
  onThemeChange,
}: StudioHeaderProps) {
  return (
    <header className="topbar">
      <div className="brand" aria-label="Lumi Live home">
        <span className="brand-mark" aria-hidden="true">✦</span>
        <span>Lumi <strong>Live</strong></span>
      </div>
      <div className="header-status">
        {liveTranslationState !== "off" && (
          <div
            className={`mcp-pill translate-pill translate-${liveTranslationState}`}
            title="Gemini Live Translate is playing the translated video audio"
          >
            <span className={liveTranslationState === "active" ? "connected" : ""} aria-hidden="true" />
            Translate {liveTranslationTarget || "…"}
          </div>
        )}
        <div className="mcp-pill" title={`${enabledMcpToolCount} MCP tools available`}>
          <span className={connectedMcpCount ? "connected" : ""} aria-hidden="true" />
          MCP {connectedMcpCount}/{mcpServerCount}
        </div>
        <div className="theme-switcher topbar-theme-switcher" role="group" aria-label="Color theme">
          {([
            ["system", "◐", "System"],
            ["light", "☀", "Light"],
            ["dark", "☾", "Dark"],
          ] as const).map(([theme, icon, label]) => (
            <button
              key={theme}
              type="button"
              className={themePreference === theme ? "selected" : ""}
              onClick={() => onThemeChange(theme)}
              aria-pressed={themePreference === theme}
              title={label}
            >
              <span className="theme-icon" aria-hidden="true">{icon}</span>
              <span className="theme-label">{label}</span>
            </button>
          ))}
        </div>
        <div className="model-pill">
          <span className={`status-dot status-${status}`} />
          <span className="model-label">Gemini 3.1 Flash Live</span>
          <span className="model-short">Live model</span>
        </div>
      </div>
    </header>
  );
}
