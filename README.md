<p align="center">
  <img src="./public/branding/lumi-sidepanel-icon.png" alt="Lumi Live" width="96" height="96" />
</p>

<h1 align="center">Lumi Live</h1>

<p align="center">A Gemini Live voice companion with browser control, an animated Lumi character, and user-configured MCP tools.</p>

## Features

- Real-time voice and text chat with `gemini-3.1-flash-live-preview`.
- Thirty selectable voices with audio preview.
- Audio-reactive mouth animation and randomized blinking.
- PageAgent DOM tools for reading, clicking, typing, selecting, and scrolling.
- Automatic active-tab targeting in the standalone Side Panel.
- Multiple manually configured MCP servers.
- Expandable MCP activity cards showing tool arguments, results, failures, and cancellations.

## Project modes

| Mode | Description |
| --- | --- |
| **Side Panel extension** | Standalone Chrome voice agent with automatic browser targeting and multi-MCP tools. |
| **Next.js web app** | Visual Lumi experience with scenes, outfits, screen/camera input, and manual tab control through a second extension. |

## Install the Side Panel extension

Requirements: Chrome `120+`, Node.js `22.13+`, and a [Gemini API key](https://aistudio.google.com/app/apikey).

```powershell
npm install
npm run build:extension
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose [`extensions/side-panel`](./extensions/side-panel).
3. Open Lumi Settings, save the Gemini API key, choose a voice, and allow microphone access.
4. Open a normal HTTP/HTTPS page and press **Start voice**.

After changing the source, rebuild and press **Reload** on `chrome://extensions`.

## Add MCP servers

Open **Settings → Connected tools → Add server**, enter a Streamable HTTP MCP endpoint, and connect it. Repeat to add more servers.

- No MCP URL is hard-coded.
- Remote HTTP URLs are upgraded to HTTPS; localhost may use HTTP.
- Lumi validates `initialize` and `tools/list` before saving a server.
- Tools are loaded from every available server when the next voice session starts.
- If one server fails, other MCP servers can still be used.

## Run the web app

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Set `GEMINI_API_KEY` in `.env`, then open [http://localhost:3000](http://localhost:3000).

For browser control, build and load [`extensions/web-controller`](./extensions/web-controller), then click its icon on the target tab until the badge shows `ON`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run lint` | Lint the web app |
| `npm run build:extension` | Build both Chrome extensions |
| `npm run build` | Build the extensions and Next.js app |
| `npm run start` | Start the production server |

## Notes

- The Side Panel stores its Gemini key in `chrome.storage.local`; a published extension should use backend-issued ephemeral tokens.
- Lumi asks for confirmation before consequential actions and does not fill passwords, OTPs, card data, API keys, or tokens.
- Chrome internal pages, canvas-only controls, cross-origin iframes, drag-and-drop, and hover-only UI may not be controllable.

## Acknowledgements

Lumi Live's browser-control integration was inspired by [Alibaba Page Agent](https://github.com/alibaba/page-agent) and uses its LLM-independent `@page-agent/page-controller` package for text-based DOM processing and direct page interactions.

Many thanks to Alibaba and the Page Agent contributors for open-sourcing their work under the MIT License. Lumi uses Gemini Live as its own planning model and is not affiliated with or endorsed by Alibaba.
