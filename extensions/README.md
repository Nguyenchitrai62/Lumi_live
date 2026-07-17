# Lumi Chrome extensions

Lumi contains two isolated Manifest V3 extensions:

```text
extensions/
├── build.mjs          Shared build and asset-copy pipeline
├── side-panel/        Standalone Gemini Live agent
└── web-controller/    Browser bridge for the Next.js app
```

| Extension | Purpose |
| --- | --- |
| [`side-panel`](./side-panel) | Voice/chat agent with AgentPet, automatic active-tab targeting, PageAgent tools, and MCP connections |
| [`web-controller`](./web-controller) | Explicit opt-in browser control for the full-page Lumi web app |

Build both variants from the project root:

```powershell
npm run build:extension
```

Load the required variant directory in `chrome://extensions`; do not load the outer `extensions` directory.

`web-controller/src/controller.js` is the single PageAgent controller source. The build bundles it once and copies the same output into both extensions so browser actions cannot drift between variants.
