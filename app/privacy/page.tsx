import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | Lumi Live",
  description: "Privacy Policy for the Lumi Live Chrome extension.",
  alternates: {
    canonical: "https://lumi-live.nguyenchitrai.id.vn/privacy",
  },
};

const LAST_UPDATED = "August 3, 2026";

export default function PrivacyPolicyPage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <nav className={styles.nav} aria-label="Privacy policy navigation">
          <Link className={styles.brand} href="/" aria-label="Back to Lumi Live Studio">
            <Image src="/branding/logo.png" alt="" width={38} height={38} priority />
            <span>Lumi <strong>Live</strong></span>
          </Link>
          <Link className={styles.backLink} href="/">
            Back to Studio
          </Link>
        </nav>

        <header className={styles.hero}>
          <p className={styles.eyebrow}>Legal / Chrome Extension</p>
          <h1>Privacy Policy</h1>
          <p className={styles.lede}>
            This policy explains how the Lumi Live Chrome extension handles information
            when you use its AI conversation, live translation, browser automation, and
            connected-tool features.
          </p>
          <div className={styles.meta}>
            <span>Effective and last updated</span>
            <strong>{LAST_UPDATED}</strong>
          </div>
        </header>

        <section className={styles.summary} aria-labelledby="privacy-at-a-glance">
          <div>
            <p className={styles.summaryKicker}>Privacy at a glance</p>
            <h2 id="privacy-at-a-glance">No developer-operated data collection server</h2>
          </div>
          <p>
            Lumi Live stores its settings, credentials, and conversation history on your
            device. Information leaves your device only when needed to perform a feature
            you request, such as contacting Google Gemini, a service you connect through
            MCP, or a website you ask Lumi Live to interact with.
          </p>
        </section>

        <article className={styles.policy}>
          <section>
            <span className={styles.sectionNumber}>01</span>
            <div>
              <h2>Scope</h2>
              <p>
                This Privacy Policy applies to the Lumi Live Chrome extension. It does not
                replace the privacy policies of Google Gemini, websites you visit, or
                third-party MCP services that you choose to connect.
              </p>
            </div>
          </section>

          <section>
            <span className={styles.sectionNumber}>02</span>
            <div>
              <h2>Information Lumi Live handles</h2>
              <p>Depending on the features you choose to use, Lumi Live may handle:</p>
              <ul>
                <li>
                  <strong>User-provided content:</strong> text prompts, voice audio,
                  attached images, selected files, and conversation content.
                </li>
                <li>
                  <strong>Browser and website context:</strong> active-tab URLs and titles,
                  page content and structure, screenshots, form content, and interaction
                  details required to complete a user-requested browser action.
                </li>
                <li>
                  <strong>Media:</strong> microphone audio; audio from the tab or media
                  element selected for Live Translate; and captions, audio, video, or a
                  temporary media URL when the user requests a video summary or transcript.
                </li>
                <li>
                  <strong>Authentication and configuration information:</strong> a Gemini
                  API key, credentials or authorization tokens for MCP services, connected
                  service addresses, permissions, and extension preferences.
                </li>
                <li>
                  <strong>Local activity and history:</strong> chat sessions, transcripts,
                  task steps, captured screenshots, recorded browser flows, and related
                  settings saved by the extension.
                </li>
              </ul>
              <p>
                This information can contain personal data if you include personal data in
                a prompt, page, image, recording, file, or connected service.
              </p>
            </div>
          </section>

          <section>
            <span className={styles.sectionNumber}>03</span>
            <div>
              <h2>How information is used</h2>
              <p>Lumi Live uses information only to provide its user-facing features:</p>
              <ul>
                <li>Respond to voice, text, and image requests.</li>
                <li>Translate user-selected media audio.</li>
                <li>Create requested video summaries, transcripts, downloads, and timestamp-based follow-up analysis.</li>
                <li>Understand page context and perform browser actions requested by the user.</li>
                <li>Run tools through MCP services selected and configured by the user.</li>
                <li>Restore local conversations, preferences, and recorded workflows.</li>
                <li>Maintain security, reliability, and user-controlled permission boundaries.</li>
              </ul>
            </div>
          </section>

          <section>
            <span className={styles.sectionNumber}>04</span>
            <div>
              <h2>Local storage and retention</h2>
              <p>
                Lumi Live stores extension data locally using Chrome extension storage and
                IndexedDB. This can include credentials, settings, chat history, transcript
                snapshots, the latest five video-analysis transcripts, screenshots, and
                recorded flows. The developer does not receive or have access to this locally
                stored information.
              </p>
              <p>
                Local information remains on the device until it is deleted through Lumi
                Live, cleared through Chrome, or removed when the extension is uninstalled.
                Session-only information is discarded when it is no longer needed by the
                active browser session.
              </p>
            </div>
          </section>

          <section>
            <span className={styles.sectionNumber}>05</span>
            <div>
              <h2>When information is transmitted</h2>
              <p>
                Lumi Live does not send user information to a developer-operated collection
                or analytics server. To perform features requested by the user, necessary
                information may be transmitted directly from the browser to:
              </p>
              <ul>
                <li>
                  <strong>Google Gemini:</strong> prompts, audio, video, captions, temporary
                  media URLs, images, page context, screenshots, and tool results needed to
                  generate responses, plan requested actions, provide live translation, or
                  create a user-requested video summary or transcript. When Lumi must use the
                  Gemini Files API for video analysis, it deletes the temporary upload after
                  processing; Google&apos;s independent handling remains governed by its terms.
                </li>
                <li>
                  <strong>User-configured MCP services:</strong> tool arguments and relevant
                  context when the user invokes or approves a connected tool. These services
                  may include Notion, Atlassian, Redmine, Hicas, or another MCP endpoint
                  selected by the user.
                </li>
                <li>
                  <strong>User-selected websites:</strong> form values, files, or actions that
                  the user explicitly asks Lumi Live to submit or perform on that website.
                </li>
              </ul>
              <p>
                Information processed by those services is governed by their respective
                privacy policies and terms. Lumi Live does not control their independent
                retention practices.
              </p>
            </div>
          </section>

          <section>
            <span className={styles.sectionNumber}>06</span>
            <div>
              <h2>Data sharing and prohibited uses</h2>
              <p>Lumi Live does not:</p>
              <ul>
                <li>Sell user data or transfer it to data brokers.</li>
                <li>Use or transfer user data for advertising or personalized advertising.</li>
                <li>Use user data for lending or creditworthiness decisions.</li>
                <li>Use user data for purposes unrelated to Lumi Live&apos;s disclosed features.</li>
              </ul>
              <p>
                Information is transferred only as needed to provide a feature requested by
                the user, comply with applicable law, or protect users and the service from
                security threats.
              </p>
            </div>
          </section>

          <section>
            <span className={styles.sectionNumber}>07</span>
            <div>
              <h2>Security</h2>
              <p>
                Lumi Live uses secure connections for Google Gemini and its built-in cloud
                integrations. Credentials are stored in the extension&apos;s local Chrome storage
                and are used only for the service to which they belong. Users should connect
                only trusted MCP services and use HTTPS for any remote custom MCP endpoint.
              </p>
            </div>
          </section>

          <section>
            <span className={styles.sectionNumber}>08</span>
            <div>
              <h2>Your choices and controls</h2>
              <ul>
                <li>Microphone and tab-audio access require user permission or action.</li>
                <li>Browser and MCP actions run in response to user requests and applicable approvals.</li>
                <li>You can stop an active session or translation from the extension.</li>
                <li>You can clear chat history and remove connected MCP services in Lumi Live.</li>
                <li>You can revoke Chrome permissions or uninstall the extension at any time.</li>
              </ul>
            </div>
          </section>

          <section>
            <span className={styles.sectionNumber}>09</span>
            <div>
              <h2>Chrome Web Store Limited Use disclosure</h2>
              <p>
                The use of information received from Google APIs will adhere to the Chrome
                Web Store User Data Policy, including the Limited Use requirements.
              </p>
            </div>
          </section>

          <section>
            <span className={styles.sectionNumber}>10</span>
            <div>
              <h2>Changes to this policy</h2>
              <p>
                This policy may be updated when Lumi Live&apos;s data practices or legal
                requirements change. The effective date at the top of this page will be
                updated when changes are published. Material changes will be disclosed as
                required before the new practices take effect.
              </p>
            </div>
          </section>

          <section>
            <span className={styles.sectionNumber}>11</span>
            <div>
              <h2>Contact</h2>
              <p>
                For privacy questions or requests concerning Lumi Live, contact:
              </p>
              <a className={styles.email} href="mailto:trainguyenchi30@gmail.com">
                trainguyenchi30@gmail.com
              </a>
            </div>
          </section>
        </article>

        <footer className={styles.footer}>
          <span>(c) 2026 Lumi Live</span>
          <Link href="/">Return to Lumi Live Studio</Link>
        </footer>
      </div>
    </main>
  );
}
