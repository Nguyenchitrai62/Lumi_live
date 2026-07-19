# Lumi Live Chrome extension

Lumi contains one standalone Manifest V3 extension:

```text
extensions/
├── build.mjs          Build and asset-copy pipeline
└── lumi-live/         Standalone Gemini Live agent
```

[`lumi-live`](./lumi-live) includes voice and chat, live video translation, Pixel Companion and VTuber avatars, automatic active-tab targeting, PageAgent tools, and MCP connections.

Build it from the project root:

```powershell
npm run build:extension
```

Load `extensions/lumi-live` in `chrome://extensions`; do not load the outer `extensions` directory.

`lumi-live/browser/controller.js` is bundled into `lumi-live/dist/controller.js`. Runtime code, pages, and tests are grouped by domain under `background`, `browser`, `core`, `live`, `mcp`, `offscreen`, `settings`, `side-panel`, and `tests`.
