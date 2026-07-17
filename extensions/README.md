# Lumi Live Chrome extension

Lumi contains one standalone Manifest V3 extension:

```text
extensions/
├── build.mjs          Build and asset-copy pipeline
└── lumi-live/         Standalone Gemini Live agent
```

[`lumi-live`](./lumi-live) includes voice and chat, Pixel Companion and VTuber avatars, automatic active-tab targeting, PageAgent tools, and MCP connections.

Build it from the project root:

```powershell
npm run build:extension
```

Load `extensions/lumi-live` in `chrome://extensions`; do not load the outer `extensions` directory.

`lumi-live/page-controller.js` is the PageAgent controller source bundled into `lumi-live/dist/controller.js`. Pixel-avatar state and rendering live in `lumi-live/pixel-avatar-controller.js`, keeping the main runtime focused on Gemini, audio, browser, and MCP orchestration.
