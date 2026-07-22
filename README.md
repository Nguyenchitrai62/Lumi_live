<img
  src="./public/avatars/pixel/previews/showcase.webp"
  alt="Lumi Pixel Companion cycling through its animation states"
  width="184"
  align="right"
/>

<img src="./public/branding/lumi-live-icon.png" alt="Lumi Live" width="72" />

# Lumi Live

Lumi Live is a real-time AI companion that supports voice and text conversations,
understands page context, assists with browser interactions, connects to external
tools, and responds through an animated avatar.

Lumi includes two avatar models:

- **Pixel Companion** — a pixel-art companion with reactive states.
- **VTuber** — a layered avatar with expressive animation and appearance options.

<br clear="right" />

## Highlights

- Real-time voice and text conversations powered by Gemini Live.
- Page-aware interaction using the current web page or active browser tab as context.
- Browser assistance for common actions such as reading, clicking, typing, selecting, and scrolling.
- Support for Streamable HTTP MCP servers and selected service integrations.
- Per-tool permissions for allowing, confirming, or blocking connected actions.
- Visual activity feedback for conversations, browser actions, tool calls, results, and errors.
- Voice, avatar, theme, scene, and outfit customization.
- Optional live translation for supported audio and video workflows.

## Choose how to run Lumi

The repository includes a Chrome extension at [`extensions/lumi-live`](./extensions/lumi-live).

| Experience | Best for | Browser context |
| --- | --- | --- |
| **Lumi Live extension** | Using Lumi alongside everyday browsing | The active Chrome tab |
| **Next.js web app** | A full-page studio for voice, vision, avatars, and connected tools | The current Lumi Studio page |

## Avatar assets

Avatar source files and previews are kept under [`public/avatars`](./public/avatars).
The Pixel Companion preview states are shown below:

<table>
  <tr>
    <td align="center" width="33%">
      <strong><code>idle</code></strong><br />
      <img src="./public/avatars/pixel/previews/idle.webp" alt="Pixel Companion idle animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>connecting</code></strong><br />
      <img src="./public/avatars/pixel/previews/connecting.webp" alt="Pixel Companion connecting animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>listening</code></strong><br />
      <img src="./public/avatars/pixel/previews/listening.webp" alt="Pixel Companion listening animation" width="180" />
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <strong><code>thinking</code></strong><br />
      <img src="./public/avatars/pixel/previews/thinking.webp" alt="Pixel Companion thinking animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>speaking</code></strong><br />
      <img src="./public/avatars/pixel/previews/speaking.webp" alt="Pixel Companion speaking animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>ui_control</code></strong><br />
      <img src="./public/avatars/pixel/previews/ui_control.webp" alt="Pixel Companion browser interaction animation" width="180" />
    </td>
  </tr>
  <tr>
    <td align="center" width="33%">
      <strong><code>tool_call</code></strong><br />
      <img src="./public/avatars/pixel/previews/tool_call.webp" alt="Pixel Companion tool call animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>success</code></strong><br />
      <img src="./public/avatars/pixel/previews/success.webp" alt="Pixel Companion success animation" width="180" />
    </td>
    <td align="center" width="33%">
      <strong><code>error</code></strong><br />
      <img src="./public/avatars/pixel/previews/error.webp" alt="Pixel Companion error animation" width="180" />
    </td>
  </tr>
</table>

## Quick start: Lumi Live extension

Requirements:

- A recent version of Chrome
- Node.js supported by the [`package.json`](./package.json) engine setting
- A [Gemini API key](https://aistudio.google.com/apikey)

Install dependencies and build the extension:

```powershell
npm install
npm run build:extension
```

Then:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose [`extensions/lumi-live`](./extensions/lumi-live).
3. Open Lumi Settings, configure the Gemini API key and preferences, and grant microphone access when prompted.
4. Open a normal HTTP/HTTPS page and launch the Lumi side panel.

After changing extension source or avatar assets, rebuild with
`npm run build:extension` and reload the extension from `chrome://extensions`.

## Connect MCP tools

Open **Settings → Connected tools → Add server** to connect a Streamable HTTP MCP
endpoint. Lumi shows the tools provided by each server and lets you manage
permissions individually.

The extension may also provide quick-connect integrations for selected services.
Available integrations and their setup flow depend on the current build.

## Run the web app

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Set `GEMINI_API_KEY` in `.env`, then open
[http://localhost:3000](http://localhost:3000). The web studio provides voice,
vision, chat, avatar customization, page interaction, and connected tools.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run lint` | Lint the web app and extension source |
| `npm run typecheck` | Type-check the project without emitting files |
| `npm test` | Run extension regression tests |
| `npm run build:extension` | Build the Lumi Live Chrome extension |
| `npm run build` | Build the extension and Next.js app |
| `npm run start` | Start the production server |

## Safety notes

- Treat API keys, connector credentials, tokens, and other secrets as sensitive data.
- Lumi is designed to request confirmation before consequential actions.
- Browser interaction may not work on every page or control.
