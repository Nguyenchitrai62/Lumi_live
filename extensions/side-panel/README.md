# Lumi Live Side Panel

This is the standalone Lumi extension. It does not load or iframe the Lumi website and does not require the Next.js server.

## Install locally

1. Run `npm run build:extension` from the project root.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select `extensions/side-panel`.
4. Pin the generated Lumi portrait icon and click it to open the Side Panel.
5. Click the gear button. A dedicated Settings tab opens; paste a Gemini API key, choose a Gemini voice, and save it locally.
6. Open or switch to any normal http/https page. **PAGEAGENT TARGET** follows the active Chrome tab automatically; no Connect step is required.
7. Press **Start voice**. The first time, Lumi opens a separate permission tab so Chrome can show its native microphone **Allow / Block** prompt.
8. Choose **Allow**, return to the Side Panel, and press **Start voice** again.

If microphone access was denied earlier, open Lumi settings and press **Fix access**. The permission tab contains a button that opens Chrome's site settings for this exact extension ID, so you do not need to search through Chrome settings manually.

The settings panel also contains **Page element guides**. It is off by default, hiding PageAgent's colored element boxes and index numbers while preserving the animated pointer, click ripple, interaction mask, typing, selection, and scrolling feedback. Turn it on only when you want to inspect PageAgent's DOM indexing visually.

Lumi uses a true facial-layer rig: original hair pixels are split into static back/front layers, the body and locally cleaned face sit between them, and three independent eye plus three independent mouth sprites sit below the front bangs. Randomized blinking swaps only the eyes; Gemini audio energy swaps only the mouth. The hair layers are not animated, and no replacement body is generated.

The Side Panel uses Gemini 3.1 Flash Live Preview as the only LLM. Gemini calls the low-level PageAgent DOM tools directly; Alibaba PageAgent's LLM core is not included. The PageAgent target automatically changes whenever the user activates another normal web tab. Gemini can also list controllable tabs, open an HTTP/HTTPS tab, or switch to a tab selected from the latest short-lived tab list before continuing DOM work.

Voice selection is saved in `chrome.storage.local` and sent as `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` when the next Gemini Live session starts. End the current voice session before changing voices.

The API key is stored in `chrome.storage.local` and sent directly to Google Gemini. For a published extension, replace this local-key flow with a backend that issues short-lived ephemeral Live API tokens.

The generated Lumi portrait icon is intentionally different from the original logo used by `web-controller`, so both unpacked extensions can be installed and recognized side by side.
