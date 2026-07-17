import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAvatarMode,
  normalizePixelAvatarManifest,
} from "./pixel-avatar-controller.js";

test("normalizes legacy and current pixel modes to pixel", () => {
  assert.equal(normalizeAvatarMode("legacy-pixel-mode"), "pixel");
  assert.equal(normalizeAvatarMode("pixel"), "pixel");
  assert.equal(normalizeAvatarMode("vtuber"), "vtuber");
});

test("keeps valid pixel avatar animation metadata", () => {
  const manifest = normalizePixelAvatarManifest({
    spritesheet: "spritesheet.png",
    columns: 8,
    rows: 9,
    animations: {
      idle: { row: 0, frames: 8, frameDurationMs: 280 },
      invalid: { row: 20, frames: 8, frameDurationMs: 280 },
    },
  });

  assert.deepEqual(manifest.animations.idle, {
    row: 0,
    frames: 8,
    frameDurationMs: 280,
    loop: true,
  });
  assert.equal(manifest.animations.invalid, undefined);
});

test("rejects a pixel avatar manifest without idle", () => {
  assert.throws(
    () => normalizePixelAvatarManifest({
      spritesheet: "spritesheet.png",
      columns: 8,
      rows: 9,
      animations: {},
    }),
    /missing its idle animation/,
  );
});
