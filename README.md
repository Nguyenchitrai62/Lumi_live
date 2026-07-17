<img
  src="./public/avatars/pets/lumi/previews/showcase.webp"
  alt="Lumi AgentPet cycling through its animation states"
  width="184"
  align="right"
/>

<img src="./public/branding/lumi-sidepanel-icon.png" alt="Lumi Live" width="72" />

# Lumi Live

A real-time Gemini Live companion that can talk, understand the active page, control browser UI, and use tools from MCP servers.

Lumi ships with two reactive avatars. **AgentPet is enabled by default**; the original VTuber remains available from the pixel-face button in the Side Panel topbar.

<br clear="right" />

## Highlights

- Real-time voice and text conversation with `gemini-3.1-flash-live-preview`.
- 30 selectable voices with an audio preview before saving.
- Automatic active-tab targeting in the standalone Chrome Side Panel.
- PageAgent DOM tools for reading, clicking, typing, selecting, and scrolling.
- User-configured Streamable HTTP MCP servers.
- Per-tool permissions: **Always allow**, **Ask every time**, or **Block**.
- Expandable activity cards for tool arguments, results, failures, and cancellations.
- Reactive AgentPet states for conversation, browser control, MCP calls, success, and errors.

## Choose how to run Lumi

| Experience | Best for | Browser control |
| --- | --- | --- |
| **Side Panel extension** | Daily voice/chat agent with AgentPet, automatic tab targeting, and MCP tools | Included |
| **Next.js web app** | Full-page Lumi experience with scenes, outfits, screen sharing, and camera input | Uses the companion web-controller extension |

## AgentPet animation gallery

The corner preview cycles through every state. The full animation set is arranged below in a compact `3 × 3` grid.

<table>
  <tr>
    <td align="center" width="33%">
      <strong><code>idle</code></strong><br />
      <sub>Available before and between sessions</sub><br />
      <img src="./public/avatars/pets/lumi/previews/idle.webp" alt="Lumi AgentPet idle animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>connecting</code></strong><br />
      <sub>Connecting microphone and Gemini Live</sub><br />
      <img src="./public/avatars/pets/lumi/previews/connecting.webp" alt="Lumi AgentPet connecting animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>listening</code></strong><br />
      <sub>Listening to the user</sub><br />
      <img src="./public/avatars/pets/lumi/previews/listening.webp" alt="Lumi AgentPet listening animation" width="180" />
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <strong><code>thinking</code></strong><br />
      <sub>Preparing a response or next action</sub><br />
      <img src="./public/avatars/pets/lumi/previews/thinking.webp" alt="Lumi AgentPet thinking animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>speaking</code></strong><br />
      <sub>Playing Gemini audio</sub><br />
      <img src="./public/avatars/pets/lumi/previews/speaking.webp" alt="Lumi AgentPet speaking animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>ui_control</code></strong><br />
      <sub>Interacting with browser UI</sub><br />
      <img src="./public/avatars/pets/lumi/previews/ui_control.webp" alt="Lumi AgentPet browser UI control animation" width="180" />
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <strong><code>tool_call</code></strong><br />
      <sub>Running an MCP tool</sub><br />
      <img src="./public/avatars/pets/lumi/previews/tool_call.webp" alt="Lumi AgentPet MCP tool call animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>success</code></strong><br />
      <sub>Action completed successfully</sub><br />
      <img src="./public/avatars/pets/lumi/previews/success.webp" alt="Lumi AgentPet success animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>error</code></strong><br />
      <sub>Connection, browser, or tool failure</sub><br />
      <img src="./public/avatars/pets/lumi/previews/error.webp" alt="Lumi AgentPet error animation" width="180" />
    </td>
  </tr>
</table>

The animation source of truth is [`public/avatars/pets/lumi/pet.json`](./public/avatars/pets/lumi/pet.json) plus its adjacent spritesheet. Every state uses eight `256 × 256` cells with a shared baseline and transition pose. The extension build copies these assets into its unpacked package.

## Quick start: Side Panel extension

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
2. Select **Load unpacked** and choose [`extensions/side-panel`](./extensions/side-panel).
3. Open Lumi Settings, save the Gemini API key, choose a voice, and allow microphone access.
4. Open a normal HTTP/HTTPS page and press **Start voice**.

AgentPet starts in `idle` immediately; voice does not need to be started for the character to animate. Use the pixel-face button in the topbar to switch to the VTuber at any time.

After changing extension source or AgentPet assets, run `npm run build:extension` and press **Reload** on `chrome://extensions`.

## Connect MCP tools

Open **Settings → Connected tools → Add server** and enter a Streamable HTTP MCP endpoint.

- Lumi validates `initialize` and `tools/list` before saving a server.
- Remote HTTP URLs are upgraded to HTTPS; localhost may use HTTP for development.
- Each server exposes its own tool-permission screen.
- A failed or incompatible tool is isolated so voice, chat, and other tools can keep working.

## Run the web app

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Set `GEMINI_API_KEY` in `.env`, then open [http://localhost:3000](http://localhost:3000).

To control a page from the web app, build and load [`extensions/web-controller`](./extensions/web-controller), then click its toolbar icon on the target tab until the badge shows `ON`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run lint` | Lint the web app |
| `npm run build:extension` | Build both Chrome extensions |
| `npm run build` | Build the extensions and Next.js app |
| `npm run start` | Start the production server |

## Repository map

```text
app/                         Next.js Lumi experience and token endpoint
extensions/side-panel/       Standalone voice agent extension
extensions/web-controller/   Browser bridge used by the web app
extensions/shared/           Shared generated-avatar styles
public/avatars/              VTuber rig and AgentPet source assets
```

## Safety notes

- The unpacked Side Panel stores its Gemini key in `chrome.storage.local`. A published extension should use backend-issued ephemeral tokens.
- Lumi asks for confirmation before consequential actions.
- Passwords, one-time codes, payment-card data, API keys, tokens, and other secrets are blocked from browser automation.
- Chrome internal pages, canvas-only controls, cross-origin iframes, drag-and-drop, and hover-only interfaces may not be controllable.

## Acknowledgements

- Browser interaction uses the LLM-independent [`@page-agent/page-controller`](https://github.com/alibaba/page-agent) package by Alibaba Page Agent under the MIT License.

Gemini Live remains Lumi's planning and conversation model. This project is not affiliated with or endorsed by Alibaba.
