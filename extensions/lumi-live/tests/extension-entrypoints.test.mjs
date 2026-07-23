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

test("side panel exposes an upward thinking picker and sends it in Gemini Live setup", async () => {
  const html = await readFile(new URL("side-panel/index.html", extensionRoot), "utf8");
  const styles = await readFile(new URL("side-panel/styles.css", extensionRoot), "utf8");
  const controller = await readFile(new URL("side-panel/index.js", extensionRoot), "utf8");
  assert.match(html, /id="thinkingButton"/);
  assert.match(html, /data-thinking-level="minimal"/);
  assert.match(html, /data-thinking-level="high"/);
  assert.match(html, /class="secondary mute-control"/);
  assert.match(html, /id="connectionNotice"/);
  assert.match(html, /id="connectionNoticeAction"/);
  assert.match(html, /id="connectionNoticeSettings"[^>]+hidden/);
  assert.match(html, /id="messageQueue"/);
  assert.match(html, /id="messageQueueSteer"/);
  assert.match(html, /id="messageQueueRemove"/);
  assert.match(styles, /\.thinking-menu[^}]+bottom:\s*calc\(100%/);
  assert.match(styles, /\.thinking-summary-chevron[^}]+var\(--ui-motion-disclosure\)/);
  assert.match(styles, /\.mcp-activity-chevron[^}]+var\(--ui-motion-disclosure\)/);
  assert.match(styles, /\.mcp-activity\[data-expanded="true"\]/);
  assert.doesNotMatch(styles, /is-typing|transcript-caret-blink/);
  assert.match(styles, /\.message-queue-steer/);
  assert.match(styles, /\.connection-notice-backdrop[^}]+place-items:\s*center/);
  assert.match(controller, /thinkingConfig:\s*buildThinkingConfig\(sessionThinkingLevel\)/);
  assert.match(controller, /tools:\s*\[\{ functionDeclarations \}\]/);
  assert.match(controller, /historyConfig:\s*\{\s*initialHistoryInClientContent:\s*true\s*\}/);
  assert.match(controller, /sendJson\(buildInitialHistoryClientContent\(conversationHistory\),\s*sourceSocket\)/);
  assert.match(controller, /elements\.messageInput\.disabled\s*=\s*false/);
  assert.match(controller, /queueUserMessage\(message\)/);
  assert.match(controller, /function steerQueuedUserMessage\(\)/);
  assert.match(controller, /getTranscriptRevealDurationMs\(remainingCharacterCount\)/);
  assert.match(controller, /function setVisibleTranscriptText\(message,\s*text\)[^]*message\.role === "lumi"[^]*renderMarkdown\(message\.content,\s*visibleText\)/);
  assert.match(controller, /setVisibleTranscriptText\(\s*message,\s*targetCharacters\.slice\(0,\s*visibleCharacterCount\)\.join\(""\)/);
  assert.match(controller, /attachAnimatedDisclosure/);
  assert.match(controller, /scrollTranscriptToLatest\(\)/);
  assert.match(controller, /revealTranscriptText\(message,\s*message\.text\)/);
  assert.match(controller, /!reconnectingExistingConversation\s*&&\s*!conversationHistory\.length/);
  assert.match(controller, /window\.addEventListener\("unload"[^]*clearConversationContext\(\)/);
  assert.match(controller, /part\.thought\s*&&\s*part\.text/);
  assert.match(controller, /updateTranscript\("thinking",\s*part\.text\)/);
  assert.match(controller, /document\.createElement\("details"\)/);
  assert.match(controller, /collapseThinkingTranscript\(\);\s*updateTranscript\("lumi"/);
  assert.match(controller, /showMissingKeyNotice\(message\)/);
  assert.match(controller, /showReconnectNotice\(message\)/);
  assert.match(controller, /EARLY_CONNECTION_DROP_MS\s*=\s*3000/);
  assert.match(controller, /performance\.now\(\) - sessionReadyAt <= EARLY_CONNECTION_DROP_MS/);
  assert.match(controller, /showReconnectNotice\(message,\s*\{ earlyDisconnect: disconnectedSoonAfterConnect \}\)/);
  assert.match(controller, /earlyDisconnect \? "Check Settings" : "Open Settings"/);
  assert.match(controller, /connectionNoticeSettings[^]*openSettings\(\)/);
  assert.match(controller, /if \(savedKey && DEFAULT_AUTO_CONNECT_ENABLED\) await autoStartSessionIfReady\(\)/);
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
  assert.match(startSessionSource, /if \(microphoneEnabled\)[^]*panelAudio\.requestMicrophone\(\)/);
  assert.match(startSessionSource, /microphoneWarning = `\$\{diagnosis\.message\} Chat is still connected\.`/);
  assert.doesNotMatch(autoStartSource, /refreshMicrophonePermission|openMicrophonePermissionPage/);
  assert.match(toggleSource, /\[MICROPHONE_ENABLED_STORAGE_KEY\]: true/);
  assert.match(toggleSource, /\[MICROPHONE_ENABLED_STORAGE_KEY\]: false/);
  assert.match(toggleSource, /panelAudio\.stopMicrophone\(\)/);
  assert.match(audioController, /async function prepareOutput\(\)/);
  assert.match(audioController, /function stopMicrophone\(\)/);
});

test("captures the active tab without a new permission and renders rich conversation Markdown", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", extensionRoot), "utf8"));
  const worker = await readFile(new URL("background/index.js", extensionRoot), "utf8");
  const sessionConfig = await readFile(new URL("live/session-config.js", extensionRoot), "utf8");
  const controller = await readFile(new URL("side-panel/index.js", extensionRoot), "utf8");
  const markdown = await readFile(new URL("side-panel/markdown-renderer.js", extensionRoot), "utf8");
  const styles = await readFile(new URL("side-panel/styles.css", extensionRoot), "utf8");

  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("tabs"));
  assert.match(sessionConfig, /name:\s*"browser_capture_screenshot"/);
  assert.match(worker, /chrome\.tabs\.captureVisibleTab/);
  assert.match(worker, /saveCapturedTabAsset/);
  assert.match(controller, /createCapturedTabMessage\(result\)/);
  assert.match(controller, /renderMarkdown\(message\.content,\s*message\.text\)/);
  assert.match(controller, /elements\.transcript\.addEventListener\("click"[\s\S]+chrome\.tabs\.create\(\{\s*url,\s*active:\s*true\s*\}\)/);
  assert.match(markdown, /function renderTable/);
  assert.match(markdown, /function reconcileChildren/);
  assert.doesNotMatch(markdown, /container\.replaceChildren\(\)/);
  assert.match(markdown, /isSafeMarkdownUrl/);
  assert.match(styles, /\.markdown-table-scroll/);
  assert.match(styles, /\.markdown-body a:hover[^}]+background/);
  assert.match(styles, /\.message-capture/);
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

test("settings ships Notion OAuth, a Redmine popup, app icons, and a temporary server toggle", async () => {
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
  assert.match(controller, /connectNotion/);
  assert.match(controller, /connector\.id === "redmine"/);
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
