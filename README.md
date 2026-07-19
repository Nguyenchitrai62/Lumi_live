<img
  src="./public/avatars/pixel/previews/showcase.webp"
  alt="Lumi Pixel Companion cycling through its animation states"
  width="184"
  align="right"
/>

<img src="./public/branding/lumi-live-icon.png" alt="Lumi Live" width="72" />

# Lumi Live

A real-time Gemini Live companion that can talk, understand the active page, control browser UI, and use tools from MCP servers.

Lumi has two reactive avatar types:

- **Pixel Companion** — the detailed pixel model, enabled by default.
- **VTuber** — the layered anime model with blinking, lip sync, scenes, and outfits.

<br clear="right" />

## Highlights

- Real-time voice and text conversation with `gemini-3.1-flash-live-preview`.
- Agent-triggered speech-to-speech translation into Google's documented 70+ languages with `gemini-3.5-live-translate-preview`; the translation tool owns audio playback, preserves the video's speaking voices, ducks the source audio to 6%, and uses a small jitter buffer without changing video or translated-audio playback speed.
- 30 selectable voices with audio preview.
- Automatic active-tab targeting in the Lumi Live Chrome extension.
- PageAgent DOM tools for reading, clicking, typing, selecting, and scrolling, including content-text targets and exact normalized positions from `0` (top) to `1` (bottom): self-scoped in the web Studio and active-tab aware in the extension.
- User-configured Streamable HTTP MCP servers.
- Per-tool permissions: **Always allow**, **Ask every time**, or **Block**.
- Expandable activity cards for tool arguments, results, failures, and cancellations.
- Reactive Pixel Companion states for conversation, browser control, MCP calls, success, and errors.
- Three-column web studio with settings, the VTuber stage, and conversation in dedicated panels.

## Choose how to run Lumi

The repository ships one Chrome extension at [`extensions/lumi-live`](./extensions/lumi-live), which includes both the side panel and active-tab controller.

| Experience | Best for | Browser control |
| --- | --- | --- |
| **Lumi Live extension** | Daily voice/chat agent with both avatars, automatic tab targeting, and MCP tools | Controls the active Chrome tab |
| **Next.js web app** | Full-page voice, vision, scenes, outfits, themes, and remote MCP tools | Controls the current Lumi Studio document; install the extension for active-tab control |

## Avatar assets

```text
public/avatars/
├── pixel/                   Pixel Companion atlas, metadata, and previews
└── vtuber/                  Layered VTuber images, source references, and docs
```

The Pixel Companion metadata is [`public/avatars/pixel/avatar.json`](./public/avatars/pixel/avatar.json). Its adjacent spritesheet contains nine animation rows:

<table>
  <tr>
    <td align="center" width="33%">
      <strong><code>idle</code></strong><br />
      <sub>Available before and between sessions</sub><br />
      <img src="./public/avatars/pixel/previews/idle.webp" alt="Lumi Pixel Companion idle animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>connecting</code></strong><br />
      <sub>Preparing microphone and Gemini Live</sub><br />
      <img src="./public/avatars/pixel/previews/connecting.webp" alt="Lumi Pixel Companion connecting animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>listening</code></strong><br />
      <sub>Waiting for user speech</sub><br />
      <img src="./public/avatars/pixel/previews/listening.webp" alt="Lumi Pixel Companion listening animation" width="180" />
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <strong><code>thinking</code></strong><br />
      <sub>Preparing a response or next action</sub><br />
      <img src="./public/avatars/pixel/previews/thinking.webp" alt="Lumi Pixel Companion thinking animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>speaking</code></strong><br />
      <sub>Playing Gemini audio</sub><br />
      <img src="./public/avatars/pixel/previews/speaking.webp" alt="Lumi Pixel Companion speaking animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>ui_control</code></strong><br />
      <sub>Interacting with browser UI</sub><br />
      <img src="./public/avatars/pixel/previews/ui_control.webp" alt="Lumi Pixel Companion browser UI control animation" width="180" />
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <strong><code>tool_call</code></strong><br />
      <sub>Running an MCP tool</sub><br />
      <img src="./public/avatars/pixel/previews/tool_call.webp" alt="Lumi Pixel Companion MCP tool call animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>success</code></strong><br />
      <sub>An action completed</sub><br />
      <img src="./public/avatars/pixel/previews/success.webp" alt="Lumi Pixel Companion success animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>error</code></strong><br />
      <sub>A connection, browser action, or tool failed</sub><br />
      <img src="./public/avatars/pixel/previews/error.webp" alt="Lumi Pixel Companion error animation" width="180" />
    </td>
  </tr>
</table>

Every state uses eight `256 × 256` cells with a shared baseline and transition pose. The extension build copies runtime avatar assets into its unpacked package.

## Quick start: Lumi Live extension

Requirements:

- Chrome `120+`
- Node.js `22.13+`
- A [Gemini API key](https://aistudio.google.com/apikey)

```powershell
npm install
npm run build:extension
```

Then:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose [`extensions/lumi-live`](./extensions/lumi-live).
3. Open Lumi Settings, save the Gemini API key, choose a voice, and allow microphone access.
4. Open a normal HTTP/HTTPS page and press **Start voice**.

The Pixel Companion starts in `idle` immediately. Use the avatar button in the toolbar to switch to the VTuber.

To translate a playing video, activate its tab, click the Lumi toolbar icon, and name any supported target language, for example **“Translate this video to Japanese.”** The action click immediately authorizes that exact tab and an offscreen runtime holds the stream, so the later `live_translate` tool call does not open a Share Screen dialog. It lowers the original audio to 6% and plays the translated voice. Say **“Stop live translation”** to keep the authorized stream but restore full source volume, or press **End voice** to release capture and stop the agent session. After switching tabs, click the Lumi icon once on the new tab because Chrome does not grant permanent audio access to arbitrary tabs.

After changing extension source or avatar assets, run `npm run build:extension` and press **Reload** on `chrome://extensions`.

## Connect MCP tools

Open **Settings → Connected tools → Add server** and enter a Streamable HTTP MCP endpoint.

- Lumi validates `initialize` and `tools/list` before saving a server.
- Each server exposes its own tool-permission screen.
- A failed or incompatible tool is isolated so voice, chat, and other tools keep working.
- The extension upgrades remote HTTP URLs to HTTPS and allows localhost HTTP for development.
- The hosted web app accepts public HTTPS endpoints only. Its same-origin proxy blocks local/private networks, redirects, oversized responses, credentials in URLs, and unsupported JSON-RPC methods.

## Run the web app

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Set `GEMINI_API_KEY` in `.env`, then open [http://localhost:3000](http://localhost:3000). Voice, vision, chat, scenes, outfits, themes, remote MCP tools, and PageAgent control of the Lumi Studio interface run directly on the web. The hosted Studio needs no personal Gemini key from its visitors. Installing the Lumi Live extension and providing a personal key upgrades PageAgent from the current Studio document to the user's active Chrome tab.

For live video translation on the web, choose **Screen**, press **Start voice**, select the Chrome tab playing the video, and keep **Share tab audio** enabled. Then ask Lumi to translate it to any supported target language. While translation is active, Lumi suppresses direct playback from the shared tab and locally replays it at 6%, restoring normal playback when translation stops. The web server issues a separate constrained, single-use ephemeral token for the translation session; the server API key is never sent to the browser.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run lint` | Lint the web app |
| `npm run typecheck` | Type-check the web app without emitting files |
| `npm test` | Run the extension regression tests |
| `npm run build:extension` | Build the Lumi Live Chrome extension |
| `npm run build` | Build the extension and Next.js app |
| `npm run start` | Start the production server |

## Repository map

```text
app/                         Next.js Lumi experience, token endpoint, and MCP proxy
app/components/              Studio header, settings, stage, conversation, and avatar UI
app/hooks/                   Focused preferences, device, voice-preview, and lip-sync state
app/lib/live/                Web Live audio, media, auth, and session configuration
app/lib/mcp/                 Web MCP transport, schema, state manager, and value helpers
extensions/lumi-live/        Standalone voice agent extension
extensions/shared/           Shared generated-avatar styles
public/avatars/pixel/        Pixel Companion source assets
public/avatars/vtuber/       VTuber source assets
```

The top-level web and extension entry points coordinate feature modules rather than
reimplementing transport, media codecs, voice preview, MCP schema conversion, or
visual-effect lifecycles. Keep new behavior in the closest feature module and
preserve the existing facade imports when extending MCP support.

## Safety notes

- The unpacked extension stores its Gemini key in `chrome.storage.local`. A published extension should use backend-issued ephemeral tokens.
- Lumi asks for confirmation before consequential actions.
- Passwords, one-time codes, payment-card data, API keys, tokens, and other secrets are blocked from browser automation.
- Chrome internal pages, canvas-only controls, cross-origin iframes, drag-and-drop, and hover-only interfaces may not be controllable.

## Acknowledgements

Browser interaction uses the LLM-independent [`@page-agent/page-controller`](https://github.com/alibaba/page-agent) package by Alibaba Page Agent under the MIT License.

Gemini Live remains Lumi's planning and conversation model. This project is not affiliated with or endorsed by Alibaba.
