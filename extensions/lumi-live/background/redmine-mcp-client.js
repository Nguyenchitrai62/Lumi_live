const REDMINE_REQUEST_TIMEOUT_MS = 20_000;

export function normalizeRedmineBaseUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("Enter an absolute Redmine URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Redmine URL must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Do not put Redmine credentials in the URL.");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/g, "");
  return url.href.replace(/\/+$/g, "");
}

const REDMINE_TOOLS = Object.freeze([
  {
    name: "redmine_get_current_user",
    description: "Get the Redmine user associated with this connector's API key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "redmine_list_projects",
    description: "List Redmine projects visible to the connected user.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Projects to return. Defaults to 25." },
        offset: { type: "integer", minimum: 0, description: "Pagination offset. Defaults to 0." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "redmine_search_issues",
    description: "List and filter Redmine issues. Use projectId, statusId, assignedToId, or updatedOn as needed.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier or numeric ID encoded as text." },
        statusId: { type: "string", description: "Status ID, open, closed, or * for all." },
        assignedToId: { type: "string", description: "User ID, me, or *." },
        trackerId: { type: "string", description: "Tracker ID encoded as text." },
        updatedOn: { type: "string", description: "Redmine date filter, for example >=2026-07-01." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Issues to return. Defaults to 25." },
        offset: { type: "integer", minimum: 0, description: "Pagination offset. Defaults to 0." },
        sort: { type: "string", description: "Redmine sort expression. Defaults to updated_on:desc." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "redmine_get_issue",
    description: "Read one Redmine issue, including journals and relations.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "integer", minimum: 1 },
      },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "redmine_get_spent_time",
    description: "Get and total Redmine time entries for one day. Defaults to the connected user and today's local date.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format. Defaults to today in the user's local timezone." },
        userId: { type: "string", description: "Redmine user ID or me. Defaults to me." },
        projectId: { type: "string", description: "Optional project identifier or numeric ID encoded as text." },
        includeEntries: { type: "boolean", description: "Include individual time-entry details. Defaults to true." },
        maxEntries: { type: "integer", minimum: 1, maximum: 100, description: "Maximum entry details to return. Defaults to 100." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "redmine_create_issue",
    description: "Create a Redmine issue. This changes external data and should be confirmed by the user.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project identifier or numeric ID encoded as text." },
        subject: { type: "string", minLength: 1 },
        description: { type: "string" },
        trackerId: { type: "integer", minimum: 1 },
        statusId: { type: "integer", minimum: 1 },
        priorityId: { type: "integer", minimum: 1 },
        assignedToId: { type: "integer", minimum: 1 },
        dueDate: { type: "string", description: "Date in YYYY-MM-DD format." },
      },
      required: ["projectId", "subject"],
      additionalProperties: false,
    },
  },
  {
    name: "redmine_update_issue",
    description: "Update fields on a Redmine issue. This changes external data and should be confirmed by the user.",
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
        dueDate: { type: ["string", "null"], description: "Date in YYYY-MM-DD format, or null to clear." },
      },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "redmine_add_issue_note",
    description: "Add a journal note to a Redmine issue. This changes external data and should be confirmed by the user.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "integer", minimum: 1 },
        notes: { type: "string", minLength: 1 },
        privateNotes: { type: "boolean" },
      },
      required: ["issueId", "notes"],
      additionalProperties: false,
    },
  },
]);

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function issuePayload(args, includeProject = false) {
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
  });
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeSpentTimeDate(value) {
  const date = String(value || localDateString()).trim();
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("Redmine spent-time date must use YYYY-MM-DD.");
  const normalized = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (normalized.toISOString().slice(0, 10) !== date) {
    throw new Error("Redmine spent-time date is not a valid calendar date.");
  }
  return date;
}

function summarizeTimeEntry(entry) {
  return {
    id: entry.id,
    project: entry.project || null,
    issue: entry.issue || null,
    user: entry.user || null,
    activity: entry.activity || null,
    hours: Number(entry.hours) || 0,
    comments: typeof entry.comments === "string" ? entry.comments : "",
    spentOn: entry.spent_on || "",
    createdOn: entry.created_on || "",
    updatedOn: entry.updated_on || "",
  };
}

export class RedmineMcpClient {
  constructor(rawUrl, apiKey) {
    this.url = normalizeRedmineBaseUrl(rawUrl);
    this.apiKey = String(apiKey || "").trim();
    if (!this.apiKey) throw new Error("Enter a Redmine API key.");
    this.protocolVersion = "built-in-rest-adapter";
    this.serverInfo = {
      name: `Redmine · ${new URL(this.url).hostname}`,
      version: "",
    };
    this.instructions = "Use Redmine read tools for project context. Ask for explicit user approval before create, update, or note actions.";
  }

  async request(path, { method = "GET", query, body, signal } = {}) {
    const url = new URL(`${this.url}/${String(path).replace(/^\/+/g, "")}`);
    for (const [name, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REDMINE_REQUEST_TIMEOUT_MS);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Redmine-API-Key": this.apiKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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
        throw new Error(`Redmine returned HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 300)}` : ""}.`);
      }
      return result ?? { success: true, status: response.status };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(timedOut ? "Redmine did not respond within 20 seconds." : "The Redmine request was cancelled.");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
    }
  }

  async connect() {
    const result = await this.request("users/current.json");
    const user = result?.user || {};
    this.instructions = `${this.instructions} Connected as ${user.firstname || ""} ${user.lastname || ""}`.trim();
    return {
      protocolVersion: this.protocolVersion,
      serverInfo: this.serverInfo,
      user,
    };
  }

  async listTools() {
    return REDMINE_TOOLS.map((tool) => structuredClone(tool));
  }

  async getSpentTime(args = {}, options = {}) {
    const date = normalizeSpentTimeDate(args.date);
    const userId = String(args.userId || "me").trim() || "me";
    const projectId = args.projectId === undefined ? "" : String(args.projectId).trim();
    const includeEntries = args.includeEntries !== false;
    const maxEntries = Math.min(100, Math.max(1, Number(args.maxEntries) || 100));
    const entries = [];
    let totalCount = 0;
    let offset = 0;
    const hardLimit = 1000;

    do {
      const page = await this.request("time_entries.json", {
        query: {
          user_id: userId,
          project_id: projectId,
          from: date,
          to: date,
          limit: 100,
          offset,
        },
        signal: options.signal,
      });
      const pageEntries = Array.isArray(page?.time_entries) ? page.time_entries : [];
      entries.push(...pageEntries);
      totalCount = Number(page?.total_count);
      if (!Number.isInteger(totalCount) || totalCount < entries.length) totalCount = entries.length;
      offset += pageEntries.length;
      if (!pageEntries.length) break;
    } while (offset < totalCount && entries.length < hardLimit);

    const summarized = entries.map(summarizeTimeEntry);
    return {
      date,
      userId,
      projectId: projectId || null,
      entryCount: totalCount,
      fetchedEntryCount: summarized.length,
      totalHours: Math.round(summarized.reduce((total, entry) => total + entry.hours, 0) * 100) / 100,
      truncated: summarized.length < totalCount,
      totalHoursIsPartial: summarized.length < totalCount,
      entries: includeEntries ? summarized.slice(0, maxEntries) : [],
      entryDetailsTruncated: includeEntries && summarized.length > maxEntries,
    };
  }

  async callTool(name, args = {}, options = {}) {
    if (name === "redmine_get_current_user") {
      return this.request("users/current.json", { signal: options.signal });
    }
    if (name === "redmine_list_projects") {
      return this.request("projects.json", {
        query: { limit: args.limit || 25, offset: args.offset || 0 },
        signal: options.signal,
      });
    }
    if (name === "redmine_search_issues") {
      return this.request("issues.json", {
        query: {
          project_id: args.projectId,
          status_id: args.statusId,
          assigned_to_id: args.assignedToId,
          tracker_id: args.trackerId,
          updated_on: args.updatedOn,
          limit: args.limit || 25,
          offset: args.offset || 0,
          sort: args.sort || "updated_on:desc",
        },
        signal: options.signal,
      });
    }
    if (name === "redmine_get_spent_time") {
      return this.getSpentTime(args, options);
    }
    if (name === "redmine_create_issue") {
      if (!String(args.subject || "").trim() || args.projectId === undefined) {
        throw new Error("Redmine projectId and subject are required.");
      }
      return this.request("issues.json", {
        method: "POST",
        body: { issue: issuePayload(args, true) },
        signal: options.signal,
      });
    }
    const issueId = Number(args.issueId);
    if (!Number.isInteger(issueId) || issueId < 1) throw new Error("A positive Redmine issueId is required.");
    if (name === "redmine_get_issue") {
      return this.request(`issues/${issueId}.json`, {
        query: { include: "journals,relations" },
        signal: options.signal,
      });
    }
    if (name === "redmine_update_issue") {
      return this.request(`issues/${issueId}.json`, {
        method: "PUT",
        body: { issue: issuePayload(args) },
        signal: options.signal,
      });
    }
    if (name === "redmine_add_issue_note") {
      const notes = String(args.notes || "").trim();
      if (!notes) throw new Error("Redmine notes must not be empty.");
      return this.request(`issues/${issueId}.json`, {
        method: "PUT",
        body: { issue: { notes, private_notes: args.privateNotes === true } },
        signal: options.signal,
      });
    }
    throw new Error(`Unsupported Redmine tool: ${name}`);
  }
}
