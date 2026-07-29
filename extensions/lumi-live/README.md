# Lumi Live

The standalone Chrome extension runs Gemini Live, the Lumi Pixel Companion, the Lumi VTuber, PageAgent browser controls, and user-configured MCP tools without requiring the Next.js app.

## Work on the current ERP tab

The default experience is prompt-first. Open the ERP page, open Lumi beside it,
and type the outcome you want. For every typed turn, the extension supplies a
fresh extension-authored Work Target containing the exact active tab title and
sanitized URL. Gemini therefore starts with a semantic page observation and
works on that tab without asking which website to use.

Work Mode keeps browser actions on the selected host unless the user's prompt
explicitly names another website. On `sit.hawee.hicas.vn`, generic prompt work
also protects all pre-existing projects: project edit, save, update, and delete
controls are blocked outside the create-project route. A newly created project
becomes writable only after Lumi observes a conclusive redirect to that new
project during the same conversation. Excel QC remains available as an optional
audited workflow when a workbook-driven run is needed.

It also exposes a built-in `live_translate` agent tool backed by `gemini-3.5-live-translate-preview`. The tool reuses the saved Gemini API key, captures the active media element's audio, and plays the translated speech itself so the conversational agent does not repeat the dialogue.

The collapsible **Excel Web Agent** workspace connects only to a loopback Lumi
QC service. It compiles `.xlsx` test specifications, displays the full plan,
accepts an optional feature/spec reference workbook, supports Gemini-assisted
mapping through strict `qc_*` tools, and controls
approve/start/pause/resume/cancel. During execution, the service persists the
`PLAN → OBSERVE → ACT → STABILIZE → VERIFY → RECORD → RECOVER → COMPLETE`
timeline and produces a new executed workbook and HTML report. The source
workbook is never overwritten.

Reference workbooks cannot expand the approved plan. Missing expected results
remain blocking specification issues. For a domain adapter that enables
run-created project ownership, each browser mapping also carries an entity
scope; the extension cannot reclassify an existing project as owned.

The conversational agent uses `gemini-3.1-flash-live-preview`; setup can fall
back to `gemini-2.5-flash-native-audio-preview-12-2025` when the primary model
is unavailable. Live Translate remains isolated on
`gemini-3.5-live-translate-preview` and is never used as a tool-calling agent.

## HICAS QC 0.2.0

The extension packages `skills/hicas-erp-qc/SKILL.md`, its agent metadata, and
the module references as source files. `npm run build:extension` validates those
files, rejects credential/UUID/business-data findings, and regenerates
`runtime-index.json` with source SHA-256, route fingerprints, controls, fields,
workflows, and coverage. On HICAS pages the agent must call
`hicas_get_skill_context` before planning or after a route change.

QC Fast mode applies short visual delays only to an exact `skill_record` whose
packaged control status is `verified`. Every other control, an unknown selector,
a changed fingerprint, or inconclusive verification falls back to normal step
mode. Observation, post-action verification, checkpointing, owned-sandbox
restrictions, and separate high-risk approval remain mandatory.

The Excel Web Agent now includes approved prompt plans, data comparison across
all grid pages, schedules based on a previously successful run, terminal
attention banners/badges/notifications, redacted audit evidence, and editable
Redmine bug drafts. A draft is never sent until the user presses **Send**.

## Install

```powershell
npm run build:extension
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose `extensions/lumi-live`.
3. Open Settings from the gear button.
4. Save a Gemini API key, choose a voice, and allow microphone access.
5. Choose a **Thinking** level in the composer if needed and open an HTTP/HTTPS tab. To let PageAgent read and control local `file://` pages too, open Lumi's extension details and enable **Allow access to file URLs**. The side panel connects voice automatically after the API key and microphone permission are ready. The default is **Minimal** for the lowest latency. You can change Thinking at any time; Lumi reconnects with the new level while retaining the current conversation.

For ordinary conversational turns, the **Thinking** panel starts expanded, keeps the transcript scrolled to the newest thought, and streams Gemini's thought summary as it arrives. Thinking and standalone MCP details open and collapse over 0.5 seconds. Thinking collapses automatically when answer content begins, remains in the transcript, and can be expanded again. When a turn becomes a structured **Lumi Task**, its Step View owns the reflection and tool presentation: the preliminary Thinking card is removed and task-owned MCP/Live Translate calls do not create duplicate activity cards. Approval notices remain visible because they require a user decision. If Gemini delivers transcript text as one large block, Lumi progressively reveals it at 400 characters per second without a typing cursor. This is Gemini's summary of its reasoning, not its private raw chain of thought. Default settings and visible UI timings—including Thinking, click, form input, scrolling, and every phase of the Google departure effect—are plain variables in `core/ui-config.js`.

Tool tasks run through the code-enforced `lumi_agent_step` protocol. Gemini Live still performs the planning, but it sees one macro-tool instead of choosing among every browser and MCP declaration directly. Each step must provide a concise evaluation of the previous goal, durable memory, one next goal, and exactly one action. The extension executes that action, records its observation in one historical event stream, and returns the remaining step budget. A tool task can finish only through the structured `done` action; if Gemini ends a turn early, the controller requests the missing completion event before releasing the queued user message.

The conversation shows a unified **Lumi Task** Step View for browser, Live Translate, and MCP work. It is the single UI source for each task step and displays reflection, action input, observation, output, duration, retry state, loop warning, and terminal result. The compact timeline uses readable action labels and high-contrast state colors. Running or failed steps open automatically and completed steps stay compact. Auto-follow runs only while the transcript is at the actual bottom; scrolling even slightly upward disables it until the user returns fully to the bottom. When the user explicitly opens a step, live task DOM updates are queued until that step closes, preserving the outer viewport, inner detail scroll, focus, and expansion state without visual jumps. Repeated action-and-argument fingerprints against an unchanged observation are blocked, and every task has a 24-action budget with warnings near the limit.

The protocol validates and safely coerces each selected action's arguments against that action's real Gemini schema before execution. An empty `memory` value is normalized to a neutral “No durable facts yet” checkpoint instead of failing the step. Browser work is enforced as observe-act-verify: actions require prior state, and the controller automatically captures a bounded fresh page state after successful UI actions so Gemini can continue without another model/tool round trip. Results such as file assignment that explicitly require later page verification remain inconclusive until a targeted observation proves completion. Successful `done` calls must include observed evidence and a per-goal completion list.

If the Gemini key is missing or invalid, a centered warning opens Lumi Settings from its action button. If the Live WebSocket ends unexpectedly, the same warning surface offers **Reconnect**.

The chat box remains editable while Lumi is responding or reconnecting. Sending during an active response adds the message to a visible queue and sends it automatically when the current turn finishes. Choose **Steer** on the queue row to interrupt the current turn and send that message immediately, or use the trash icon to remove it. Voice transcripts and typed turns are saved locally in extension IndexedDB and are supplied as bounded initial history after a WebSocket reconnect, so Lumi stays silent instead of greeting again. Closing the panel ends the Live socket but preserves the conversation. Users can rename, continue, delete one, or delete all conversations. Storage is capped at 100 conversations or 100 MB; Lumi warns at the cap and never silently removes history.

The chat composer accepts one JPEG, PNG, WebP, or GIF image per message from the attachment button, the clipboard, or drag and drop. Lumi shows a removable preview, resizes the image locally before sending it as a Gemini Live video frame, and omits the automatic active-tab screenshot for that message so the attached image remains the only visual context.

Long-running Live sessions use Gemini's context-window compression and session-resumption handles. While idle, Lumi opens and completes a resumed successor WebSocket before closing its predecessor, handles server `GoAway` messages, and retries transient disconnects in the background. This does not send fake user turns or heartbeat prompts to the model. If native resumption is unavailable, Lumi falls back to the panel's bounded conversation history.

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
| `../../qc_service/` | Local FastAPI compiler, SQLite run state, approval gate, and reports |
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

- **PAGEAGENT TARGET** follows the active HTTP, HTTPS, or permitted `file://` tab automatically.
- Page element guides are optional and disabled by default.
- Tab listing and switching include every tab Chrome exposes; the result identifies whether PageAgent can control that tab. Switching to a tab that already exists happens immediately without an overlay transition. For a destination that is not already available, Lumi completes the Google Search sequence on the current page before Chrome creates and activates the new tab. If the current page is Chrome New Tab, a `chrome://` page, a local file without file access, or another restricted page, Lumi opens exactly `https://www.google.com/` in a new active tab, runs the transition there, and reuses that same tab for the requested destination so no extra Google tab remains. Every page-scroll call is animated over 1 second with an on-screen direction/progress HUD. A `text` target reveals matching rendered content, while `position=0` is the exact top, `position=0.5` the middle, and `position=1` the exact bottom. Form text is always revealed over 0.5 seconds.
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
| `DEFAULT_AGENT_MAX_STEPS` | `24` | Maximum non-`done` actions in one Lumi Task |
| `DEFAULT_IDENTICAL_STATE_ACTION_LIMIT` | `2` | Repeated identical actions allowed against the same observation |
| `DEFAULT_COMPLETION_RECOVERY_LIMIT` | `2` | Recovery prompts when Gemini omits structured `done` |
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

The Gemini key, selected voice, thinking level, avatar preference, MCP servers, dynamically registered OAuth client metadata, OAuth tokens, Redmine API keys, and tool policies are stored in `chrome.storage.local`, which is isolated to the extension's Chrome profile and is not synchronized through `chrome.storage.sync`. Sanitized conversations are stored separately in IndexedDB; raw model thinking, API keys, tokens, cookies, passwords, and secret-bearing arguments are excluded. Removing a connector deletes its saved connector identity and tokens. Connector authorization codes, tokens, OAuth credentials, and API keys are never sent to a Lumi-owned backend; they are sent only to the relevant provider or authorized MCP/Redmine endpoint.

This local-only boundary means the extension author does not receive connector credentials or maintain user accounts. It does not mean no third party processes connector content: Notion, Atlassian, Redmine, or a user-configured MCP server serves the requested data, and MCP tool inputs/results needed for the agent task can be sent to the user's configured Gemini service. `chrome.storage.local` is browser-profile storage, not an operating-system encrypted credential vault, so users must still protect their Chrome profile and device.

The first voice session opens a dedicated microphone permission page. If access was previously denied, use **Fix access** in Settings.

For a published extension, replace the local API-key flow with backend-issued ephemeral tokens.
