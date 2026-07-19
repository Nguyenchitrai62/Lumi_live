import { McpSettings } from "./McpSettings";
import { PetalLayer } from "./PetalLayer";
import { videoModes, voices, type VoiceName } from "../lib/live/config";
import type { McpServerView, McpToolPolicy } from "../lib/mcp";
import type { SessionStatus, VideoMode, VoicePreviewPhase } from "../lib/live/types";

type StudioSettingsPanelProps = {
  petalsEnabled: boolean;
  status: SessionStatus;
  micLevel: number;
  voiceName: VoiceName;
  selectedVoiceProfile: (typeof voices)[number];
  voicePreviewPhase: VoicePreviewPhase | "idle";
  audioInputs: MediaDeviceInfo[];
  selectedDeviceId: string;
  videoMode: VideoMode;
  mcpServers: McpServerView[];
  mcpUrl: string;
  mcpBusy: boolean;
  mcpMessage: string;
  onChooseVoice: (voice: VoiceName) => void;
  onToggleVoicePreview: () => void;
  onSelectedDeviceChange: (deviceId: string) => void;
  onVideoModeChange: (mode: VideoMode) => void;
  onMcpUrlChange: (url: string) => void;
  onMcpConnect: () => void;
  onMcpReconnect: (serverId: string) => void;
  onMcpRemove: (serverId: string) => void;
  onMcpToolPolicy: (serverId: string, toolName: string, mode: McpToolPolicy) => void;
  onMcpServerPolicy: (serverId: string, mode: McpToolPolicy) => void;
};

export function StudioSettingsPanel({
  petalsEnabled,
  status,
  micLevel,
  voiceName,
  selectedVoiceProfile,
  voicePreviewPhase,
  audioInputs,
  selectedDeviceId,
  videoMode,
  mcpServers,
  mcpUrl,
  mcpBusy,
  mcpMessage,
  onChooseVoice,
  onToggleVoicePreview,
  onSelectedDeviceChange,
  onVideoModeChange,
  onMcpUrlChange,
  onMcpConnect,
  onMcpReconnect,
  onMcpRemove,
  onMcpToolPolicy,
  onMcpServerPolicy,
}: StudioSettingsPanelProps) {
  const sessionActive = status === "ready" || status === "connecting";

  return (
    <aside className={`settings-panel ${petalsEnabled ? "petals-enabled" : "petals-disabled"}`} aria-label="Lumi settings">
      <PetalLayer className="settings-petal-field" enabled={petalsEnabled} />
      <div className="settings-panel-scroll">
        <div className="settings-panel-head">
          <div>
            <span className="eyebrow">WEB STUDIO</span>
            <h1>Settings</h1>
          </div>
          <span className={`connection-badge badge-${status}`}>
            {status === "ready" ? "Live" : status === "connecting" ? "Joining" : status === "error" ? "Retry" : "Ready"}
          </span>
        </div>

        <section className="settings-section" aria-labelledby="live-input-title">
          <div className="settings-section-head">
            <div>
              <span className="eyebrow">LIVE INPUT</span>
              <h2 id="live-input-title">Voice & vision</h2>
            </div>
            <i className={`settings-live-dot ${micLevel >= 0.08 ? "hearing" : ""}`} aria-hidden="true" />
          </div>

          <label className="settings-field" htmlFor="lumi-voice">
            <span>
              <strong>Voice</strong>
              <small>{selectedVoiceProfile[1]} · {selectedVoiceProfile[2]}</small>
            </span>
            <select
              id="lumi-voice"
              value={voiceName}
              onChange={(event) => onChooseVoice(event.target.value as VoiceName)}
              disabled={sessionActive}
            >
              {voices.map(([name, gender, style]) => (
                <option key={name} value={name}>{name} · {gender} · {style}</option>
              ))}
            </select>
          </label>
          <button
            className={`settings-preview-button voice-preview-${voicePreviewPhase}`}
            type="button"
            onClick={onToggleVoicePreview}
            disabled={sessionActive}
          >
            <span aria-hidden="true">{voicePreviewPhase === "idle" ? "▶" : "■"}</span>
            {voicePreviewPhase === "idle" ? "Preview selected voice" : "Stop preview"}
          </button>

          <label className="settings-field" htmlFor="microphone-device">
            <span>
              <strong>Microphone</strong>
              <small>{micLevel >= 0.08 ? "Hearing you" : "Input device"}</small>
            </span>
            <select
              id="microphone-device"
              value={selectedDeviceId}
              onChange={(event) => onSelectedDeviceChange(event.target.value)}
              disabled={sessionActive}
            >
              <option value="">System default</option>
              {audioInputs.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

          <div className="settings-choice">
            <span>
              <strong>Vision source</strong>
              <small>Screen also enables video-audio translation</small>
            </span>
            <div className="segmented-control" role="group" aria-label="Vision source">
              {videoModes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={videoMode === mode.id ? "selected" : ""}
                  onClick={() => onVideoModeChange(mode.id)}
                  disabled={sessionActive}
                  aria-pressed={videoMode === mode.id}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <McpSettings
          servers={mcpServers}
          url={mcpUrl}
          busy={mcpBusy}
          message={mcpMessage}
          onUrlChange={onMcpUrlChange}
          onConnect={onMcpConnect}
          onReconnect={onMcpReconnect}
          onRemove={onMcpRemove}
          onToolPolicy={onMcpToolPolicy}
          onServerPolicy={onMcpServerPolicy}
        />
      </div>
    </aside>
  );
}
