import type { RefObject } from "react";
import { PetalLayer } from "./PetalLayer";
import { PixelAvatar } from "./PixelAvatar";
import { VtuberAvatar } from "./VtuberAvatar";
import type { PixelAvatarState } from "../lib/avatar-catalog";
import { scenes, type Scene } from "../lib/live/config";
import type { LiveTranslationState } from "../lib/live/translation-client";
import type { Outfit, SessionStatus } from "../lib/live/types";

type StudioStageProps = {
  scene: Scene;
  outfit: Outfit;
  petalsEnabled: boolean;
  status: SessionStatus;
  isMuted: boolean;
  mouthFrame: number;
  pixelAvatarState: PixelAvatarState;
  liveTranslationState: LiveTranslationState;
  videoElementRef: RefObject<HTMLVideoElement | null>;
  onSceneChange: (scene: Scene) => void;
  onOutfitChange: (outfit: Outfit) => void;
  onPetalsChange: (enabled: boolean) => void;
  onToggleMute: () => void;
  onStartSession: () => void;
};

export function StudioStage({
  scene,
  outfit,
  petalsEnabled,
  status,
  isMuted,
  mouthFrame,
  pixelAvatarState,
  liveTranslationState,
  videoElementRef,
  onSceneChange,
  onOutfitChange,
  onPetalsChange,
  onToggleMute,
  onStartSession,
}: StudioStageProps) {
  const translating = liveTranslationState === "active"
    || liveTranslationState === "connecting"
    || liveTranslationState === "reconnecting";

  return (
    <section className={`stage scene-${scene} ${petalsEnabled ? "petals-enabled" : "petals-disabled"}`} aria-label={`${scenes.find((item) => item.id === scene)?.name} character stage`}>
      <div className="scene-glow" />
      <div className="scene-motion" aria-hidden="true">
        <span className="scene-haze" />
        <span className="ambient-mote ambient-mote-one" />
        <span className="ambient-mote ambient-mote-two" />
        <span className="ambient-mote ambient-mote-three" />
        <span className="ambient-mote ambient-mote-four" />
      </div>
      <PetalLayer className="stage-petal-field" enabled={petalsEnabled} />
      <video ref={videoElementRef} className="capture-video" autoPlay muted playsInline aria-hidden="true" />
      <div className="stage-toolbar">
        <span className="stage-kicker">NOW TOGETHER</span>
        <div className="stage-customize" aria-label="Character appearance controls">
          <div>
            <span className="customize-label">SCENE</span>
            <div className="scene-options">
              {scenes.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`scene-option scene-chip-${item.id} ${scene === item.id ? "selected" : ""}`}
                  onClick={() => onSceneChange(item.id)}
                  aria-label={item.name}
                  aria-pressed={scene === item.id}
                  title={item.name}
                >
                  <span>{item.symbol}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="customize-label">OUTFIT</span>
            <div className="outfit-options">
              <button type="button" className={outfit === "casual" ? "selected" : ""} onClick={() => onOutfitChange("casual")} aria-pressed={outfit === "casual"}>Cozy</button>
              <button type="button" className={outfit === "moonlit" ? "selected" : ""} onClick={() => onOutfitChange("moonlit")} aria-pressed={outfit === "moonlit"}>Moonlit</button>
            </div>
          </div>
          <button
            className="petal-toggle stage-petal-toggle"
            type="button"
            aria-label={petalsEnabled ? "Turn petals off" : "Turn petals on"}
            aria-pressed={petalsEnabled}
            onClick={() => onPetalsChange(!petalsEnabled)}
            title="Petals"
          >
            <span className="petal-toggle-icon" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className={`avatar avatar-${outfit}`} aria-label={`Lumi wearing the ${outfit} outfit`}>
        <VtuberAvatar outfit={outfit} mouthFrame={mouthFrame} />
      </div>

      <div className="stage-caption">
        <div>
          <span className="name-row">Lumi <span>✦</span></span>
          <span className="mood-row">{status === "ready" ? (isMuted ? "Waiting quietly" : "Listening to you") : "Your starlight companion"}</span>
        </div>
        <div className={`voice-wave ${mouthFrame > 0 ? "voice-wave-active" : ""}`} aria-hidden="true">
          <i /><i /><i /><i /><i />
        </div>
        <PixelAvatar state={pixelAvatarState} />
      </div>

      <div className="call-dock">
        {status === "ready" && (
          <button className={`round-control ${isMuted ? "round-control-muted" : ""}`} type="button" onClick={onToggleMute} aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}>
            {isMuted ? "×" : "⌁"}
          </button>
        )}
        <button className={`voice-button voice-button-${status}`} type="button" onClick={onStartSession} disabled={status === "connecting"}>
          <span className={status === "ready" ? "stop-symbol" : "mic-icon"} aria-hidden="true" />
          <span>{status === "ready"
            ? translating ? "End live chat + translate" : "End live chat"
            : status === "connecting" ? "Connecting live chat…" : "Start live chat"}</span>
        </button>
      </div>
    </section>
  );
}
