import { build } from "esbuild";
import { cp, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extensionsRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(extensionsRoot, "..");
const extensionRoot = path.join(extensionsRoot, "lumi-live");
const outputDirectory = path.join(extensionRoot, "dist");
const iconDirectory = path.join(extensionRoot, "icons");
const avatarDirectory = path.join(extensionRoot, "assets", "avatars");
const vtuberDirectory = path.join(avatarDirectory, "vtuber");
const pixelAvatarDirectory = path.join(avatarDirectory, "pixel");

const pageControllerSameOriginIframePlugin = {
  name: "page-controller-same-origin-iframes",
  setup(buildContext) {
    buildContext.onLoad({ filter: /page-controller\.js$/ }, async (args) => {
      const dependencyPath = `${path.sep}@page-agent${path.sep}page-controller${path.sep}`;
      if (!args.path.includes(dependencyPath)) return null;

      const source = await readFile(args.path, "utf8");
      const crossOriginAccess = "const iframeDoc = node.contentDocument || node.contentWindow?.document;";
      if (!source.includes(crossOriginAccess)) {
        throw new Error("The PageController iframe compatibility patch no longer matches its source.");
      }

      return {
        contents: source.replace(crossOriginAccess, "const iframeDoc = node.contentDocument;"),
        loader: "js",
      };
    });
  },
};

await rm(avatarDirectory, { recursive: true, force: true });

await Promise.all([
  mkdir(outputDirectory, { recursive: true }),
  mkdir(iconDirectory, { recursive: true }),
  mkdir(avatarDirectory, { recursive: true }),
  mkdir(pixelAvatarDirectory, { recursive: true }),
]);
await Promise.all([
  copyFile(
    path.join(projectRoot, "public", "branding", "lumi-live-icon.png"),
    path.join(iconDirectory, "lumi-live.png"),
  ),
  copyFile(
    path.join(extensionsRoot, "shared", "lumi-rig.css"),
    path.join(extensionRoot, "assets", "lumi-rig.css"),
  ),
  cp(
    path.join(projectRoot, "public", "avatars", "vtuber"),
    vtuberDirectory,
    {
      recursive: true,
      force: true,
      filter: (source) => path.basename(source) !== "references",
    },
  ),
  copyFile(
    path.join(projectRoot, "public", "avatars", "pixel", "avatar.json"),
    path.join(pixelAvatarDirectory, "avatar.json"),
  ),
  copyFile(
    path.join(projectRoot, "public", "avatars", "pixel", "spritesheet.png"),
    path.join(pixelAvatarDirectory, "spritesheet.png"),
  ),
]);
await build({
  entryPoints: [path.join(extensionRoot, "browser", "controller.js")],
  outfile: path.join(outputDirectory, "controller.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  plugins: [pageControllerSameOriginIframePlugin],
  sourcemap: false,
  minify: false,
  legalComments: "inline",
  banner: {
    js: "/* Uses @page-agent/page-controller by Alibaba Group under the MIT License. No PageAgent LLM core is included. */",
  },
});

console.log("Built the Lumi Live extension");
