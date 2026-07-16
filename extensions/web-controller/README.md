# Lumi PageAgent Controller

This Manifest V3 extension embeds only Alibaba PageAgent's LLM-independent `@page-agent/page-controller`. Gemini Live remains the only model and calls each DOM tool itself.

## Install locally

1. From the project root, run `npm run build:extension`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select `extensions/web-controller`.
5. Pin **Lumi PageAgent Controller**.
6. Reload the extension after each local build, then refresh Lumi.
7. Open the tab Lumi should control and click the extension icon once. Its badge becomes `ON`.
8. Return to Lumi and start voice/screen sharing normally.

Screen sharing never connects a tab automatically. The share picker grants visual access only; browser control starts only after the explicit extension-icon click.

After pressing **Reload** on `chrome://extensions`, refresh every already-open Lumi web tab once. Chrome invalidates the previous content-script context during an extension reload; the bridge now handles that state without throwing, but only a page refresh installs the new bridge instance.

An existing `ON` connection is reused across voice sessions and restored with retries after navigation. Click the icon on that tab to disconnect it explicitly.

PageAgent's controller supplies the simplified DOM, element indices, scrolling and form actions, numbered highlights, animated pointer, click ripple, and interaction mask. `@page-agent/core`, `@page-agent/llms`, and `PAGE_AGENT_EXT.execute()` are intentionally not used.
