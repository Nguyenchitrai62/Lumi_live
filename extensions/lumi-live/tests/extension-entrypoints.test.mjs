import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const extensionRoot = new URL("../", import.meta.url);

async function assertFileExists(relativePath) {
  await assert.doesNotReject(
    access(new URL(relativePath, extensionRoot)),
    `Expected extension file to exist: ${relativePath}`,
  );
}

async function collectLocalModules(entryPath, visited = new Set()) {
  const moduleUrl = new URL(entryPath, extensionRoot);
  if (visited.has(moduleUrl.href)) return visited;
  visited.add(moduleUrl.href);
  const source = await readFile(moduleUrl, "utf8");
  const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    if (!match[1].startsWith(".")) continue;
    const dependencyUrl = new URL(match[1], moduleUrl);
    await assert.doesNotReject(
      access(dependencyUrl),
      `Could not resolve ${match[1]} imported by ${moduleUrl.pathname}`,
    );
    await collectLocalModules(dependencyUrl.href, visited);
  }
  return visited;
}

test("manifest and HTML entrypoints keep their stable unpacked-extension paths", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionRoot), "utf8"));
  assert.ok(manifest.permissions.includes("identity"));
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("debugger"));
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
  assert.match(manifest.version, /^\d+(?:\.\d+){0,3}$/);
  assert.equal(Object.hasOwn(manifest, "oauth2"), false);
  const entrypoints = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    manifest.options_page,
    "offscreen/index.html",
    "settings/microphone-permission.html",
    "dist/controller.js",
  ];
  await Promise.all(entrypoints.map(assertFileExists));

  for (const htmlPath of entrypoints.filter((entry) => entry.endsWith(".html"))) {
    const htmlUrl = new URL(htmlPath, extensionRoot);
    const html = await readFile(htmlUrl, "utf8");
    const assetPattern = /(?:src|href)=["']([^"']+)["']/g;
    for (const match of html.matchAll(assetPattern)) {
      if (/^(?:https?:|#)/.test(match[1])) continue;
      await assert.doesNotReject(
        access(new URL(match[1], htmlUrl)),
        `Could not resolve ${match[1]} referenced by ${htmlPath}`,
      );
    }
  }
});

test("every local import reachable from a Chrome runtime entrypoint resolves", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionRoot), "utf8"));
  const moduleEntrypoints = [
    manifest.background.service_worker,
    "side-panel/index.js",
    "settings/index.js",
    "offscreen/index.js",
    "settings/microphone-permission.js",
  ];
  const graphs = await Promise.all(moduleEntrypoints.map((entry) => collectLocalModules(entry)));
  assert.ok(graphs.every((graph) => graph.size > 0));
});

test("Fast workspace reconnect and manual tab grouping stay background-safe", async () => {
  const worker = await readFile(new URL("background/index.js", extensionRoot), "utf8");
  const controller = await readFile(new URL("side-panel/index.js", extensionRoot), "utf8");
  const lifecycleSetupSource = worker.slice(
    worker.indexOf("const sidePanelLifecycle = createSidePanelLifecycle"),
    worker.indexOf("chrome.runtime.onConnect.addListener"),
  );
  const restoreSource = worker.slice(
    worker.indexOf("async function restoreOrActivateFastWorkspace"),
    worker.indexOf("async function applyFastModeEnabled"),
  );
  const panelInitializationSource = worker.slice(
    worker.indexOf('if (message.command === "initialize_side_panel")'),
    worker.indexOf('if (message.command === "connect_active_tab")'),
  );

  assert.doesNotMatch(lifecycleSetupSource, /onOpened|activateFastWorkspace/);
  assert.match(restoreSource, /const existingGroup = await fastWorkspace\.getGroup\(\)/);
  assert.match(restoreSource, /activateFastWorkspace\(persistedTarget\.id\)/);
  assert.match(panelInitializationSource, /restoreOrActivateFastWorkspace\(\)/);
  assert.match(controller, /sendRuntime\("initialize_side_panel"\)/);
  assert.match(worker, /Object\.hasOwn\(changeInfo, "groupId"\)/);
  assert.match(worker, /tab\?\.groupId === workspaceGroupId/);
  assert.match(worker, /fastPromptTargetTabId = tabId/);
});

test("PageAgent mask does not consume the host page WebGL context quota", async () => {
  const build = await readFile(new URL("../../build.mjs", import.meta.url), "utf8");
  const cssMotion = await readFile(
    new URL("../browser/css-motion.js", import.meta.url),
    "utf8",
  );
  const controllerBundle = await readFile(
    new URL("../dist/controller.js", import.meta.url),
    "utf8",
  );

  assert.match(build, /page-controller-css-motion/);
  assert.match(build, /filter:\s*\/\^ai-motion\$\/[\s\S]+browser", "css-motion\.js"/);
  assert.match(cssMotion, /export class Motion/);
  assert.doesNotMatch(cssMotion, /getContext|webgl2|WEBGL_lose_context/);
  assert.match(controllerBundle, /data-lumi-css-motion/);
  assert.doesNotMatch(controllerBundle, /getContext\("webgl2"/);
});

test("side panel exposes an upward thinking picker and sends it in Gemini Live setup", async () => {
  const html = await readFile(new URL("side-panel/index.html", extensionRoot), "utf8");
  const styles = await readFile(new URL("side-panel/styles.css", extensionRoot), "utf8");
  const controller = await readFile(new URL("side-panel/index.js", extensionRoot), "utf8");
  assert.match(html, /id="thinkingButton"/);
  assert.match(html, /id="extensionVersion"/);
  assert.match(html, /data-thinking-level="minimal"/);
  assert.match(html, /data-thinking-level="high"/);
  assert.match(html, /class="secondary mute-control"/);
  assert.match(html, /id="connectionNotice"/);
  assert.match(html, /id="connectionNoticeAction"/);
  assert.match(html, /id="connectionNoticeSettings"[^>]+hidden/);
  assert.match(html, /id="messageQueue"/);
  assert.match(html, /id="messageQueueSteer"/);
  assert.match(html, /id="messageQueueRemove"/);
  assert.match(html, /id="taskFailureNotice"/);
  assert.match(html, /placeholder="Message Lumi…"/);
  assert.doesNotMatch(html, /id="liveBadge"|>Offline<|id="targetTitle"|class="target-card"|PAGEAGENT TARGET|id="targetHint"|id="connectTabButton"/);
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf("</header>") + 9);
  const topActions = topbar.slice(topbar.indexOf('<div class="top-actions"'), topbar.indexOf("</div>", topbar.indexOf('<div class="top-actions"')) + 6);
  assert.match(topActions, /id="chatHistoryButton" class="icon-button top-chat-button"/);
  assert.match(topActions, /id="newChatButton" class="icon-button top-chat-button"/);
  assert.doesNotMatch(topbar, /conversation-toolbar/);
  assert.doesNotMatch(styles, /\.target-card|\.target-copy|\.connect-status|\.conversation-toolbar|\.conversation-selector/);
  assert.doesNotMatch(controller, /targetCard|targetHint|connectTabButton|refreshTarget|TARGET_REFRESH_INTERVAL_MS/);
  assert.match(styles, /\.thinking-menu[^}]+bottom:\s*calc\(100%/);
  assert.match(styles, /\.thinking-summary-chevron[^}]+var\(--ui-motion-disclosure\)/);
  assert.match(styles, /\.mcp-activity-chevron[^}]+var\(--ui-motion-disclosure\)/);
  assert.match(styles, /\.mcp-activity\[data-expanded="true"\]/);
  assert.match(styles, /\.agent-step-body[^}]+max-height:\s*var\(--ui-task-step-detail-max-height\)/);
  assert.match(styles, /\.agent-step-field-value[^}]+font-size:\s*12px/);
  assert.match(styles, /--task-border:\s*#d9d2e5/);
  assert.match(controller, /createTaskStepView/);
  assert.doesNotMatch(styles, /is-typing|transcript-caret-blink/);
  assert.match(styles, /\.message-queue-steer/);
  assert.match(styles, /\.connection-notice-backdrop[^}]+place-items:\s*center/);
  assert.match(styles, /\.message-form textarea:focus-visible\s*\{[^}]+outline:\s*0/);
  assert.match(controller, /syncTaskFailureNotice\(event,\s*change\)/);
  assert.match(controller, /thinkingConfig:\s*buildThinkingConfig\(sessionThinkingLevel\)/);
  assert.match(controller, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.match(controller, /tools:\s*\[\{ functionDeclarations \}\]/);
  assert.match(
    controller,
    /const actionDeclarations = \[\.\.\.BUILTIN_TOOLS, \.\.\.mcpFunctionDeclarations\][\s\S]+const functionDeclarations = \[buildAgentStepDeclaration\(actionDeclarations\)\]/,
  );
  assert.match(controller, /sendJson\(buildInitialHistoryClientContent\(conversationHistory\),\s*sourceSocket\)/);
  assert.match(controller, /elements\.messageInput\.disabled\s*=\s*textSendPending/);
  assert.match(controller, /queueUserMessage\(message,\s*attachment\)/);
  assert.match(controller, /function steerQueuedUserMessage\(\)/);
  assert.match(controller, /getTranscriptRevealDurationMs\(remainingCharacterCount\)/);
  assert.match(controller, /function setVisibleTranscriptText\(message,\s*text\)[^]*message\.role === "lumi"[^]*renderMarkdown\(message\.content,\s*visibleText\)/);
  assert.match(controller, /setVisibleTranscriptText\(\s*message,\s*targetCharacters\.slice\(0,\s*visibleCharacterCount\)\.join\(""\)/);
  assert.match(controller, /attachAnimatedDisclosure/);
  assert.match(controller, /scrollTranscriptToLatest\(\)/);
  assert.match(controller, /revealTranscriptText\(message,\s*message\.text\)/);
  assert.doesNotMatch(controller, /Greet the user warmly/);
  assert.match(controller, /buildSessionHandshakeConfig\(resumptionHandle\)/);
  assert.match(controller, /response\.sessionResumptionUpdate/);
  assert.match(controller, /response\.goAway/);
  assert.match(controller, /scheduleAutomaticSessionReconnect/);
  assert.doesNotMatch(controller, /armSessionRotation|SESSION_CONNECTION_ROTATION_MS/);
  assert.doesNotMatch(
    controller,
    /stopSession|restartSessionWithContext|reconnectRequiredForUserWork|Gemini Live disconnected while idle/,
  );
  assert.doesNotMatch(controller, /MAX_AUTOMATIC_SESSION_RECONNECT_ATTEMPTS/);
  assert.match(controller, /!userTurnAuthorized && hasTurnPayload/);
  assert.match(controller, /const hasActionableTurnPayload = Boolean/);
  assert.match(controller, /if \(hasActionableTurnPayload\) panelAudio\.stopPlayback\(\)/);
  assert.doesNotMatch(
    controller,
    /Ignored a Gemini Live turn because no user input authorized it/,
  );
  assert.match(
    controller,
    /!resumedExistingSession && conversationHistory\.length/,
  );
  const reconnectSource = controller.slice(
    controller.indexOf("function scheduleAutomaticSessionReconnect"),
    controller.indexOf("function resetSessionRecoveryState"),
  );
  assert.match(reconnectSource, /reconnectInBackground\s*=\s*sessionStatus === "ready"/);
  assert.match(reconnectSource, /canHandoffBeforeClosing/);
  assert.match(reconnectSource, /predecessorSocket:\s*previousSocket/);
  assert.match(reconnectSource, /if \(!reconnectInBackground\)\s*\{\s*setSessionStatus\("connecting"/);
  assert.match(reconnectSource, /background:\s*reconnectInBackground,\s*discardOldContext/);
  assert.doesNotMatch(controller, /shouldRefreshLiveContext\(response\.usageMetadata\)/);
  assert.match(controller, /discardOldContext \? "" : sessionResumptionHandle/);
  assert.match(controller, /pendingSessionHandoffSocket\s*=\s*sessionSocket/);
  assert.match(controller, /predecessorSocket\.close\(1000,\s*"Gemini Live handoff complete"\)/);
  assert.match(
    controller,
    /!expected && !isGeminiKeyIssue\(reason\) && shouldMaintainGeminiSession/,
  );
  assert.match(
    controller,
    /reason \|\| "Gemini Live transport closed\.",\s*\{ allowInFlight: true \}/,
  );
  assert.match(
    controller,
    /serverRotationPending && !sessionHasInFlightWork\(\)[^]*delayMs: 0/,
  );
  const unloadSource = controller.slice(
    controller.indexOf('window.addEventListener("unload"'),
    controller.indexOf('window.addEventListener("focus"'),
  );
  assert.match(unloadSource, /websocket\?\.close\(\)/);
  assert.match(unloadSource, /cleanupMedia\(\)/);
  assert.doesNotMatch(unloadSource, /clearConversationContext\(\)/);
  assert.match(controller, /getLiveModelPartTranscriptRole\(part\)/);
  assert.match(controller, /updateTranscript\(transcriptRole,\s*part\.text\)/);
  assert.match(controller, /document\.createElement\("details"\)/);
  assert.match(controller, /serverContent\?\.generationComplete\s*\|\|\s*functionCalls\.length/);
  assert.match(controller, /message\.disclosure\?\.setExpanded\(false\)/);
  assert.match(controller, /completedThinkingMessagesAwaitingContent\.add\(message\)/);
  assert.match(controller, /if \(role === "lumi"\) scheduleCompletedThinkingCollapse\(\)/);
  assert.doesNotMatch(controller, /createMessage\("thinking",\s*"Thinking/);
  assert.match(controller, /showMissingKeyNotice\(message\)/);
  assert.match(controller, /showReconnectNotice\(message/);
  assert.match(controller, /EARLY_CONNECTION_DROP_MS\s*=\s*3000/);
  assert.match(controller, /performance\.now\(\) - sessionReadyAt <= EARLY_CONNECTION_DROP_MS/);
  assert.match(controller, /showReconnectNotice\(message,\s*\{ earlyDisconnect: disconnectedSoonAfterConnect \}\)/);
  assert.match(controller, /earlyDisconnect \? "Check Settings" : "Open Settings"/);
  assert.match(controller, /connectionNoticeSettings[^]*openSettings\(\)/);
  assert.match(controller, /initialConnectionPromise = autoStartSessionIfReady\(\)/);
  assert.ok(
    controller.indexOf("initialConnectionPromise = autoStartSessionIfReady()")
      < controller.indexOf("await avatarController.applyMode"),
  );
  assert.match(controller, /NEW_CHAT_CONTEXT_BOUNDARY/);
  assert.match(controller, /function sendPendingConversationBoundary\(\)/);
  const queueSource = controller.slice(
    controller.indexOf("function queueUserMessage"),
    controller.indexOf("function steerQueuedUserMessage"),
  );
  const steerSource = controller.slice(
    controller.indexOf("function steerQueuedUserMessage"),
    controller.indexOf("function removeQueuedUserMessage"),
  );
  assert.doesNotMatch(queueSource, /cancelCurrentTurn\(\)/);
  assert.match(steerSource, /cancelCurrentTurn\(\)/);

  const mcpController = await readFile(
    new URL("side-panel/mcp-panel-controller.js", extensionRoot),
    "utf8",
  );
  assert.match(mcpController, /attachAnimatedDisclosure\(\{ root, summary, body \}\)/);
});

test("side panel connects chat without requiring a microphone and remembers mic preference", async () => {
  const controller = await readFile(new URL("side-panel/index.js", extensionRoot), "utf8");
  const audioController = await readFile(
    new URL("side-panel/panel-audio-controller.js", extensionRoot),
    "utf8",
  );
  const config = await readFile(new URL("core/extension-config.js", extensionRoot), "utf8");
  const html = await readFile(new URL("side-panel/index.html", extensionRoot), "utf8");
  const startSessionSource = controller.slice(
    controller.indexOf("async function startSession"),
    controller.indexOf("async function autoStartSessionIfReady"),
  );
  const autoStartSource = controller.slice(
    controller.indexOf("async function autoStartSessionIfReady"),
    controller.indexOf("function syncMuteButton"),
  );
  const toggleSource = controller.slice(
    controller.indexOf("async function enableMicrophone"),
    controller.indexOf("function sendText"),
  );

  assert.match(config, /microphoneEnabled:\s*"lumiMicrophoneEnabled"/);
  assert.match(html, /id="muteButton"[^>]+aria-label="Turn on microphone"[^>]+aria-pressed="true"/);
  assert.match(controller, /let isMuted = true/);
  assert.match(startSessionSource, /await panelAudio\.prepareOutput\(\)/);
  assert.doesNotMatch(startSessionSource, /validateGeminiApiKey|v1beta\/models\?pageSize/);
  assert.match(startSessionSource, /if \(microphoneEnabled\)[^]*panelAudio\.requestMicrophone\(\)/);
  assert.match(startSessionSource, /microphoneWarning = `\$\{diagnosis\.message\} Chat is still connected\.`/);
  assert.doesNotMatch(autoStartSource, /refreshMicrophonePermission|openMicrophonePermissionPage/);
  assert.match(toggleSource, /\[MICROPHONE_ENABLED_STORAGE_KEY\]: true/);
  assert.match(toggleSource, /\[MICROPHONE_ENABLED_STORAGE_KEY\]: false/);
  assert.match(toggleSource, /panelAudio\.stopMicrophone\(\)/);
  assert.match(controller, /function canUseMicrophoneControl\(\)[^]*sessionStatus === "ready" \|\| sessionStatus === "idle"/);
  assert.match(toggleSource, /sessionStatus === "idle"[^]*autoStartSessionIfReady\(\)/);
  assert.match(audioController, /async function prepareOutput\(\)/);
  assert.match(audioController, /function isUserSpeechActive\(\)/);
  assert.match(audioController, /function stopMicrophone\(\)/);
  assert.match(controller, /sessionHasInFlightWork\(\)[^]*panelAudio\.isUserSpeechActive\(\)/);
  assert.doesNotMatch(html, /id="startButton"/);
  assert.doesNotMatch(controller, /elements\.startButton/);
});

test("side panel keeps Lumi's layout while improving contrast and primary control ergonomics", async () => {
  const html = await readFile(new URL("side-panel/index.html", extensionRoot), "utf8");
  const controller = await readFile(new URL("side-panel/index.js", extensionRoot), "utf8");
  const styles = await readFile(new URL("side-panel/styles.css", extensionRoot), "utf8");
  const formStart = html.indexOf('<form id="messageForm"');
  const formEnd = html.indexOf("</form>", formStart);
  const messageForm = html.slice(formStart, formEnd);

  assert.doesNotMatch(html, /target-card|connectTabButton|PAGEAGENT TARGET/);
  assert.doesNotMatch(html, /class="voice-controls"/);
  assert.match(messageForm, /id="imageAttachmentButton"/);
  assert.match(messageForm, /id="messageInput"/);
  assert.match(messageForm, /id="muteButton"/);
  assert.match(messageForm, /id="messageSubmit"/);
  assert.match(styles, /--line-strong:/);
  assert.match(styles, /--focus-ring:/);
  assert.match(styles, /\.icon-button\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;/);
  assert.match(styles, /\.message-form\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,1fr\) auto auto;/);
  assert.match(styles, /\.message-form button\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/);
  assert.match(styles, /\.chat-session-delete\s*\{[^}]*opacity:\s*\.62;/);
  assert.match(controller, /function appendMessageTimestamp\(/);
  assert.match(controller, /function beginTurnWork\(/);
  assert.match(controller, /function finishTurnWork\(/);
  assert.match(controller, /function createVideoSummaryPresentationMessage\(/);
  assert.match(controller, /directVideoPresentationTurnSequence === turnExecutionSequence/);
  assert.match(controller, /prepareVideoAnalysisAgentResult\(result, args\)/);
  assert.match(styles, /\.message \.message-meta/);
  assert.match(styles, /\.turn-work-status/);
  assert.match(styles, /@keyframes turn-work-dot/);
  assert.match(styles, /body\.fast-mode \.agent-step-card\[data-state="running"\] \.agent-step-marker::after\s*\{[^}]*animation-duration:[^}]*animation-iteration-count:\s*infinite/);
  assert.match(styles, /@media \(prefers-contrast: more\)/);
  assert.match(styles, /@media \(forced-colors: active\)/);
});

test("captures visual context only when the agent requests it and renders rich conversation Markdown", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionRoot), "utf8"));
  const worker = await readFile(new URL("background/index.js", extensionRoot), "utf8");
  const sessionConfig = await readFile(new URL("live/session-config.js", extensionRoot), "utf8");
  const controller = await readFile(new URL("side-panel/index.js", extensionRoot), "utf8");
  const browserToolRunner = await readFile(new URL("side-panel/browser-tool-runner.js", extensionRoot), "utf8");
  const audioController = await readFile(new URL("side-panel/panel-audio-controller.js", extensionRoot), "utf8");
  const markdown = await readFile(new URL("side-panel/markdown-renderer.js", extensionRoot), "utf8");
  const styles = await readFile(new URL("side-panel/styles.css", extensionRoot), "utf8");

  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("tabs"));
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  for (const unrelatedPermission of [
    "clipboardRead",
    "clipboardWrite",
    "cookies",
    "downloads",
    "history",
  ]) {
    assert.equal(manifest.permissions.includes(unrelatedPermission), false);
  }
  assert.match(sessionConfig, /name:\s*"browser_inspect_screenshot"/);
  assert.match(sessionConfig, /name:\s*"browser_capture_screenshot"/);
  assert.match(worker, /chrome\.tabs\.captureVisibleTab/);
  assert.match(worker, /saveCapturedTabAsset/);
  assert.match(worker, /capture_tab_context_frame/);
  assert.match(worker, /captureActiveTabContextFrame\(message\.windowId\)/);
  assert.match(worker, /function isControllablePage[\s\S]+isWebPage\(url\) \|\| isFilePage\(url\)/);
  assert.match(worker, /tabs:\s*listedTabs\.map\(serializeTab\)/);
  assert.match(worker, /function serializeTab\(tab\)[^]*sanitizeActiveContextUrl\(tab\.url/);
  assert.match(worker, /controllable:\s*isControllablePage\(url\)/);
  assert.match(worker, /Allow access to file URLs/);
  assert.match(worker, /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/);
  assert.match(worker, /describeTabCaptureError/);
  assert.match(controller, /captureCurrentTabFrame\(\)/);
  assert.match(controller, /chrome\.windows\.getCurrent\(\)/);
  assert.match(controller, /inspectScreenshot:\s*captureAndSendVisualInspectionFrame/);
  assert.match(browserToolRunner, /tool === "browser_inspect_screenshot"[^]*await inspectScreenshot\(\)/);
  assert.match(controller, /addBrowserWorkflowContext\(result/);
  assert.match(controller, /observation:\s*actionResult/);
  assert.doesNotMatch(controller, /boundAgentObservationForModel/);
  assert.match(controller, /activeTurnUserRequest = userRequestText/);
  assert.doesNotMatch(controller, /AUTOMATIC_TAB_CAPTURE_ORIGINS|screenshotAccessRequest/);
  assert.doesNotMatch(controller, /chrome\.permissions\.(?:request|contains)\(\{\s*origins:/);
  assert.match(controller, /realtimeInput:\s*\{\s*video:\s*frame\s*\}/);
  assert.match(controller, /VISUAL_CONTEXT_SETTLE_MS/);
  assert.match(controller, /delivery:\s*"best_effort_realtime_visual_context"/);
  assert.match(controller, /sendJson\(\{\s*realtimeInput:\s*\{\s*video:\s*frame\s*\}\s*\}\)/);
  assert.match(controller, /sendJson\(\{\s*realtimeInput:\s*\{\s*text:\s*modelText\s*\}\s*\}\)/);
  assert.match(controller, /await sendRuntime\("prepare_browser_prompt"\)/);
  assert.match(
    controller,
    /if \(!videoSent \|\| !textSent\)[^]*The connection stays open for retry/,
  );
  const failedMessageSendSource = controller.slice(
    controller.indexOf("if (!videoSent || !textSent)"),
    controller.indexOf("if (boundaryPrompt) pendingConversationBoundary = false"),
  );
  assert.doesNotMatch(failedMessageSendSource, /\.close\(|cleanupMedia\(/);
  const speechStartCallback = controller.match(
    /onUserSpeechStart:\s*\(\) => \{[^]*?\r?\n  \},\r?\n  sendJson/,
  )?.[0] || "";
  assert.ok(speechStartCallback);
  assert.doesNotMatch(speechStartCallback, /captureAndSend/);
  assert.match(audioController, /onUserSpeechStart\?\.\(\)/);
  assert.match(audioController, /MICROPHONE_SPEECH_CONFIRMATION_MS/);
  assert.match(audioController, /retainPreRollFrame\(mono\)/);
  assert.match(audioController, /if \(!inputState\.canSendAudio\)[^]*resetMicrophoneGate\(\)/);
  assert.match(controller, /showCapturedScreenshot:\s*createCapturedTabMessage/);
  assert.match(browserToolRunner, /showCapturedScreenshot\(result\)/);
  assert.match(controller, /renderMarkdown\(message\.content,\s*message\.text\)/);
  assert.match(controller, /elements\.transcript\.addEventListener\("click"[\s\S]+chrome\.tabs\.create\(\{\s*url,\s*active:\s*true\s*\}\)/);
  assert.match(markdown, /function renderTable/);
  assert.match(markdown, /function reconcileChildren/);
  assert.doesNotMatch(markdown, /container\.replaceChildren\(\)/);
  assert.match(markdown, /isSafeMarkdownUrl/);
  assert.match(styles, /\.markdown-table-scroll/);
  assert.match(styles, /\.markdown-body a:hover[^}]+background/);
  assert.match(styles, /\.message-capture/);
  assert.match(worker, /target:\s*\{\s*tabId,\s*allFrames:\s*true\s*\}/);
  assert.match(worker, /waitForClickedTabToSettle\(tab\.id,\s*action\)/);
  assert.match(worker, /if \(!openedTab && !clickError\)/);
});

test("opens a requested website even when the current tab cannot host PageAgent", async () => {
  const worker = await readFile(new URL("background/index.js", extensionRoot), "utf8");
  const openTabSource = worker.slice(
    worker.indexOf("async function openBrowserTab"),
    worker.indexOf("async function switchBrowserTab"),
  );

  assert.match(worker, /TAB_TRANSITION_FALLBACK_URL\s*=\s*"https:\/\/www\.google\.com\/"/);
  assert.match(openTabSource, /if \(!departureTab\)[\s\S]+chrome\.tabs\.create\(\{ url: TAB_TRANSITION_FALLBACK_URL, active: true \}\)/);
  assert.match(openTabSource, /bridge_show_google_search_departure/);
  assert.match(openTabSource, /chrome\.tabs\.update\(createdTab\.id, \{ url, active: true \}\)/);
  assert.doesNotMatch(openTabSource, /needs a controllable current page/);
});

test("settings ships OAuth and URL-key connectors, app icons, URL copy, and a temporary server toggle", async () => {
  const html = await readFile(new URL("settings/index.html", extensionRoot), "utf8");
  const controller = await readFile(
    new URL("settings/mcp-settings-controller.js", extensionRoot),
    "utf8",
  );
  const styles = await readFile(new URL("settings/styles.css", extensionRoot), "utf8");
  assert.match(html, /id="mcpConnectorModal"/);
  assert.match(html, /id="mcpAddModal" class="mcp-connector-modal-backdrop" hidden/);
  assert.match(html, /id="mcpAddForm"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /id="mcpConnectorModalFields"/);
  assert.match(html, /id="mcpConnectorCatalog"/);
  assert.match(styles, /\.settings-grid[^}]+repeat\(12, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.settings-column[^}]+grid-column:\s*span 3[^}]+grid-template-columns:\s*1fr[^}]+grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]+align-self:\s*stretch/);
  assert.match(styles, /\.connection-card[^}]+grid-column:\s*span 9/);
  assert.match(html, /class="connection-fields"/);
  assert.match(html, /class="connection-field api-field"/);
  assert.match(html, /class="connection-field voice-field"/);
  assert.match(styles, /\.connection-fields[^}]+repeat\(2, minmax\(0, 1fr\)\)[^}]+gap:\s*14px/);
  assert.match(styles, /\.mcp-card[^}]+grid-column:\s*1 \/ -1/);
  assert.match(html, /icons\/connectors\/mcp\.svg/);
  assert.match(controller, /mcp_set_server_enabled/);
  assert.match(controller, /connectOauthConnector/);
  assert.match(controller, /connector\?\.fields\?\.length/);
  assert.match(controller, /connector\?\.auth === "oauth-dcr"/);
  assert.match(controller, /copyMcpServerUrl/);
  assert.match(controller, /availableConnectors[\s\S]*!mcpServers\.some/);
  assert.match(controller, /connector\?\.icon \|\| DEFAULT_MCP_ICON/);
  assert.match(controller, /event\.target === elements\.mcpAddModal/);
  assert.match(controller, /!elements\.mcpAddModal\.hidden[^]*toggleMcpAddForm\(false\)/);
  assert.match(styles, /\.mcp-connector-mark img/);
});

test("connector OAuth stays inside the extension and never calls a Lumi broker", async () => {
  const auth = await readFile(
    new URL("background/mcp-connector-auth.js", extensionRoot),
    "utf8",
  );
  const connectors = await readFile(
    new URL("core/mcp-connectors.js", extensionRoot),
    "utf8",
  );
  assert.match(auth, /chrome\.identity\.launchWebAuthFlow/);
  assert.match(auth, /chrome\.storage\.local/);
  assert.match(auth, /registration_endpoint/);
  assert.doesNotMatch(`${auth}\n${connectors}`, /oauth.?broker/i);
  assert.doesNotMatch(`${auth}\n${connectors}`, /\/api\/oauth\//);
});
