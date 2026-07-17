"use client";

import { useEffect, useState } from "react";
import {
  PIXEL_AVATAR,
  type PixelAvatarState,
} from "../lib/avatar-catalog";

export function PixelAvatar({ state }: { state: PixelAvatarState }) {
  const [frame, setFrame] = useState(0);
  const animation = PIXEL_AVATAR.animations[state];

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setFrame((current) => (current + 1) % PIXEL_AVATAR.columns);
    }, animation.frameDurationMs);
    return () => window.clearInterval(intervalId);
  }, [animation.frameDurationMs]);

  return (
    <div
      className={`pixel-avatar-widget pixel-avatar-${state}`}
      role="status"
      aria-label={`${PIXEL_AVATAR.name}: ${animation.label}`}
    >
      <div
        className="pixel-avatar-sprite"
        aria-hidden="true"
        style={{
          backgroundImage: `url("${PIXEL_AVATAR.spritesheetPath}")`,
          backgroundSize: `${PIXEL_AVATAR.columns * 100}% ${PIXEL_AVATAR.rows * 100}%`,
          backgroundPosition: `${(frame / (PIXEL_AVATAR.columns - 1)) * 100}% ${(animation.row / (PIXEL_AVATAR.rows - 1)) * 100}%`,
        }}
      />
    </div>
  );
}
