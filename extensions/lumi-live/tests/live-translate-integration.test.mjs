import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("toolbar action only toggles the side panel while video audio capture stays automatic", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const worker = await readFile(new URL("../background/index.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../side-panel/index.js", import.meta.url), "utf8");
  const offscreen = await readFile(new URL("../offscreen/index.js", import.meta.url), "utf8");

  assert.ok(!manifest.permissions.includes("tabCapture"));
  assert.ok(manifest.permissions.includes("offscreen"));
  assert.ok(!manifest.permissions.includes("desktopCapture"));
  assert.equal(manifest.action.default_title, "Toggle Lumi Live");
  assert.match(worker, /setPanelBehavior\(\{ openPanelOnActionClick: true \}\)/);
  assert.doesNotMatch(worker, /chrome\.action\.onClicked\.addListener/);
  assert.doesNotMatch(worker, /chrome\.tabCapture\.getMediaStreamId/);
  assert.match(worker, /chrome\.offscreen\.createDocument/);
  assert.doesNotMatch(offscreen, /chromeMediaSource: "tab"/);
  assert.match(offscreen, /prepareExternalCapture/);
  assert.match(worker, /requiresSharedTabAudio: true/);
  assert.match(app, /Share tab audio to continue/);
  assert.match(app, /requestSharedTabAudio/);
  assert.match(offscreen, /sourceInfo\?\.mode === "sharedTab"/);
  assert.match(worker, /releaseCaptureForDifferentTab\(tabId\)/);
  assert.match(worker, /chrome\.windows\.onFocusChanged\.addListener/);
  assert.match(worker, /releaseCaptureForDifferentTab\(tab\?\.id \?\? null\)/);
  assert.match(worker, /port\.name !== "lumi_live_side_panel"/);
  assert.doesNotMatch(worker, /chrome\.sidePanel\.onOpened|chrome\.sidePanel\.onClosed/);
  assert.doesNotMatch(app, /chooseDesktopMedia|desktopCapture/);
});

test("extension automatically captures the active HTML media element", async () => {
  const worker = await readFile(new URL("../background/index.js", import.meta.url), "utf8");
  const pageController = await Promise.all([
    readFile(new URL("../browser/controller.js", import.meta.url), "utf8"),
    readFile(new URL("../browser/media-element-audio-controller.js", import.meta.url), "utf8"),
  ]).then((sources) => sources.join("\n"));
  const offscreen = await readFile(new URL("../offscreen/index.js", import.meta.url), "utf8");
  const translation = await readFile(new URL("../live/translate.js", import.meta.url), "utf8");

  assert.match(worker, /prepareDirectMediaElementAudio\(tab\)/);
  assert.match(worker, /bridge_prepare_media_element_audio/);
  assert.match(worker, /bridge_start_media_element_audio/);
  assert.match(worker, /bridge_stop_media_element_audio/);
  assert.match(worker, /prepare_external_capture/);
  assert.match(pageController, /element\.captureStream \|\| element\.mozCaptureStream/);
  assert.match(pageController, /createMediaElementSource\(capture\.element\)/);
  assert.match(pageController, /assertWebAudioSourceIsReadable/);
  assert.match(pageController, /MediaStreamTrackProcessor/);
  assert.match(pageController, /createScriptProcessor/);
  assert.match(pageController, /command: "external_audio"/);
  assert.match(pageController, /capture\.element\.volume = capture\.duckedVolume/);
  assert.match(pageController, /capture\.element\.volume = capture\.originalVolume/);
  assert.match(offscreen, /sourceInfo\?\.mode === "mediaElement"/);
  assert.match(offscreen, /translationController\.startExternal/);
  assert.match(translation, /sendExternalAudio\(base64Pcm16\)/);
  assert.doesNotMatch(worker, /getDisplayMedia|chooseDesktopMedia/);
});

test("live translation ducks captured source audio and restores it on stop", async () => {
  const controller = await readFile(new URL("../live/translate.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../side-panel/index.js", import.meta.url), "utf8");
  const offscreen = await readFile(new URL("../offscreen/index.js", import.meta.url), "utf8");
  const webMedia = await readFile(new URL("../../../app/lib/live/media.ts", import.meta.url), "utf8");
  const webPage = await readFile(new URL("../../../app/page.tsx", import.meta.url), "utf8");
  assert.match(controller, /suppressLocalAudioPlayback: true/);
  assert.match(controller, /suppressLocalAudioPlayback: false/);
  assert.match(controller, /gain\.gain\.value/);
  assert.match(app, /const sourcePlaybackVolume =/);
  assert.doesNotMatch(offscreen, /setSourceVolume/);
  assert.match(webMedia, /suppressLocalAudioPlayback: true/);
  assert.match(webPage, /setSharedAudioVolume\(0\.06\)/);
  assert.match(webPage, /setSharedAudioVolume\(1\)/);
});

test("live translation uses jitter-buffered low-latency streaming without changing playback speed", async () => {
  const controller = await readFile(new URL("../live/translate.js", import.meta.url), "utf8");
  const worklet = await readFile(new URL("../live/pcm-capture-worklet.js", import.meta.url), "utf8");
  const offscreen = await readFile(new URL("../offscreen/index.js", import.meta.url), "utf8");
  const webController = await readFile(new URL("../../../app/lib/live/translation-client.ts", import.meta.url), "utf8");
  const webWorklet = await readFile(new URL("../../../public/audio/lumi-pcm-capture-worklet.js", import.meta.url), "utf8");

  assert.match(worklet, /CHUNK_DURATION_SECONDS = 0\.1/);
  assert.match(webWorklet, /CHUNK_DURATION_SECONDS = 0\.1/);
  assert.match(controller, /canSendLiveAudio\(websocket\.bufferedAmount\)/);
  assert.match(webController, /canSendLiveAudio\(websocket\.bufferedAmount\)/);
  assert.match(offscreen, /latencyHint: "interactive"/);
  assert.match(controller, /getLiveTranslationChunkStartTime/);
  assert.match(webController, /getLiveTranslationChunkStartTime/);
  assert.doesNotMatch(controller, /MAX_LIVE_TRANSLATION_OUTPUT_BACKLOG_SECONDS/);
  assert.doesNotMatch(webController, /MAX_LIVE_TRANSLATION_OUTPUT_BACKLOG_SECONDS/);
  assert.doesNotMatch(controller, /\.pause\(|seekTo\(/);
  assert.doesNotMatch(controller, /playbackRate/);
  assert.doesNotMatch(webController, /playbackRate/);
});

test("cancel is silent, unlocks promptly, and stops pending translation without a picker", async () => {
  const app = await readFile(new URL("../side-panel/index.js", import.meta.url), "utf8");
  const webPage = await readFile(new URL("../../../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /acknowledge cancellation briefly/i);
  assert.match(app, /suppressServerOutputUntilNextUserTurn = true/);
  assert.match(app, /cancelledTurnBoundarySeen/);
  assert.match(app, /freshUserInputStarted/);
  assert.match(app, /stop_live_translation/);
  assert.doesNotMatch(app, /cancelActiveAudioPicker|chooseDesktopMedia/);
  assert.match(app, /TURN_CANCELLATION_WATCHDOG_MS/);
  assert.match(webPage, /toolRuntimeRef\.current!\.cancelledTurnBoundarySeen/);
  assert.match(webPage, /toolRuntimeRef\.current!\.freshUserInputStarted/);
});

test("extension renders Live Translate as a built-in conversation activity", async () => {
  const app = await readFile(new URL("../side-panel/index.js", import.meta.url), "utf8");
  assert.match(app, /activityLabel: "BUILT-IN TOOL"/);
  assert.match(app, /toolName: LIVE_TRANSLATE_TOOL_NAME/);
  assert.match(app, /serverName: "Gemini Live Translate"/);
  assert.match(app, /if \(activityTool\) createMcpActivityCard/);
  assert.match(app, /if \(activityTool\) finishMcpActivity\(callId, "completed", result\)/);
});

test("web uses PageAgent while remaining scoped to the Lumi Studio document", async () => {
  const webPage = await readFile(new URL("../../../app/page.tsx", import.meta.url), "utf8");
  const pageRuntime = await readFile(new URL("../../../app/lib/live/page-runtime.ts", import.meta.url), "utf8");
  const studioPageAgent = await readFile(new URL("../../../app/lib/live/studio-page-agent.ts", import.meta.url), "utf8");
  assert.match(webPage, /\.\.\.STUDIO_PAGE_AGENT_TOOL_DECLARATIONS/);
  assert.match(webPage, /STUDIO_PAGE_AGENT_GUIDANCE/);
  assert.match(webPage, /toolRuntimeRef\.current!\.studioPageAgent!\.run/);
  assert.match(pageRuntime, /studioPageAgent: new StudioPageAgent\(\)/);
  assert.match(studioPageAgent, /@page-agent\/page-controller/);
  for (const tool of [
    "browser_get_page_state",
    "browser_click",
    "browser_input_text",
    "browser_select_option",
    "browser_scroll",
  ]) assert.match(studioPageAgent, new RegExp(tool));
  assert.match(studioPageAgent, /current Lumi Web Studio document only/);
  assert.doesNotMatch(studioPageAgent, /browser_list_tabs|browser_open_tab|browser_switch_tab/);
  assert.doesNotMatch(studioPageAgent, /chrome\.tabs|window\.open|location\.assign|fetch\(/);
});

test("web translation token constraints omit optional transcription fields", async () => {
  const tokenRoute = await readFile(new URL("../../../app/api/token/route.ts", import.meta.url), "utf8");
  const constraints = tokenRoute.slice(
    tokenRoute.indexOf("const liveTranslationConstraints"),
    tokenRoute.indexOf("const token ="),
  );
  assert.doesNotMatch(constraints, /inputAudioTranscription|outputAudioTranscription/);
});
