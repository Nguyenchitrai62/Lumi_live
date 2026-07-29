#!/usr/bin/env node
// Redmine MCP server (stdio, zero dependencies).
// Ported from extensions/lumi-live/background/redmine-mcp-client.js so the QC
// agent keeps the same tool surface after moving to Claude Cowork.
//
// Configuration comes from the environment; never hard-code an API key here.
//   REDMINE_URL      e.g. https://redmine.anybim.vn
//   REDMINE_API_KEY  personal API key from /my/api_key

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const REQUEST_TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = "2024-11-05";

const baseUrl = normalizeBaseUrl(process.env.REDMINE_URL || "");
const apiKey = String(process.env.REDMINE_API_KEY || "").trim();

function normalizeBaseUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("Set REDMINE_URL to an absolute Redmine URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("REDMINE_URL must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Do not put Redmine credentials in REDMINE_URL.");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/g, "");
  return url.href.replace(/\/+$/g, "");
}

const TOOLS = [
  {
    name: "redmine_get_current_user",
    description: "Get the Redmine user associated with this server's API key. Use once to confirm the connection before any write.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "redmine_list_projects",
    description: "List Redmine projects visible to the connected user. Use to resolve the project identifier a QC issue belongs to.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "redmine_search_issues",
    description: "List and filter Redmine issues. For the QC re-test loop, pass statusId=\"resolved\" or \"closed\" plus updatedOn to find defects a developer has just fixed.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier or numeric ID as text." },
        statusId: { type: "string", description: "Status ID, or open, closed, *." },
        assignedToId: { type: "string", description: "User ID, me, or *." },
        trackerId: { type: "string" },
        updatedOn: { type: "string", description: "Redmine date filter, e.g. >=2026-07-01." },
        subject: { type: "string", description: "Substring match on subject, e.g. a QC test key." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        sort: { type: "string", description: "Defaults to updated_on:desc." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "redmine_get_issue",
    description: "Read one Redmine issue including journals, relations and attachments. Use to check whether a defect was fixed before re-running its test.",
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "integer", minimum: 1 } },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "redmine_create_issue",
    description: "Create a Redmine issue. This writes external data, so confirm with the user first. Put the stable QC test key in the subject or description so the re-test loop can find this issue later.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier or numeric ID as text." },
        subject: { type: "string", minLength: 1 },
        description: { type: "string" },
        trackerId: { type: "integer", minimum: 1 },
        statusId: { type: "integer", minimum: 1 },
        priorityId: { type: "integer", minimum: 1 },
        assignedToId: { type: "integer", minimum: 1 },
        dueDate: { type: "string", description: "YYYY-MM-DD." },
        attachmentPaths: {
          type: "array",
          items: { type: "string" },
          maxItems: 10,
          description: "Absolute local paths of evidence screenshots to upload and attach.",
        },
      },
      required: ["projectId", "subject"],
      additionalProperties: false,
    },
  },
  {
    name: "redmine_update_issue",
    description: "Update fields on a Redmine issue. This writes external data, so confirm with the user first. Use to reopen an issue whose re-test still fails.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "integer", minimum: 1 },
        subject: { type: "string", minLength: 1 },
        description: { type: "string" },
        statusId: { type: "integer", minimum: 1 },
        priorityId: { type: "integer", minimum: 1 },
        assignedToId: { type: "integer", minimum: 1 },
        doneRatio: { type: "integer", minimum: 0, maximum: 100 },
        dueDate: { type: ["string", "null"], description: "YYYY-MM-DD, or null to clear." },
        attachmentPaths: { type: "array", items: { type: "string" }, maxItems: 10 },
      },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "redmine_add_issue_note",
    description: "Add a journal note to a Redmine issue. This writes external data, so confirm with the user first. Use to record a re-test result with its evidence.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "integer", minimum: 1 },
        notes: { type: "string", minLength: 1 },
        privateNotes: { type: "boolean" },
        attachmentPaths: { type: "array", items: { type: "string" }, maxItems: 10 },
      },
      required: ["issueId", "notes"],
      additionalProperties: false,
    },
  },
];

function cleanObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

async function request(path, {
  method = "GET",
  query,
  body,
  rawBody,
  contentType = "application/json",
} = {}) {
  if (!apiKey) throw new Error("Set REDMINE_API_KEY before calling Redmine.");
  const url = new URL(`${baseUrl}/${String(path).replace(/^\/+/g, "")}`);
  for (const [name, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": contentType,
        "X-Redmine-API-Key": apiKey,
      },
      body: rawBody === undefined
        ? body === undefined ? undefined : JSON.stringify(body)
        : rawBody,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error("Redmine returned invalid JSON.");
      }
    }
    if (!response.ok) {
      const detail = result?.errors?.join(" ") || result?.error || text;
      throw new Error(
        `Redmine returned HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}.`,
      );
    }
    return result ?? { success: true, status: response.status };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(timedOut ? "Redmine did not respond within 20 seconds." : "The Redmine request was cancelled.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

const CONTENT_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".html", "text/html"],
]);

async function uploadAttachment(filePath) {
  const filename = basename(filePath);
  const bytes = await readFile(filePath);
  const upload = await request("uploads.json", {
    method: "POST",
    query: { filename },
    rawBody: bytes,
    contentType: "application/octet-stream",
  });
  const token = String(upload?.upload?.token || "").trim();
  if (!token) throw new Error(`Redmine accepted ${filename} but returned no attachment token.`);
  return {
    token,
    filename,
    content_type: CONTENT_TYPES.get(extname(filename).toLowerCase()) || "application/octet-stream",
  };
}

async function prepareUploads(paths) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  const uploads = [];
  for (const filePath of list) uploads.push(await uploadAttachment(filePath));
  return uploads;
}

function issuePayload(args, includeProject, uploads) {
  return cleanObject({
    project_id: includeProject ? args.projectId : undefined,
    subject: args.subject,
    description: args.description,
    tracker_id: args.trackerId,
    status_id: args.statusId,
    priority_id: args.priorityId,
    assigned_to_id: args.assignedToId,
    done_ratio: args.doneRatio,
    due_date: args.dueDate,
    uploads: uploads.length ? uploads : undefined,
  });
}

async function callTool(name, args = {}) {
  if (name === "redmine_get_current_user") {
    return request("users/current.json");
  }
  if (name === "redmine_list_projects") {
    return request("projects.json", {
      query: { limit: args.limit || 25, offset: args.offset || 0 },
    });
  }
  if (name === "redmine_search_issues") {
    return request("issues.json", {
      query: {
        project_id: args.projectId,
        status_id: args.statusId,
        assigned_to_id: args.assignedToId,
        tracker_id: args.trackerId,
        updated_on: args.updatedOn,
        subject: args.subject ? `~${args.subject}` : undefined,
        limit: args.limit || 25,
        offset: args.offset || 0,
        sort: args.sort || "updated_on:desc",
      },
    });
  }
  if (name === "redmine_create_issue") {
    if (!String(args.subject || "").trim() || args.projectId === undefined) {
      throw new Error("Redmine projectId and subject are required.");
    }
    const uploads = await prepareUploads(args.attachmentPaths);
    const result = await request("issues.json", {
      method: "POST",
      body: { issue: issuePayload(args, true, uploads) },
    });
    if (result?.issue?.id && !result.issue.url) {
      result.issue.url = `${baseUrl}/issues/${result.issue.id}`;
    }
    return result;
  }

  const issueId = Number(args.issueId);
  if (!Number.isInteger(issueId) || issueId < 1) {
    throw new Error("A positive Redmine issueId is required.");
  }
  if (name === "redmine_get_issue") {
    return request(`issues/${issueId}.json`, {
      query: { include: "journals,relations,attachments" },
    });
  }
  if (name === "redmine_update_issue") {
    const uploads = await prepareUploads(args.attachmentPaths);
    await request(`issues/${issueId}.json`, {
      method: "PUT",
      body: { issue: issuePayload(args, false, uploads) },
    });
    return { updated: true, issueId, url: `${baseUrl}/issues/${issueId}` };
  }
  if (name === "redmine_add_issue_note") {
    const notes = String(args.notes || "").trim();
    if (!notes) throw new Error("Redmine notes must not be empty.");
    const uploads = await prepareUploads(args.attachmentPaths);
    await request(`issues/${issueId}.json`, {
      method: "PUT",
      body: {
        issue: cleanObject({
          notes,
          private_notes: args.privateNotes === true,
          uploads: uploads.length ? uploads : undefined,
        }),
      },
    });
    return { noted: true, issueId, url: `${baseUrl}/issues/${issueId}` };
  }
  throw new Error(`Unsupported Redmine tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "redmine", version: "0.1.0" },
      instructions:
        "Redmine REST bridge for the QC agent. Read tools are safe. Ask the user for explicit confirmation before create, update, or note actions. Always include the stable QC test key in an issue subject or description so a later re-test can find it.",
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = String(params?.name || "");
    try {
      const result = await callTool(name, params?.arguments || {});
      reply(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (error) {
      reply(id, {
        content: [{
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        }],
        isError: true,
      });
    }
    return;
  }
  replyError(id, -32601, `Unsupported method: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    newlineIndex = buffer.indexOf("\n");
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      replyError(null, -32700, "Parse error");
      continue;
    }
    void handle(message).catch((error) => {
      replyError(message?.id, -32603, error instanceof Error ? error.message : String(error));
    });
  }
});
process.stdin.on("end", () => process.exit(0));
