# Site Capability Indexer Lab

An independent Manifest V3 Chrome extension for testing deterministic website
capability indexing before integrating the approach into Lumi Live.

The build step uses no LLM. It opens a Chrome tab, scans rendered DOM and
accessibility metadata, explores same-origin links and policy-approved
read-only disclosure controls, deduplicates UI states, and stores a capability
graph in the extension's own `chrome.storage.local`.

## Load the lab

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `extensions/site-indexer-lab` folder.
5. Click the extension action to open the dashboard.
6. Enter an `http`, `https`, or permitted `file` URL and choose **Lập chỉ mục**.

Keep the dashboard open while an index build is running. For `file://` test
pages, enable **Allow access to file URLs** in the extension details first.

Choose between 1 and 8 parallel workers in the dashboard. Four workers is the
recommended default. Worker tabs share one crawl queue and immediately take the
next available route instead of waiting for the slowest tab in a fixed batch.
They run in the background and are placed in a collapsed Chrome tab group while
the build is active. After a worker has loaded the application once, it prefers
the site's own same-origin navigation links so SPA routes can reuse the current
session and app shell; direct URL loading remains the automatic fallback.

## Included safe demo

The `demo-target` folder contains a small multi-screen site with links, tabs,
menus, a dialog, forms, and intentionally consequential controls.

Either open `demo-target/index.html` as a `file://` URL after enabling file
access, or serve the repository locally and index its HTTP URL. The crawler
should explore the menu, tabs, help dialog, project list, and settings screen,
while leaving Create, Save, Delete, Upload, and Submit controls untouched.

## Safety model

The crawler never types into form fields. It explores only:

- same-origin `http`, `https`, or `file` links without dangerous action words;
- tabs, summaries, menus, accordions, dialogs, filters, and other disclosure
  controls that match the deterministic allow policy.

Controls associated with submission, saving, creation, deletion, publishing,
payments, transfers, uploads, downloads, authentication changes, or unknown
side effects are indexed but never clicked.

This is a conservative prototype, not a proof that a website is side-effect
free. Use a staging environment or a read-only test account for broad scans.

## Output

The dashboard provides:

- screen and UI-state cards;
- discovered safe capabilities;
- forms and field labels without input values;
- graph transitions between states;
- a Markdown preview and `.md` download.

The structured graph stored in extension storage remains the source format.
Markdown is a compact readable export: navigation shared by most screens is
written once, repeated controls are collapsed into collections, self-loop
transitions are omitted, and route variants are grouped together. During a
build the dashboard defers Markdown generation and batches result persistence
so rendering does not become progressively slower.

The crawler fingerprints selected and expanded controls, table structure, form
schema, dialogs, headings, and a normalized hash of the main content. After
three confirmed no-op actions from the same control family on one screen, the
remaining queued siblings are pruned without opening another page. A future
Lumi integration should retrieve only the relevant index sections for the
current route and user intent, then obtain fresh live DOM state before every
real action.

The UI wait setting is an upper bound. A mutation observer continues as soon as
the page has been quiet for a short window, so fast screens no longer pay the
full configured delay. New navigations start scanning after the main document
and content script are ready; slow images, analytics, and other subresources no
longer have to reach Chrome's full `complete` state first. The Markdown report
includes total build time, average job time, and the five slowest routes.

## Test the pure indexing policy

From the repository root:

```powershell
node --test extensions/site-indexer-lab/tests/*.test.mjs
```
