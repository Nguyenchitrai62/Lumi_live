"use client";

import { useEffect, useRef } from "react";

export function PetalLayer({
  className = "",
  enabled,
}: {
  className?: string;
  enabled: boolean;
}) {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;

    layer.replaceChildren();
    if (!enabled) return;

    layer.classList.remove("petal-field-entering");
    void layer.offsetWidth;
    layer.classList.add("petal-field-entering");

    const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
    let spawnTimer: number | null = null;

    const spawnPetal = (initialProgress = 0) => {
      if (layer.childElementCount >= 28) return;

      const petal = document.createElement("i");
      const direction = Math.random() > .5 ? 1 : -1;
      const width = randomBetween(6, 11);
      const opacity = randomBetween(.34, .68);
      const fallDistance = Math.max(layer.clientHeight, 320) + 36;
      const duration = randomBetween(16, 26);

      petal.style.left = `${randomBetween(1, 97).toFixed(2)}%`;
      petal.style.width = `${width.toFixed(1)}px`;
      petal.style.height = `${(width * randomBetween(.58, .76)).toFixed(1)}px`;
      petal.style.setProperty("--petal-fall-a", `${(fallDistance * .32).toFixed(1)}px`);
      petal.style.setProperty("--petal-fall-b", `${(fallDistance * .67).toFixed(1)}px`);
      petal.style.setProperty("--petal-fall-c", `${fallDistance.toFixed(1)}px`);
      petal.style.setProperty("--petal-drift-a", `${(direction * randomBetween(12, 48)).toFixed(1)}px`);
      petal.style.setProperty("--petal-drift-b", `${(-direction * randomBetween(8, 42)).toFixed(1)}px`);
      petal.style.setProperty("--petal-drift-c", `${(direction * randomBetween(22, 68)).toFixed(1)}px`);
      petal.style.setProperty("--petal-turn-a", `${(direction * randomBetween(65, 145)).toFixed(0)}deg`);
      petal.style.setProperty("--petal-turn-b", `${(direction * randomBetween(170, 285)).toFixed(0)}deg`);
      petal.style.setProperty("--petal-turn-c", `${(direction * randomBetween(300, 520)).toFixed(0)}deg`);
      petal.style.setProperty("--petal-opacity", opacity.toFixed(2));
      petal.style.setProperty("--petal-fade-opacity", (opacity * .36).toFixed(2));
      petal.style.setProperty("--petal-scale", randomBetween(.72, 1.18).toFixed(2));
      petal.style.animationDuration = `${duration.toFixed(2)}s`;
      if (initialProgress > 0) {
        petal.style.animationDelay = `${-(duration * initialProgress).toFixed(2)}s`;
      }
      petal.addEventListener("animationend", () => petal.remove(), { once: true });
      layer.append(petal);
    };

    const scheduleNext = () => {
      spawnTimer = window.setTimeout(() => {
        spawnPetal();
        scheduleNext();
      }, randomBetween(420, 1100));
    };

    for (let index = 0; index < 16; index += 1) {
      spawnPetal(randomBetween(.08, .88));
    }
    scheduleNext();

    return () => {
      if (spawnTimer !== null) window.clearTimeout(spawnTimer);
      layer.classList.remove("petal-field-entering");
      layer.replaceChildren();
    };
  }, [enabled]);

  return <div ref={layerRef} className={`web-petal-field ${className}`} aria-hidden="true" />;
}
