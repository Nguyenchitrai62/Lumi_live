import assert from "node:assert/strict";
import test from "node:test";

import { buildSharedTabAudioConstraints } from "../side-panel/shared-tab-audio-controller.js";

test("shared-tab fallback requests a Chrome tab with audio", () => {
  const { constraints, suppressLocalPlayback } = buildSharedTabAudioConstraints({
    suppressLocalAudioPlayback: true,
  });
  assert.equal(constraints.video.displaySurface, "browser");
  assert.deepEqual(constraints.audio, { suppressLocalAudioPlayback: true });
  assert.equal(constraints.selfBrowserSurface, "exclude");
  assert.equal(suppressLocalPlayback, true);
});

test("shared-tab fallback remains usable when playback suppression is unavailable", () => {
  const { constraints, suppressLocalPlayback } = buildSharedTabAudioConstraints({});
  assert.equal(constraints.audio, true);
  assert.equal(suppressLocalPlayback, false);
});
