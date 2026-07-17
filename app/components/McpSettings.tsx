"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { McpServerView, McpToolPolicy } from "../lib/mcp";

type McpSettingsProps = {
  servers: McpServerView[];
  url: string;
  busy: boolean;
  message: string;
  onUrlChange: (value: string) => void;
  onConnect: () => void;
  onReconnect: (serverId: string) => void;
  onRemove: (serverId: string) => void;
  onToolPolicy: (serverId: string, toolName: string, mode: McpToolPolicy) => void;
  onServerPolicy: (serverId: string, mode: McpToolPolicy) => void;
};

const POLICY_OPTIONS: Array<{
  mode: McpToolPolicy;
  label: string;
  shortLabel: string;
  icon: string;
}> = [
  { mode: "allow", label: "Always allow", shortLabel: "Allow", icon: "✓" },
  { mode: "ask", label: "Ask every time", shortLabel: "Ask", icon: "?" },
  { mode: "block", label: "Block", shortLabel: "Block", icon: "×" },
];

function PermissionIcons({
  serverId,
  toolName,
  selected,
  disabled = false,
  onToolPolicy,
}: {
  serverId: string;
  toolName: string;
  selected: McpToolPolicy;
  disabled?: boolean;
  onToolPolicy: McpSettingsProps["onToolPolicy"];
}) {
  return (
    <div className="mcp-permission-icons" role="group" aria-label={`Permission for ${toolName}`}>
      {POLICY_OPTIONS.map((option) => (
        <button
          key={option.mode}
          type="button"
          data-mode={option.mode}
          aria-label={`${option.label} for ${toolName}`}
          aria-pressed={!disabled && selected === option.mode}
          title={option.label}
          disabled={disabled}
          onClick={() => onToolPolicy(serverId, toolName, option.mode)}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}

export function McpSettings({
  servers,
  url,
  busy,
  message,
  onUrlChange,
  onConnect,
  onReconnect,
  onRemove,
  onToolPolicy,
  onServerPolicy,
}: McpSettingsProps) {
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const selectedServer = servers.find((server) => server.id === selectedServerId) ?? null;
  const modalOpen = Boolean(selectedServer);
  const toolCount = servers.reduce((total, server) => total + server.toolCount, 0);

  const aggregatePermission = useMemo(() => {
    if (!selectedServer) return null;
    const enabledTools = selectedServer.tools.filter((tool) => tool.gemini.enabled);
    const modes = new Set(enabledTools.map((tool) => tool.permission));
    return modes.size === 1 ? [...modes][0] : null;
  }, [selectedServer]);

  useEffect(() => {
    if (!modalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedServerId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [modalOpen]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConnect();
  };

  const removeSelectedServer = () => {
    if (!selectedServer) return;
    onRemove(selectedServer.id);
    setSelectedServerId(null);
  };

  const modal = selectedServer ? (
    <div
      className="mcp-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSelectedServerId(null);
      }}
    >
      <section
        className="mcp-permission-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-permission-modal-title"
      >
        <header className="mcp-modal-header">
          <div className="mcp-modal-title">
            <span className="mcp-modal-mark" aria-hidden="true">M</span>
            <div>
              <span className="eyebrow">MCP PERMISSIONS</span>
              <h2 id="mcp-permission-modal-title">{selectedServer.serverName}</h2>
              <p>
                {selectedServer.tools.length} {selectedServer.tools.length === 1 ? "tool" : "tools"}
                {" · "}Choose what Lumi may use.
              </p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            className="mcp-modal-close"
            type="button"
            onClick={() => setSelectedServerId(null)}
            aria-label="Close MCP permissions"
          >
            ×
          </button>
        </header>

        <div className="mcp-modal-server-meta">
          <code title={selectedServer.url}>{selectedServer.url}</code>
          <span data-state={selectedServer.status}>
            {selectedServer.status === "connected"
              ? "Connected"
              : selectedServer.status === "connecting" ? "Connecting" : "Needs attention"}
          </span>
        </div>
        {selectedServer.error && <p className="mcp-modal-error">{selectedServer.error}</p>}

        <section className="mcp-bulk-permission" aria-labelledby="mcp-bulk-permission-title">
          <div>
            <strong id="mcp-bulk-permission-title">All tools</strong>
            <p>Set one policy for every compatible tool on this server.</p>
          </div>
          <div className="mcp-bulk-options" role="group" aria-label="Permission for all tools">
            {POLICY_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                data-mode={option.mode}
                aria-pressed={aggregatePermission === option.mode}
                disabled={busy || !selectedServer.tools.some((tool) => tool.gemini.enabled)}
                onClick={() => onServerPolicy(selectedServer.id, option.mode)}
                title={`Set all tools to ${option.label}`}
              >
                <span aria-hidden="true">{option.icon}</span>
                {option.shortLabel}
              </button>
            ))}
          </div>
        </section>

        <div className="mcp-modal-tool-list" role="list">
          {selectedServer.tools.length === 0 && (
            <div className="mcp-modal-empty">
              <strong>No tools published</strong>
              <p>Reconnect this server after it exposes at least one MCP tool.</p>
            </div>
          )}
          {selectedServer.tools.map((tool) => (
            <article
              className="mcp-permission-row"
              data-state={tool.gemini.enabled ? tool.permission : "disabled"}
              role="listitem"
              key={tool.name}
            >
              <div className="mcp-permission-copy">
                <code>{tool.name}</code>
                <p>{tool.description || "MCP tool"}</p>
                {!tool.gemini.enabled && (
                  <p className="mcp-tool-warning">
                    {tool.gemini.errors.join(" ") || "This tool schema is not compatible with Gemini Live."}
                  </p>
                )}
              </div>
              <PermissionIcons
                serverId={selectedServer.id}
                toolName={tool.name}
                selected={tool.permission}
                disabled={busy || !tool.gemini.enabled}
                onToolPolicy={onToolPolicy}
              />
            </article>
          ))}
        </div>

        <footer className="mcp-modal-footer">
          <span>Changes are saved immediately and apply to the next live session.</span>
          <div>
            <button
              type="button"
              onClick={() => onReconnect(selectedServer.id)}
              disabled={busy}
            >
              Reconnect
            </button>
            <button
              type="button"
              className="danger"
              onClick={removeSelectedServer}
              disabled={busy}
            >
              Remove server
            </button>
          </div>
        </footer>
      </section>
    </div>
  ) : null;

  return (
    <>
      <section className="settings-section mcp-settings" aria-labelledby="mcp-settings-title">
        <div className="settings-section-head">
          <div>
            <span className="eyebrow">TOOLS</span>
            <h2 id="mcp-settings-title">MCP servers</h2>
          </div>
          <span className="settings-count">{servers.length} · {toolCount}</span>
        </div>
        <p className="settings-description">
          Install public HTTPS Streamable HTTP servers. Open a server to manage its tool permissions.
        </p>

        <form className="mcp-add-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="mcp-server-url">MCP server URL</label>
          <input
            id="mcp-server-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder="https://example.com/mcp"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !url.trim()}>
            {busy ? "Connecting…" : "Install"}
          </button>
        </form>
        {message && <p className="mcp-status" role="status">{message}</p>}

        <div className="mcp-server-list">
          {servers.length === 0 && (
            <div className="mcp-empty">
              <strong>No MCP installed</strong>
              <span>Add a server URL to give Lumi new tools on the next live session.</span>
            </div>
          )}
          {servers.map((server) => (
            <article className={`mcp-server-card mcp-server-${server.status}`} key={server.id}>
              <button
                className="mcp-server-open"
                type="button"
                onClick={() => setSelectedServerId(server.id)}
                aria-label={`Open permissions for ${server.serverName}`}
              >
                <span className="mcp-server-mark" aria-hidden="true">M</span>
                <span className="mcp-server-copy">
                  <strong>{server.serverName}</strong>
                  <small>{server.status === "connected"
                    ? `${server.enabledToolCount} available · ${server.toolCount} total`
                    : server.status === "connecting" ? "Connecting…" : "Connection failed"}</small>
                </span>
                <span className="mcp-server-manage">Permissions <b aria-hidden="true">→</b></span>
              </button>
            </article>
          ))}
        </div>
      </section>
      {modal && createPortal(modal, document.body)}
    </>
  );
}
