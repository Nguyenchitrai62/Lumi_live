import assert from "node:assert/strict";
import test from "node:test";

import {
  captureYouTubeVideoClick,
  didClickOpenYouTubeVideo,
  isYouTubeVideoUrl,
} from "./youtube-video-action.js";

test("recognizes YouTube video destinations without matching ordinary pages", () => {
  assert.equal(isYouTubeVideoUrl("https://www.youtube.com/watch?v=abc123"), true);
  assert.equal(isYouTubeVideoUrl("https://youtube.com/shorts/abc123"), true);
  assert.equal(isYouTubeVideoUrl("https://youtu.be/abc123"), true);
  assert.equal(isYouTubeVideoUrl("https://www.youtube.com/results?search_query=lumi"), false);
  assert.equal(isYouTubeVideoUrl("https://example.com/watch?v=abc123"), false);
  assert.equal(isYouTubeVideoUrl(""), false);
});

test("suppresses audio for a video link or a paused video that started playing", () => {
  assert.equal(didClickOpenYouTubeVideo({ opensVideoLink: true }), true);
  assert.equal(didClickOpenYouTubeVideo({
    opensVideoLink: false,
    videoWasPaused: true,
    video: { paused: false },
  }), true);
  assert.equal(didClickOpenYouTubeVideo({
    opensVideoLink: false,
    videoWasPaused: false,
    video: { paused: false },
  }), false);
});

test("captures a relative YouTube watch link from the clicked element", () => {
  const link = { href: "/watch?v=lumi123" };
  const element = {
    ownerDocument: {
      location: { href: "https://www.youtube.com/results?search_query=lumi" },
    },
    closest: () => link,
    matches: () => false,
    querySelector: () => null,
    parentElement: null,
  };
  const capture = captureYouTubeVideoClick(element);
  assert.equal(capture.opensVideoLink, true);
});
