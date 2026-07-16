# Lumi Live

Lumi Live is a Next.js experiment for real-time voice roleplay with an animated anime character. It uses Gemini 3.1 Flash Live Preview, live transcripts, switchable scenes and outfits, audio-driven lip sync, and optional screen or camera vision.

## Requirements

- Node.js `>=22.13.0`
- A Gemini API key from Google AI Studio

Python is not required.

## Project structure

```text
app/                         # Next.js UI, Gemini Live token route, and web experience
extensions/
  web-controller/            # Manual target controller used with the website
  side-panel/                # Standalone Gemini Live Side Panel with automatic active-tab target
  build.mjs                  # Shared extension build and asset-copy pipeline
public/                      # Shared Lumi avatars, branding, favicon, and social image
```

Both extension variants reuse the exact controller bundle produced from `extensions/web-controller/src/controller.js`, so DOM indexing and animated PageAgent actions stay consistent.

The character uses a true facial-layer rig under `public/avatars/rig/lumi-face-v2`. Original hair pixels are split into static back/front layers, with the body and locally cleaned face between them. Three generated transparent eye sprites and three generated transparent mouth sprites are independent layers. Blink timing swaps the eye layer, while Gemini audio energy swaps the mouth layer. The front hair restores exact original bangs above the facial sprites; neither hair layer is animated, and no replacement body is generated. The web stage and standalone Side Panel share the rig through `extensions/shared/lumi-rig.css`.

## Run locally

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open `.env` and replace the placeholder with your key:

```dotenv
GEMINI_API_KEY=your_google_ai_studio_key
```

Then open [http://localhost:3000](http://localhost:3000).

The visual source defaults to `Screen`. Before starting a live chat, you can choose `Screen`, `Camera`, or `None`. The browser asks for the corresponding permission when the chat starts; Gemini receives at most one JPEG frame per second.

## Use Lumi Web with manual Chrome tab control

Lumi includes a custom Manifest V3 extension that reuses only Alibaba PageAgent's LLM-independent `@page-agent/page-controller`. It supplies DOM simplification, numbered interactive elements, click/input/select/scroll execution, highlights, the animated pointer, click ripple, and interaction mask.

1. Build the extension with `npm run build:extension`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose [`extensions/web-controller`](./extensions/web-controller).
5. Pin **Lumi PageAgent Controller**.
6. Reload the extension, then refresh Lumi.
7. Open the Chrome tab you want Lumi to control and click the **Lumi PageAgent Controller** icon once. Its badge changes to `ON`.
8. Return to Lumi, start the live chat, and share that Chrome tab if you also want Gemini to see its pixels.
9. Say, for example: “Find the search box, type blue headphones, and show me the results.”

Gemini 3.1 Flash Live is the only LLM. It plans the workflow itself by repeatedly calling `browser_get_page_state`, `browser_click`, `browser_input_text`, `browser_select_option`, and `browser_scroll`, receiving each result through the existing Live WebSocket before deciding the next action. The PageAgent LLM core and `PAGE_AGENT_EXT.execute()` are not included, and there is no second model/API call.

Screen sharing and browser control are deliberately separate. Sharing grants visual access only; it never auto-connects or injects the controller. The extension acts only after the user clicks its icon on a target tab. For a deployed Lumi app, add its exact origin to `content_scripts.matches` in `extensions/web-controller/manifest.json` and to `LUMI_LOCAL_HOSTS` in `extensions/web-controller/service-worker.js`.

Once a tab badge is `ON`, Lumi preserves and reuses that connection across voice sessions. Page navigation reinjects the controller with retries. Click the icon on the connected tab to turn it off before selecting a different target.

## Use the standalone Side Panel extension

The second extension in [`extensions/side-panel`](./extensions/side-panel) does not need the Lumi website or the Next.js server. It contains its own Gemini Live voice session, transcript, text input, PageAgent tool bridge, local API-key settings, and a small audio-reactive Lumi VTuber in the corner. It has a different generated Lumi portrait icon so it is easy to distinguish from the web controller extension.

1. Run `npm run build:extension`.
2. Open `chrome://extensions`, choose **Load unpacked**, and select [`extensions/side-panel`](./extensions/side-panel).
3. Click the new Lumi portrait icon to open the Side Panel.
4. Open settings, paste a Gemini API key from Google AI Studio, and save it locally.
5. Open or switch to a normal HTTP/HTTPS page. **PAGEAGENT TARGET** follows the active tab automatically.
6. Press **Start voice** and speak or type normally.

The standalone extension sends its locally stored key directly to Gemini Live. That is suitable for a local unpacked extension owned by the user. A publicly distributed build should replace the long-lived key with backend-issued ephemeral tokens.

For safety, Lumi asks for confirmation before submit/send/pay/delete/account-changing actions and does not fill passwords, OTPs, card data, API keys, or tokens. PageAgent is DOM-based, so canvas-only controls, cross-origin iframes, drag-and-drop, hover menus, and Chrome internal pages may not work.

## Commands

```powershell
npm run dev
npm run lint
npm run build:extension
npm run build:extensions
npm run build
npm run start
```

## Deploy to Vercel

Import the GitHub repository into Vercel with these settings:

- Framework Preset: `Next.js`
- Root Directory: `./`
- Build Command: keep the default (`npm run build`)
- Output Directory: keep the Next.js default
- Install Command: keep Vercel's automatic default

Add this Environment Variable for Production and Preview:

```text
GEMINI_API_KEY=your_google_ai_studio_key
```

Do not prefix the variable with `NEXT_PUBLIC_`. The API key stays on the server and is used to create the short-lived Gemini Live token. Never commit `.env` or a real key to Git.
