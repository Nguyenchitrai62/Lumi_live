import type { FormEventHandler, RefObject } from "react";
import { PetalLayer } from "./PetalLayer";
import { formatMcpValue } from "../lib/mcp";
import { TOOL_ACTIVITY_LABELS } from "../lib/live/config";
import type { ChatMessage, McpApprovalRequest, SessionStatus } from "../lib/live/types";

type StudioConversationPanelProps = {
  petalsEnabled: boolean;
  status: SessionStatus;
  statusMessage: string;
  mcpApproval: McpApprovalRequest | null;
  messages: ChatMessage[];
  transcriptEndRef: RefObject<HTMLDivElement | null>;
  input: string;
  composerLocked: boolean;
  composerCancelMode: boolean;
  turnCancellationPending: boolean;
  onResolveMcpApproval: (allowed: boolean, alwaysAllow?: boolean) => void;
  onSendText: (text: string) => void;
  onInputChange: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
};

export function StudioConversationPanel({
  petalsEnabled,
  status,
  statusMessage,
  mcpApproval,
  messages,
  transcriptEndRef,
  input,
  composerLocked,
  composerCancelMode,
  turnCancellationPending,
  onResolveMcpApproval,
  onSendText,
  onInputChange,
  onSubmit,
}: StudioConversationPanelProps) {
  return (
    <aside className={`conversation-panel ${petalsEnabled ? "petals-enabled" : "petals-disabled"}`}>
      <PetalLayer className="conversation-petal-field" enabled={petalsEnabled} />
      <div className="conversation-head">
        <div>
          <span className="eyebrow">HISTORY</span>
          <h1>Conversation</h1>
        </div>
        <span className={`connection-badge badge-${status}`}>
          {status === "ready" ? "Live" : status === "connecting" ? "Joining" : status === "error" ? "Retry" : "Offline"}
        </span>
      </div>

      <div className={`status-note note-${status}`} role="status">
        <span>{status === "error" ? "!" : status === "ready" ? "●" : "✦"}</span>
        <p>{statusMessage}</p>
      </div>

      {mcpApproval && (
        <section className="mcp-tool-notice" role="alert" aria-labelledby="mcp-tool-notice-title">
          <span className="mcp-tool-notice-icon" aria-hidden="true">!</span>
          <div className="mcp-tool-notice-copy">
            <strong id="mcp-tool-notice-title">Allow MCP tool: {mcpApproval.tool.toolName}?</strong>
            <p>{mcpApproval.tool.serverName} wants to run this tool with:</p>
            <code>{formatMcpValue(mcpApproval.args, 260)}</code>
          </div>
          <div className="mcp-tool-notice-actions">
            <button type="button" className="mcp-tool-notice-secondary" onClick={() => onResolveMcpApproval(false)}>Deny</button>
            <button type="button" className="mcp-tool-notice-tertiary" onClick={() => onResolveMcpApproval(true, true)}>Always allow</button>
            <button type="button" className="mcp-tool-notice-primary" onClick={() => onResolveMcpApproval(true)}>Allow once</button>
          </div>
        </section>
      )}

      <div className="transcript" aria-live="polite">
        {messages.map((message) => message.role === "tool" ? (
          <details key={message.id} className="mcp-activity" data-state={message.state}>
            <summary>
              <span className="mcp-activity-icon" aria-hidden="true" />
              <span>
                <small>{message.activityLabel || "MCP TOOL"}</small>
                <strong>{message.title}</strong>
              </span>
              <span className="mcp-activity-status" role="status">
                {message.state ? TOOL_ACTIVITY_LABELS[message.state] : "Running"}
              </span>
              <span className="mcp-activity-chevron" aria-hidden="true" />
            </summary>
            <div className="mcp-activity-body">
              <dl className="mcp-activity-meta">
                <div><dt>Server</dt><dd>{message.serverName || "MCP server"}</dd></div>
                <div><dt>Started</dt><dd>{message.startedLabel || "—"}</dd></div>
                <div><dt>Duration</dt><dd>{message.durationLabel || (message.state === "waiting" ? "Waiting" : "Running")}</dd></div>
              </dl>
              <section>
                <span>Arguments</span>
                <pre>{message.args || "No arguments."}</pre>
              </section>
              {message.state && !["running", "waiting"].includes(message.state) && (
                <section>
                  <span>{message.state === "failed" ? "Error" : message.state === "cancelled" ? "Cancellation" : "Result"}</span>
                  <pre>{message.text}</pre>
                </section>
              )}
            </div>
          </details>
        ) : (
          <div key={message.id} className={`message message-${message.role}`}>
            <span className="message-author">{message.role === "lumi" ? "Lumi" : "You"}</span>
            <p>{message.text}</p>
          </div>
        ))}
        <div ref={transcriptEndRef} />
      </div>

      <div className="quick-prompts" aria-label="Roleplay starters">
        {["Set a moonlit café scene", "Tell me a tiny secret", "Let’s go on an adventure"].map((prompt) => (
          <button key={prompt} type="button" onClick={() => onSendText(prompt)} disabled={composerLocked}>{prompt}</button>
        ))}
      </div>

      <form className="message-form" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="message-input">Message Lumi</label>
        <input
          id="message-input"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder={status !== "ready"
            ? "Start voice chat to message…"
            : turnCancellationPending ? "Cancelling current action…"
              : composerCancelMode ? "Lumi is working…" : "Or type a message…"}
          disabled={composerLocked}
        />
        <button
          type="submit"
          data-mode={composerCancelMode ? "cancel" : "send"}
          disabled={status !== "ready" || turnCancellationPending || (!composerCancelMode && !input.trim())}
          aria-label={composerCancelMode ? "Cancel current action" : "Send message"}
          title={composerCancelMode ? "Cancel current action" : "Send message"}
        >
          <span className="message-send-icon" aria-hidden="true">↑</span>
          <span className="message-cancel-icon" aria-hidden="true" />
        </button>
      </form>
    </aside>
  );
}
