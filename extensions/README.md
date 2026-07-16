# Lumi Chrome extensions

All Chrome-specific code lives in this directory. The two installable Manifest V3 variants are intentionally isolated so they can evolve without mixing permissions, runtime state, or user interfaces.

## Layout

```text
extensions/
├── build.mjs          # Builds the shared PageAgent controller and copies generated assets
├── web-controller/    # Companion extension for the Lumi Next.js website
└── side-panel/        # Standalone Gemini Live + Lumi VTuber Side Panel extension
```

`web-controller/src/controller.js` is the single source for the LLM-independent Alibaba PageAgent DOM controller. `build.mjs` bundles it once and copies the exact same output into both variants, preventing their click/input/scroll behavior from drifting apart.

## Build

From the project root, run either:

```powershell
npm run build:extensions
npm run build:extension
```

The singular command is kept as a compatibility alias. Load only one of the two variant directories in `chrome://extensions`; never load the outer `extensions` directory itself.
