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
  assert.match(styles, /\.settings-column[^}]+grid-template-columns:\s*1fr/);
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
