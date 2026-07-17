# Lumi Live Side Panel

The standalone Chrome extension runs Gemini Live, Lumi AgentPet, PageAgent browser controls, and user-configured MCP tools without requiring the Next.js app.

## Install

```powershell
npm run build:extension
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose `extensions/side-panel`.
3. Open Settings from the gear button.
4. Save a Gemini API key, choose a voice, and allow microphone access.
5. Open a normal HTTP/HTTPS tab and press **Start voice**.

After rebuilding, press **Reload** on `chrome://extensions` and reopen old Settings or Side Panel pages.

## AgentPet

AgentPet is enabled by default and starts animating in `idle` before voice starts. The pixel-face button in the topbar switches between AgentPet and the fallback VTuber.

The metadata-driven atlas contains nine states:

| State | Trigger |
| --- | --- |
| `idle` | Available before or between sessions |
| `connecting` | Preparing microphone or Gemini Live |
| `listening` | Waiting for user speech |
| `thinking` | Preparing a response or next action |
| `speaking` | Playing Gemini audio |
| `ui_control` | Interacting with browser UI |
| `tool_call` | Running an MCP tool |
| `success` | An action completed |
| `error` | A connection, browser action, or tool failed |

The build copies the source atlas from `public/avatars/pets/lumi`. If it cannot load, Lumi automatically uses the VTuber.

## Browser and MCP tools

- **PAGEAGENT TARGET** follows the active normal web tab automatically.
- Page element guides are optional and disabled by default.
- MCP servers are added from **Settings → Connected tools**.
- Every MCP tool can be set to **Always allow**, **Ask every time**, or **Block**.
- Invalid or rejected tools are isolated so voice, chat, and other tools remain available.
- Tool activity cards expose arguments, status, duration, result, failure, or cancellation.

## Local data and permissions

The Gemini key, selected voice, avatar preference, MCP servers, and tool policies are stored in `chrome.storage.local`.

The first voice session opens a dedicated microphone permission page. If access was previously denied, use **Fix access** in Settings.

For a published extension, replace the local API-key flow with backend-issued ephemeral tokens.
