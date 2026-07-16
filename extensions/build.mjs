import { build } from "esbuild";
import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extensionsRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(extensionsRoot, "..");
const webControllerRoot = path.join(extensionsRoot, "web-controller");
const sidePanelRoot = path.join(extensionsRoot, "side-panel");
const outputDirectory = path.join(webControllerRoot, "dist");
const iconDirectory = path.join(webControllerRoot, "icons");
const sidePanelOutputDirectory = path.join(sidePanelRoot, "dist");
const sidePanelIconDirectory = path.join(sidePanelRoot, "icons");
const sidePanelAvatarDirectory = path.join(sidePanelRoot, "assets", "avatars");
const sidePanelRigDirectory = path.join(sidePanelAvatarDirectory, "rig", "lumi-face-v2");

await rm(sidePanelAvatarDirectory, { recursive: true, force: true });

await Promise.all([
  mkdir(outputDirectory, { recursive: true }),
  mkdir(iconDirectory, { recursive: true }),
  mkdir(sidePanelOutputDirectory, { recursive: true }),
  mkdir(sidePanelIconDirectory, { recursive: true }),
  mkdir(sidePanelAvatarDirectory, { recursive: true }),
]);
await Promise.all([
  copyFile(
    path.join(projectRoot, "public", "branding", "logo.png"),
    path.join(iconDirectory, "logo.png"),
  ),
  copyFile(
    path.join(projectRoot, "public", "branding", "lumi-sidepanel-icon.png"),
    path.join(sidePanelIconDirectory, "lumi-sidepanel.png"),
  ),
  copyFile(
    path.join(extensionsRoot, "shared", "lumi-rig.css"),
    path.join(sidePanelRoot, "assets", "lumi-rig.css"),
  ),
  cp(
    path.join(projectRoot, "public", "avatars", "rig", "lumi-face-v2"),
    sidePanelRigDirectory,
    { recursive: true, force: true },
  ),
]);
await build({
  entryPoints: [path.join(webControllerRoot, "src", "controller.js")],
  outfile: path.join(outputDirectory, "controller.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  sourcemap: false,
  minify: false,
  legalComments: "inline",
  banner: {
    js: "/* Uses @page-agent/page-controller by Alibaba Group under the MIT License. No PageAgent LLM core is included. */",
  },
});

await copyFile(
  path.join(outputDirectory, "controller.js"),
  path.join(sidePanelOutputDirectory, "controller.js"),
);

console.log("Built Lumi web controller and standalone Side Panel extensions");
