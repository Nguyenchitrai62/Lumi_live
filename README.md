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
- 30 selectable voices with audio preview.
- Automatic active-tab targeting in the Lumi Live Chrome extension.
- PageAgent DOM tools for reading, clicking, typing, selecting, and scrolling.
- User-configured Streamable HTTP MCP servers.
- Per-tool permissions: **Always allow**, **Ask every time**, or **Block**.
- Expandable activity cards for tool arguments, results, failures, and cancellations.
- Reactive Pixel Companion states for conversation, browser control, MCP calls, success, and errors.
- Three-column web studio with settings, the VTuber stage, and conversation in dedicated panels.

## Choose how to run Lumi

| Experience | Best for | Browser control |
| --- | --- | --- |
| **Lumi Live extension** | Daily voice/chat agent with both avatars, automatic tab targeting, and MCP tools | Included |
| **Next.js web app** | Full-page voice, vision, scenes, outfits, themes, and remote MCP tools | Not included; use the extension when UI control is required |

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

Set `GEMINI_API_KEY` in `.env`, then open [http://localhost:3000](http://localhost:3000). Voice, vision, chat, scenes, outfits, themes, and remote MCP tools run directly on the web. PageAgent UI control is exclusive to the Lumi Live extension.

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
