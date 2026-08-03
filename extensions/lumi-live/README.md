# Lumi Live

The standalone Chrome extension runs Gemini Live, the Lumi Pixel Companion, the Lumi VTuber, PageAgent browser controls, and user-configured MCP tools without requiring the Next.js app.

It also exposes a built-in `live_translate` agent tool backed by `gemini-3.5-live-translate-preview`. The tool reuses the saved Gemini API key, captures the active media element's audio, and plays the translated speech itself so the conversational agent does not repeat the dialogue.

The built-in `video_analyze_current` tool returns audio links, summarizes, or transcribes the current video, a complete YouTube/Facebook/Udemy URL through `sourceUrl`, or a public HTTPS audio file through `audioUrl`. Lumi never opens an audio URL automatically; it shows an explicit **Open audio link** button in the side panel. Transcript and summary requests first reuse an exact stored transcript or complete caption/subtitle track. Caption timestamps are checked against known video duration so a partially loaded or stale player track does not masquerade as a full transcript. YouTube reads captions from the current live player response before trying direct audio. If audio is UMP, inaccessible, or too large for the extension upload path, Lumi sends the public YouTube URL directly to Gemini without requiring a backend. Facebook is inspected only in the prompt-locked active **Agent Space** tab: Lumi never creates or reloads a duplicate Facebook tab, retries exact media discovery in place, and rejects adjacent Reels. Udemy keeps caption-only frames and retries authenticated caption downloads inside the exact player frame before using audio. If no complete captions can be read and an optional Groq key is configured, Groq transcribes verified audio and tries `whisper-large-v3-turbo`, then `whisper-large-v3` on rate limit. Without a Groq key, Lumi skips Groq and uses Gemini 3.5 Flash-Lite. Transcript requests add a downloadable `.txt` card and retain the latest five analyses locally.

## Install

```powershell
npm run build:extension
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose `extensions/lumi-live`.
3. Open Settings from the gear button.
4. Save a Gemini API key, optionally add a Groq key for Whisper transcripts, choose a voice, and allow microphone access.
5. Choose a **Thinking** level in the composer if needed and open an HTTP/HTTPS tab. To let PageAgent read and control local `file://` pages too, open Lumi's extension details and enable **Allow access to file URLs**. The side panel connects voice automatically after the API key and microphone permission are ready. The default is **Minimal** for the lowest latency. You can change Thinking at any time; Lumi reconnects with the new level while retaining the current conversation.

Video analysis is extension-only and has no backend URL setting. Lumi uses page captions, direct signed media URLs, a small in-extension upload when possible, and Gemini's public YouTube URL input. It never calls a local yt-dlp or loopback helper.

Use the **Fast** button in the side-panel topbar, or the **Fast mode** switch in Settings, when throughput matters more than presentation. Fast mode creates a yellow **Agent Space** Chrome tab group and treats it as a strict agent workspace. Each prompt is locked to exactly one tab: the active workspace tab, or the active controllable tab that Lumi first moves into **Agent Space**. Every sibling workspace tab is excluded from tool listings, page context, screenshots, media discovery, transcripts, and summaries for that prompt; changing Chrome focus while the prompt is running does not change the locked target. `browser_switch_tab` rejects sibling workspace tabs until the next prompt. A destination explicitly required by the request may replace the target, and agent-opened or click-opened destinations join the group without taking focus when a new tab is required. PageAgent indexes every rendered interactive element across the complete DOM in one observation, including off-viewport controls, and semantic queries resolve accessible labels, descriptions, open Shadow DOM, and same-origin frames. Those indices can be clicked, filled, selected, or batched directly without exploratory viewport scrolling. Explicit vertical or horizontal scrolling remains available and executes as an immediate jump with no animation; Normal mode also supports horizontal scrolling but keeps its standard animation. Genuinely virtualized content still has to enter the DOM before it can be indexed. Fast mode hides both avatar renderers and the petal/background scene, stops their animation loops, removes panel transitions and transcript reveal effects, disables PageAgent highlights, pointer/mask effects, gradual typing, and the Google departure animation. `browser_batch_actions` applies up to 200 independent mixed selection, text-field, and HTML-select edits, while `browser_set_selection` compactly applies one idempotent state to as many as 300 selection controls. Both preflight the complete batch, reject duplicate or unsupported targets, skip already-correct states, and verify each applied value. Navigation and consequential final actions remain separate so the normal verification and confirmation boundaries still apply. Visual screenshots still require the workspace tab to be visible; background work uses PageAgent's semantic DOM state. Turning Fast mode off or closing the side panel ungroups—but does not close—workspace tabs. If the saved Fast preference remains enabled, reopening the panel immediately creates the workspace around the active controllable tab. The first-install default is controlled by `DEFAULT_FAST_MODE_ENABLED` in `core/ui-config.js`.

For ordinary conversational turns, the **Thinking** panel starts expanded, keeps the transcript scrolled to the newest thought, and streams Gemini's thought summary as it arrives. Thinking and standalone MCP details open and collapse over 0.5 seconds. Thinking collapses automatically when answer content begins, remains in the transcript, and can be expanded again. When a turn becomes a structured **Lumi Task**, its Step View owns the reflection and tool presentation: the preliminary Thinking card is removed and task-owned MCP/Live Translate calls do not create duplicate activity cards. Approval notices remain visible because they require a user decision. If Gemini delivers transcript text as one large block, Lumi progressively reveals it at 400 characters per second without a typing cursor. This is Gemini's summary of its reasoning, not its private raw chain of thought. Default settings and visible UI timings—including Thinking, click, form input, scrolling, and every phase of the Google departure effect—are plain variables in `core/ui-config.js`.

Tool tasks run through the code-enforced `lumi_agent_step` protocol. Gemini Live still performs the planning, but it sees one macro-tool instead of choosing among every browser and MCP declaration directly. The original required contract—evaluation of the previous goal, durable memory, one next goal, and exactly one action—remains unchanged. Multi-outcome work can additionally publish an evidence verdict and ordered unfinished-outcome ledger. The extension records each observation, returns the remaining step budget, and adds a re-plan warning after repeated failures; when the optional ledger is present, successful `done` is rejected until it is empty. These browser-use-inspired improvements are deliberately confined to the agent harness: the PageAgent controller configuration, element indexing, click/input/select implementations, Fast workspace, settings, and visual shell retain their `main` behavior.

The conversation shows a unified **Lumi Task** Step View for browser, Live Translate, and MCP work. It is the single UI source for each task step and displays reflection, action input, observation, output, duration, retry state, loop warning, and terminal result. The compact timeline uses readable action labels and high-contrast state colors. Running or failed steps open automatically and completed steps stay compact. Auto-follow runs only while the transcript is at the actual bottom; scrolling even slightly upward disables it until the user returns fully to the bottom. When the user explicitly opens a step, live task DOM updates are queued until that step closes, preserving the outer viewport, inner detail scroll, focus, and expansion state without visual jumps. Repeated action-and-argument fingerprints against an unchanged observation are blocked, and every task has a 100-action budget with warnings near the limit.

The protocol validates and safely coerces each selected action's arguments against that action's real Gemini schema before execution. An empty `memory` value is normalized to a neutral “No durable facts yet” checkpoint instead of failing the step. Browser work is enforced as observe-act-verify: actions require prior state, and the controller automatically captures a bounded fresh page state after successful UI actions so Gemini can continue without another model/tool round trip. Results such as file assignment that explicitly require later page verification remain inconclusive until a targeted observation proves completion. Successful `done` calls must include observed evidence and a per-goal completion list.

With a saved Gemini key, opening the side panel connects directly to Gemini Live without a separate REST key-validation request. The old Connect/Disconnect button is removed: normal startup is automatic, while a failed initial WebSocket or an authorized-turn connection failure opens the centered **Reconnect** surface. A missing or rejected key opens the same surface with a direct Lumi Settings action. A WebSocket that disconnects only after a completed idle session stays quiet and reconnects when the user sends the next text or confirmed voice request.

The chat box remains editable while Lumi is responding or reconnecting. Sending during an active response adds the message to a visible queue and sends it automatically when the current turn finishes. Choose **Steer** on the queue row to interrupt the current turn and send that message immediately, or use the trash icon to remove it. Final user and Lumi text turns are organized into local chat sessions in `chrome.storage.local` and restored when the side panel opens again. **New chat** starts a clean Gemini context; during an idle session it waits for the next real user message before connecting again. If a chat is created, selected, deleted, or cleared while the old chat is still responding, Lumi closes that old transport, opens an isolated clean transport, and queues the new prompt until it is ready so late output cannot reactivate the Send/Cancel state in the new chat. If any empty New chat already exists, Lumi selects that session and removes redundant empty duplicates instead of creating another. The conversation selector opens a desktop-style history panel for switching between or deleting older sessions, and delete/Clear all confirmations remain inside the side panel. A legacy single transcript is migrated into the first named session automatically. Lumi retains up to 50 sessions, 200 turns and 250,000 characters per session, with a 1,500,000-character total context cap. When a fresh socket has to rebuild conversational memory, it supplies at most the latest 10 turns and 18,000 characters: the newest user request is retained whole within its generous per-turn allowance, while older user/Lumi turns preserve their beginning and conclusion with low-priority middle detail omitted locally. This deterministic projection does not call a model or add a summarization turn. The current task is handled separately: its request anchor, remaining-goal ledger, durable identifiers, complete newest tool observation, browser controls, and verification evidence are never thinned by the chat-history policy. Fast full-page state now has a substantially larger allowance for large forms. In parallel, each session keeps a complete local IndexedDB transcript snapshot containing user/Lumi messages, Thinking cards, every Lumi Task step and result, MCP activity, captured screenshots, attached-image previews, disclosure state, and transcript scroll position. Restored task cards remain expandable and their structured event history continues with collision-free IDs. **Clear all** removes both context metadata and complete transcript snapshots.

The chat composer accepts one JPEG, PNG, WebP, or GIF image per message from the attachment button, the clipboard, or drag and drop. Lumi shows a removable preview, resizes the image locally before sending it as a Gemini Live video frame, and omits the automatic active-tab screenshot for that message so the attached image remains the only visual context.

Long-running Live sessions use Gemini's context-window usage metadata and session-resumption handles only while authorized work is in progress. Lumi does not rotate, revive, or send realtime input to an idle WebSocket. A server `GoAway`, full context, or idle disconnect pauses the transport; the next real user request opens one fresh connection with bounded recent history. Automatic retries are reserved for a queued message or an active user-authorized turn. Empty initial-history turns are never sent, restored unfinished task cards cannot trigger completion recovery by themselves, and unexpected model/tool output without a current user authorization is ignored. Microphone audio is locally gated: a short sustained speech signal is required before buffered pre-roll and the active utterance are streamed, so ambient idle frames are not continuously sent to Gemini.

## Live video translation

1. Keep the video tab active and start a Lumi voice session.
2. Name any supported target language, for example **“Translate this video to Japanese”**, **“…to Polish”**, or **“…to Vietnamese.”**
3. Lumi maps the requested language to its BCP-47 code and calls `live_translate`. The target is never fixed to the UI language. Lumi routes the active media element audio into the translation pipeline, lowers the original audio to 6%, and shows the Translate badge.
4. Say **“Stop live translation”** to release the capture and restore the tab's original audio, or press **End voice** to stop translation and the whole live-agent session.

Lumi first tries to capture the actively playing HTML video or audio element directly. This automatic path works after switching tabs even when the toolbar click that opened the side panel happened on another tab. It lowers that element to 6%, streams 100 ms PCM frames to the offscreen translator, and restores the previous volume on stop, tab switch, navigation, panel close, or failure. No Share Screen picker is used.

The Lumi toolbar icon only toggles the side panel. Live Translate first captures audio automatically from the active HTML video or audio element without a separate toolbar permission step. If direct capture is unavailable, Lumi shows a **Share tab audio** notice; the user can choose **Chrome Tab** and enable audio in Chrome's picker to continue through the same pending translation tool call. Live Translate supports Google's documented 70+ target languages, accepts speech audio only, and is not used for ordinary text or page translation.

Live translation uses 100 ms PCM input chunks and a bounded realtime input queue. Translated audio is always played at its original speed; Lumi never pauses, seeks, or changes the playback rate of the video.

After rebuilding, press **Reload** on `chrome://extensions` and reopen any old Lumi Live or Settings pages.

## Video summary and transcript

1. Open a YouTube video, Facebook Reel, Udemy lecture, or another web player in the current active tab, or paste a supported video link directly into the request.
2. Ask **“Get the audio link”**, **“Summarize this video”**, **“Get the transcript”**, or request both analysis outputs. When the request contains a supported link, the agent passes it as `sourceUrl` and Lumi opens the source page when needed. A Facebook Reel always opens in a fresh exact permalink tab; if verified audio is still missing after collection, Lumi reloads that tab once. `action=audio` only resolves the link and does not call Gemini or Groq.
3. Lumi resolves the audio-only representation belonging to that exact video and shows an **Open audio link** card. It never opens that audio URL automatically. YouTube and many Facebook/Udemy links are signed and temporary, so they should be used promptly. Lumi stops with an explicit error if it cannot verify an audio URL for an audio-link request; it does not open a nearby Reel, video-only variant, individual segment, encrypted stream, or ambiguous media request.
4. Lumi first tries complete captions belonging to the exact video: live YouTube player timed text, Facebook caption metadata tied to the exact Reel ID, and Udemy text tracks, embedded player JSON, caption-only frames, or authenticated in-frame caption requests. If captions are absent, incomplete, stale, or unreadable and a Groq key exists, YouTube and other direct audio files first use Groq's `url` parameter. If Groq rejects a small YouTube URL, the extension downloads and uploads the file itself. If that direct path is inaccessible, UMP, or larger than 19.5 MB, Lumi sends the public watch URL directly to Gemini without contacting a backend.
5. Lumi tries `whisper-large-v3-turbo` first. A 429/rate-limit or temporary-capacity response immediately disables Turbo for that run and retries with `whisper-large-v3`. Only if both models are limited does Lumi ask Gemini to transcribe the verified audio. An invalid configured Groq key is shown directly instead of silently changing providers. Without a Groq key, Lumi skips Groq completely and uses exact captions first, then Gemini 3.5 Flash-Lite.
6. For `summary` and `both`, Lumi sends the complete timestamped stored, caption, Groq, or Gemini-fallback transcript into Gemini context when available, then creates the overview and chapters. YouTube can instead be summarized directly from its public watch URL when audio preparation is unavailable. Transcript and `both` requests show a **Download transcript** link. A later `action=inspect` request reuses the newest matching transcript from the five-item local cache; `inspect` does not reopen media.

If a player has not made a usable caption/media request yet, start or seek the video briefly and retry. DRM-protected/encrypted Udemy streams are never bypassed; use the course subtitle track when available. Players that expose only a `blob:` URL and no completed media request cannot provide a complete ten-minute transcript in seconds. Lumi reports that limitation instead of silently recording the tab in real time. Audio-only analysis covers speech and sound but cannot recover important visual-only details; direct video and YouTube inputs use low media resolution for the first fast pass.

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

`manifest.json` loads the bundled `dist/background.js`, `side-panel/index.html`, and `settings/index.html`. `extensions/build.mjs` bundles both `background/index.js` (including MP4Box for AAC extraction) and `browser/controller.js` into `dist/`. `npm test` validates these paths and recursively resolves every local JavaScript import reachable at runtime.

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

- **PAGEAGENT TARGET** follows the active HTTP, HTTPS, or permitted `file://` tab automatically in Normal mode. In Fast mode, each prompt captures exactly one active tab ID. If that tab is outside the dedicated **Agent Space** group in the same Chrome window, Lumi moves it into the group first. If it is already inside a multi-tab Agent Space, only that active tab is captured. The ID remains fixed for the whole prompt even if focus later changes.
- Page element guides are optional and disabled by default.
- In Normal mode, tab listing and switching include every tab Chrome exposes in the relevant window; switching activates the destination and new destinations keep the existing Google Search transition behavior. In Fast mode, `browser_list_tabs` returns only the prompt-locked tab and `browser_switch_tab` rejects every sibling Agent Space tab, preventing their title, URL, DOM, media, captions, or transcript from entering context. A destination explicitly needed by the request can replace the target and opens inactive inside **Agent Space** without the Google sequence. In standard mode, every page-scroll call is animated over 1 second with an on-screen direction/progress HUD and form text is revealed over 0.5 seconds. Fast mode performs both immediately. A `text` target reveals matching rendered content, while `position=0` is the exact top, `position=0.5` the middle, and `position=1` the exact bottom.
- While Lumi is generating or running a browser/MCP tool, the send button becomes a circular stop control. Cancelling interrupts the Gemini turn, stops playback and visual actions, and aborts active MCP requests without ending the voice session.
- If a PageAgent click opens a YouTube video link or starts a paused YouTube video, Lumi locally suppresses only its remaining response audio for that turn. Output transcription still appears, and the next turn speaks normally even while the video remains open.
- Local file uploads use the built-in `browser_upload_file` tool. It resolves a compatible input from the selected trigger, nearby container, accepted file types, labels, or menu-backed controls; assigns only the exact absolute paths authorized by the user; and falls back to intercepting a dynamically created native chooser.
- Multi-step browser requests use a generic observe-act-verify loop. Targeted semantic-DOM queries preserve the controls around an exact filename, object name, status, or action on long pages, while `browser_wait_for_page_state` handles asynchronous UI transitions without sending raw full-page HTML to the model.
- Browser and MCP execution uses a reflection-before-action state machine in `live/task-orchestrator.js`. Its historical events are the task source of truth for the Step View, completion status, retry accounting, step budget, and loop fingerprints.
- Ordinary state and interaction failures are returned as recoverable. Lumi must try distinct fresh-state, targeted-query, waiting, prerequisite, scrolling, and alternate-interaction tactics before reporting a blocker; permission, confirmation, local-file, Chrome-policy, security, and cancellation failures remain hard blockers.
- Thinking details remain expanded across tool calls and collapse only after visible Lumi response content begins to render.
- Video fullscreen controls continue to use PageAgent's standard click path; the `debugger` permission is used only while Lumi is handling an authorized local-file assignment or native file chooser.
- MCP servers are added from **Settings → Connected tools**.
- Every MCP tool can be set to **Always allow**, **Ask every time**, or **Block**.
- Invalid or rejected tools are isolated so voice, chat, and other tools remain available.
- Tool activity cards expose arguments, status, duration, result, failure, or cancellation.

## Central Lumi Task tuning

Task orchestration and Step View tuning values live in `core/ui-config.js`. Change them there, then run `npm run build:extension` and reload the unpacked extension:

| Constant | Default | Controls |
| --- | ---: | --- |
| `DEFAULT_AGENT_MAX_STEPS` | `100` | Maximum non-`done` actions in one Lumi Task |
| `DEFAULT_IDENTICAL_STATE_ACTION_LIMIT` | `2` | Repeated identical actions allowed against the same observation |
| `DEFAULT_COMPLETION_RECOVERY_LIMIT` | `2` | Recovery prompts when Gemini omits structured `done` |
| `DEFAULT_FAST_MODE_ENABLED` | `false` | Fast mode when the user has not stored a preference yet |
| `TASK_AUTO_FOLLOW_BOTTOM_TOLERANCE_PX` | `1` | Distance from the actual transcript bottom that enables auto-follow |
| `TASK_STEP_DISCLOSURE_ANIMATION_DURATION_MS` | `220` | Step expand/collapse duration |
| `TASK_STEP_DETAIL_MAX_HEIGHT_PX` | `430` | Absolute expanded-detail height cap |
| `TASK_STEP_DETAIL_MAX_VIEWPORT_HEIGHT_PERCENT` | `58` | Expanded-detail viewport-height cap |

## Quick Connect integrations

Lumi Settings includes three extension-only connector rows in addition to the existing custom MCP URL form. Redmine opens a focused URL/API-key popup, while Notion and Jira start secure OAuth immediately:

| Connector | Transport and authentication |
| --- | --- |
| Notion | Official `https://mcp.notion.com/mcp` endpoint with OAuth, PKCE, and dynamic client registration |
| Jira | Official Atlassian Rovo MCP endpoint at `https://mcp.atlassian.com/v1/mcp/authv2` with OAuth, PKCE, and dynamic client registration |
| Redmine | Built-in REST adapter using a custom Redmine base URL and `X-Redmine-API-Key` |

For Notion and Jira, Lumi discovers the provider's OAuth metadata, dynamically registers this installed extension as a public client, creates the PKCE verifier and state locally, and opens the provider's authorization page with `chrome.identity.launchWebAuthFlow`. The single-use code is exchanged directly with the provider and the resulting values are saved only in `chrome.storage.local`. No Lumi backend participates in authorization or refresh.

Notion, Jira, and Redmine use their recognizable app icons throughout Settings. Generic custom URL servers use the official Model Context Protocol icon. A built-in connector disappears from **Popular work tools** as soon as it is connected, keeping Quick Connect focused only on available choices; it remains in **Connected tools** until the user removes it.

The Jira connector targets Jira Cloud through Atlassian's Rovo MCP server. An Atlassian organization admin may need to allow the extension's `chromiumapp.org` OAuth redirect domain before a user can approve the connection. Jira Server and Jira Data Center require a separate REST or custom MCP connector instead.

Redmine setup:

1. Enable REST API in **Administration → Settings → API**.
2. Copy the API key from **My account**.
3. Enter the installation's full base URL, including a custom path such as `https://work.example.com/redmine`, and the API key.

The built-in Redmine adapter exposes project and issue tools plus `redmine_get_spent_time`, which totals the connected user's time entries for today or a requested `YYYY-MM-DD` date.

Write-style connector tools default to **Ask every time**. Users can change each tool to **Always allow**, **Ask every time**, or **Block** in the existing permission screen.

Each connected server also has an enable switch. Turning it off keeps the saved OAuth token or Redmine API key and all permission choices, but skips connection and tool-schema loading for new Gemini sessions. Turning it back on reconnects with the saved credential, so no new authorization is required unless the provider session itself has expired.

## Local data and permissions

The Gemini key, optional Groq key, selected voice, thinking level, Fast mode state, avatar preference, chat-session context metadata, MCP servers, dynamically registered OAuth client metadata, OAuth tokens, Redmine API keys, and tool policies are stored in `chrome.storage.local`, which is isolated to the extension's Chrome profile and is not synchronized through `chrome.storage.sync`. Complete visual chat transcripts are stored per session in the extension's local IndexedDB database; `unlimitedStorage` prevents image-rich task history from being truncated by the small default extension quota. Removing a session deletes its IndexedDB snapshot, and **Clear all** clears the snapshot store. Removing a connector deletes its saved connector identity and tokens. Connector authorization codes, tokens, OAuth credentials, and API keys are never sent to a Lumi-owned backend; they are sent only to the relevant provider or authorized MCP/Redmine endpoint. For a user-requested transcript or summary, verified direct audio URLs or small audio files prepared inside the extension can be sent to Groq when its key is configured. No Lumi backend or loopback helper is used for video analysis.

This local-only boundary means the extension author does not receive connector credentials or maintain user accounts. It does not mean no third party processes connector content: Notion, Atlassian, Redmine, or a user-configured MCP server serves the requested data, and MCP tool inputs/results needed for the agent task can be sent to the user's configured Gemini service. `chrome.storage.local` is browser-profile storage, not an operating-system encrypted credential vault, so users must still protect their Chrome profile and device.

The first voice session opens a dedicated microphone permission page. If access was previously denied, use **Fix access** in Settings.

For a published extension, replace the local API-key flow with backend-issued ephemeral tokens.
