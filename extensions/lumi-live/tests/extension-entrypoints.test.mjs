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
