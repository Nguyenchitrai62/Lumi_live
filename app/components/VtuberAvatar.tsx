"use client";

import { useEffect, useState } from "react";
import { VTUBER_AVATAR } from "../lib/avatar-catalog";

type Outfit = "casual" | "moonlit";
type EyeFrame = "open" | "half" | "closed";

export function VtuberAvatar({ outfit, mouthFrame }: { outfit: Outfit; mouthFrame: number }) {
  const [eyeFrame, setEyeFrame] = useState<EyeFrame>("open");

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const later = (callback: () => void, delay: number) => {
      timer = setTimeout(() => {
        if (!stopped) callback();
      }, delay);
    };
    const scheduleBlink = () => later(runBlink, 2600 + Math.random() * 4200);
    const runBlink = () => {
      setEyeFrame("half");
      later(() => {
        setEyeFrame("closed");
        later(() => {
          setEyeFrame("half");
          later(() => {
            setEyeFrame("open");
            scheduleBlink();
          }, 72);
        }, 105 + Math.random() * 55);
      }, 58);
    };

    scheduleBlink();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const layer = (file: string, className: string, active: boolean) => (
    // Every facial sprite is transparent outside its own generated eye/mouth art.
    // All layers share one 1086x1448 canvas for pixel-stable placement.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={file}
      src={`${VTUBER_AVATAR.assetRoot}/${file}.png`}
      className={`lumi-rig-layer ${className}${active ? " is-active" : ""}`}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );

  return (
    <div className="lumi-rig" aria-label={`Lumi wearing the ${outfit} outfit`}>
      <div className="lumi-rig-canvas">
        {layer(`hair-back-${outfit}`, "lumi-rig-hair-back", true)}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="lumi-rig-layer lumi-rig-base"
          src={`${VTUBER_AVATAR.assetRoot}/base-${outfit}.png`}
          alt="Lumi, an anime VTuber with pale blue hair and violet eyes"
          draggable={false}
        />

        {(["open", "half", "closed"] as EyeFrame[]).map((frame) =>
          layer(`eyes-${frame}`, "lumi-rig-eye-sprite", eyeFrame === frame),
        )}
        {layer("mouth-neutral", "lumi-rig-mouth-sprite", mouthFrame === 0)}
        {layer("mouth-small", "lumi-rig-mouth-sprite", mouthFrame === 1)}
        {layer("mouth-wide", "lumi-rig-mouth-sprite", mouthFrame === 2)}
        {layer(`hair-front-${outfit}`, "lumi-rig-hair-front", true)}
      </div>
    </div>
  );
}
