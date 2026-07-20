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

test("settings ships Notion OAuth, a Redmine popup, app icons, and a temporary server toggle", async () => {
  const html = await readFile(new URL("settings/index.html", extensionRoot), "utf8");
  const controller = await readFile(
    new URL("settings/mcp-settings-controller.js", extensionRoot),
    "utf8",
  );
  const styles = await readFile(new URL("settings/styles.css", extensionRoot), "utf8");
  assert.match(html, /id="mcpConnectorModal"/);
  assert.match(html, /id="mcpConnectorModalFields"/);
  assert.match(html, /id="mcpConnectorCatalog"/);
  assert.match(html, /icons\/connectors\/mcp\.svg/);
  assert.match(controller, /mcp_set_server_enabled/);
  assert.match(controller, /connectNotion/);
  assert.match(controller, /connector\.id === "redmine"/);
  assert.match(controller, /availableConnectors[\s\S]*!mcpServers\.some/);
  assert.match(controller, /connector\?\.icon \|\| DEFAULT_MCP_ICON/);
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
