# Lumi Live

The standalone Chrome extension runs Gemini Live, the Lumi Pixel Companion, the Lumi VTuber, PageAgent browser controls, and user-configured MCP tools without requiring the Next.js app.

It also exposes a built-in `live_translate` agent tool backed by `gemini-3.5-live-translate-preview`. The tool reuses the saved Gemini API key, captures the active media element's audio, and plays the translated speech itself so the conversational agent does not repeat the dialogue.

## Install

```powershell
npm run build:extension
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose `extensions/lumi-live`.
3. Open Settings from the gear button.
4. Save a Gemini API key, choose a voice, and allow microphone access.
5. Choose a **Thinking** level in the composer if needed and open a normal HTTP/HTTPS tab. The side panel connects voice automatically after the API key and microphone permission are ready. The default is **Minimal** for the lowest latency. You can change Thinking at any time; Lumi reconnects with the new level while retaining the current conversation.

The **Thinking** panel starts expanded, keeps the transcript scrolled to the newest thought, and streams Gemini's thought summary as it arrives. Thinking and MCP details open and collapse over 0.5 seconds. Thinking collapses automatically when answer content begins, remains in the transcript, and can be expanded again. If Gemini delivers transcript text as one large block, Lumi progressively reveals it at 400 characters per second without a typing cursor. This is Gemini's summary of its reasoning, not its private raw chain of thought. Default settings and visible UI timings—including Thinking, click, form input, scrolling, and every phase of the Google departure effect—are plain variables in `core/ui-config.js`.

If the Gemini key is missing or invalid, a centered warning opens Lumi Settings from its action button. If the Live WebSocket ends unexpectedly, the same warning surface offers **Reconnect**.

The chat box remains editable while Lumi is responding or reconnecting. Sending during an active response adds the message to a visible queue and sends it automatically when the current turn finishes. Choose **Steer** on the queue row to interrupt the current turn and send that message immediately, or use the trash icon to remove it. Voice transcripts and typed turns are kept only in the side panel's memory and are supplied as initial history after a WebSocket reconnect, so Lumi stays silent instead of greeting again. Closing the side panel clears that conversation context.

## Live video translation

1. Keep the video tab active and start a Lumi voice session.
2. Name any supported target language, for example **“Translate this video to Japanese”**, **“…to Polish”**, or **“…to Vietnamese.”**
3. Lumi maps the requested language to its BCP-47 code and calls `live_translate`. The target is never fixed to the UI language. Lumi routes the active media element audio into the translation pipeline, lowers the original audio to 6%, and shows the Translate badge.
4. Say **“Stop live translation”** to release the capture and restore the tab's original audio, or press **End voice** to stop translation and the whole live-agent session.

Lumi first tries to capture the actively playing HTML video or audio element directly. This automatic path works after switching tabs even when the toolbar click that opened the side panel happened on another tab. It lowers that element to 6%, streams 100 ms PCM frames to the offscreen translator, and restores the previous volume on stop, tab switch, navigation, panel close, or failure. No Share Screen picker is used.

The Lumi toolbar icon only toggles the side panel. Live Translate first captures audio automatically from the active HTML video or audio element without a separate toolbar permission step. If direct capture is unavailable, Lumi shows a **Share tab audio** notice; the user can choose **Chrome Tab** and enable audio in Chrome's picker to continue through the same pending translation tool call. Live Translate supports Google's documented 70+ target languages, accepts speech audio only, and is not used for ordinary text or page translation.

Live translation uses 100 ms PCM input chunks and a bounded realtime input queue. Translated audio is always played at its original speed; Lumi never pauses, seeks, or changes the playback rate of the video.

After rebuilding, press **Reload** on `chrome://extensions` and reopen any old Lumi Live or Settings pages.

## Source layout

The extension root contains only `manifest.json`, documentation, generated/runtime assets, and domain directories. Chrome and the build pipeline reference the domain entrypoints directly, so there are no duplicate compatibility wrappers to keep in sync.

Implementations are grouped by responsibility:

| Directory | Responsibility |
| --- | --- |
| `background/` | Manifest V3 worker orchestration and MCP service lifecycle |
| `browser/` | PageAgent controller, direct media capture, and visual browser effects |
| `core/` | Shared extension events, storage keys, policies, and active-tab context |
| `live/` | Gemini Live session, translation, and PCM audio utilities |
| `mcp/` | MCP HTTP client and Gemini schema conversion |
| `offscreen/` | Authorized tab-audio translation document |
| `settings/` | Settings page and MCP permission UI |
| `side-panel/` | Main Lumi panel, avatars, petals, and MCP activity UI |
| `tests/` | Unit, integration, manifest, asset, and import-graph checks |

`manifest.json` loads `background/index.js`, `side-panel/index.html`, and `settings/index.html` directly. `extensions/build.mjs` bundles `browser/controller.js` into `dist/controller.js`. `npm test` validates these paths and recursively resolves every local JavaScript import reachable at runtime.

## Avatars

The Pixel Companion is enabled by default and starts animating in `idle` before voice starts. The avatar button in the topbar switches between the Pixel Companion and the VTuber.

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

The build copies the source atlas from `public/avatars/pixel` and the layered VTuber from `public/avatars/vtuber`. If the Pixel Companion cannot load, Lumi automatically uses the VTuber.

## Browser and MCP tools

- **PAGEAGENT TARGET** follows the active normal web tab automatically.
- Page element guides are optional and disabled by default.
- Switching to a tab that already exists happens immediately without an overlay transition. For a destination that is not already available, Lumi completes the Google Search sequence on the current page before Chrome creates and activates the new tab. If the current page is Chrome New Tab, a `chrome://` page, a local file, or another restricted page, Lumi opens exactly `https://www.google.com/` in a new active tab, runs the transition there, and reuses that same tab for the requested destination so no extra Google tab remains. Every page-scroll call is animated over 1 second with an on-screen direction/progress HUD. A `text` target reveals matching rendered content, while `position=0` is the exact top, `position=0.5` the middle, and `position=1` the exact bottom. Form text is always revealed over 0.5 seconds.
- While Lumi is generating or running a browser/MCP tool, the send button becomes a circular stop control. Cancelling interrupts the Gemini turn, stops playback and visual actions, and aborts active MCP requests without ending the voice session.
- If a PageAgent click opens a YouTube video link or starts a paused YouTube video, Lumi locally suppresses only its remaining response audio for that turn. Output transcription still appears, and the next turn speaks normally even while the video remains open.
- Video fullscreen controls use PageAgent's standard click path. Lumi does not request the `debugger` permission or add a synthetic keyboard fallback that cannot provide genuine user activation.
- MCP servers are added from **Settings → Connected tools**.
- Every MCP tool can be set to **Always allow**, **Ask every time**, or **Block**.
- Invalid or rejected tools are isolated so voice, chat, and other tools remain available.
- Tool activity cards expose arguments, status, duration, result, failure, or cancellation.

## Quick Connect integrations

Lumi Settings includes two extension-only connector rows in addition to the existing custom MCP URL form. Redmine opens a focused URL/API-key popup, while Notion starts secure OAuth immediately:

| Connector | Transport and authentication |
| --- | --- |
| Notion | Official `https://mcp.notion.com/mcp` endpoint with OAuth, PKCE, and dynamic client registration |
| Redmine | Built-in REST adapter using a custom Redmine base URL and `X-Redmine-API-Key` |

For Notion, Lumi discovers the provider's OAuth metadata, dynamically registers this installed extension as a public client, creates the PKCE verifier and state locally, and opens the provider's authorization page with `chrome.identity.launchWebAuthFlow`. The single-use code is exchanged directly with the provider and the resulting values are saved only in `chrome.storage.local`. No Lumi backend participates in authorization or refresh.

Notion and Redmine use their recognizable app icons throughout Settings. Generic custom URL servers use the official Model Context Protocol icon. A built-in connector disappears from **Popular work tools** as soon as it is connected, keeping Quick Connect focused only on available choices; it remains in **Connected tools** until the user removes it.

Redmine setup:

1. Enable REST API in **Administration → Settings → API**.
2. Copy the API key from **My account**.
3. Enter the installation's full base URL, including a custom path such as `https://work.example.com/redmine`, and the API key.

The built-in Redmine adapter exposes project and issue tools plus `redmine_get_spent_time`, which totals the connected user's time entries for today or a requested `YYYY-MM-DD` date.

Write-style connector tools default to **Ask every time**. Users can change each tool to **Always allow**, **Ask every time**, or **Block** in the existing permission screen.

Each connected server also has an enable switch. Turning it off keeps the saved OAuth token or Redmine API key and all permission choices, but skips connection and tool-schema loading for new Gemini sessions. Turning it back on reconnects with the saved credential, so no new authorization is required unless the provider session itself has expired.

## Local data and permissions

The Gemini key, selected voice, thinking level, avatar preference, MCP servers, dynamically registered OAuth client metadata, OAuth tokens, Redmine API keys, and tool policies are stored in `chrome.storage.local`, which is isolated to the extension's Chrome profile and is not synchronized through `chrome.storage.sync`. Conversation context is not stored there; it remains in side-panel memory until the panel closes. Removing a connector deletes its saved connector identity and tokens. Connector authorization codes, tokens, OAuth credentials, and API keys are never sent to a Lumi-owned backend; they are sent only to the relevant provider or authorized MCP/Redmine endpoint.

This local-only boundary means the extension author does not receive connector credentials or maintain user accounts. It does not mean no third party processes connector content: Notion, Redmine, or a user-configured MCP server serves the requested data, and MCP tool inputs/results needed for the agent task can be sent to the user's configured Gemini service. `chrome.storage.local` is browser-profile storage, not an operating-system encrypted credential vault, so users must still protect their Chrome profile and device.

The first voice session opens a dedicated microphone permission page. If access was previously denied, use **Fix access** in Settings.

For a published extension, replace the local API-key flow with backend-issued ephemeral tokens.
