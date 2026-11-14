import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ACTIVITY_KINDS, PRIORITIES, STATUS_CATEGORIES } from "../../shared/values.js";
import type { ApiCall, ApiResponse, Caller } from "./api.js";

/** What the tools need: whether the token is read-only, and a way to call the API as the Agent, within its Session. */
export interface ToolContext {
  readOnly: boolean;
  api: (caller: Caller) => ApiCall;
}

/** One `action` of a grouped tool: whether it writes, and the API call it maps onto. */
interface Action<Args> {
  description: string;
  writes: boolean;
  run: (api: ApiCall, args: Args) => Promise<ApiResponse> | ApiResponse;
}

/**
 * Registers a tool grouped by resource: one tool whose `action` parameter picks the
 * operation. A read-only token is offered only the actions that don't write.
 */
function registerGroupedTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  tool: { name: string; description: string; parameters: Shape; actions: Record<string, Action<z.infer<z.ZodObject<Shape>>>> },
): void {
  const offered = Object.entries(tool.actions).filter(([, a]) => !(ctx.readOnly && a.writes));
  const names = offered.map(([name]) => name) as [string, ...string[]];
  const actionList = offered.map(([name, a]) => `- \`${name}\`: ${a.description}`).join("\n");
  const inputSchema: z.ZodObject<z.ZodRawShape> = z.object({ action: z.enum(names).describe("What to do"), ...tool.parameters });
  server.registerTool(tool.name, { description: `${tool.description}\n\nActions:\n${actionList}`, inputSchema }, async (input, extra) => {
    const { action, ...args } = input as { action: string };
    const api = ctx.api({ token: extra.authInfo!.token, sessionId: extra.sessionId });
    try {
      return toResult(await tool.actions[action]!.run(api, args as z.infer<z.ZodObject<Shape>>));
    } catch (err) {
      if (err instanceof ToolError) return error(err.message);
      throw err;
    }
  });
}

/** A tool call the Agent got wrong, such as a missing parameter, answered as a tool error. */
class ToolError extends Error {}

function required<T>(value: T | undefined, what: string, action: string): T {
  if (value === undefined) throw new ToolError(`The ${action} action needs ${what}`);
  return value;
}

const error = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** The API's answer as a tool result: its JSON, or its error message followed by any details it carries as JSON. */
function toResult(res: ApiResponse): CallToolResult {
  if (res.status >= 400) {
    const { error: message, ...details } = res.body ?? {};
    const text = message ?? `The API answered ${res.status}`;
    return error(Object.keys(details).length > 0 ? `${text}\n\n${JSON.stringify(details)}` : text);
  }
  return { content: [{ type: "text", text: JSON.stringify(res.body ?? {}) }] };
}

/** A query string repeating each key once per value, as the API's list filters take them. */
function query(params: Record<string, string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, values] of Object.entries(params)) for (const value of values ?? []) search.append(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** Registers Cronk's tools, grouped by resource, each with an `action`. */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerGroupedTool(server, ctx, {
    name: "tickets",
    description: "Tickets: the units of work tracked in a Project, keyed like CRONK-12.",
    parameters: {
      project: z.string().optional().describe("Project key, such as CRONK (list)"),
      key: z.string().optional().describe("Ticket key, such as CRONK-12 (get, claim, release, move, create_sub_ticket)"),
      to: z.string().optional().describe("The Status to move into, by name or id (move)"),
      title: z.string().optional().describe("The new Sub-Ticket's title (create_sub_ticket)"),
      description: z.string().optional().describe("The new Sub-Ticket's Markdown description (create_sub_ticket)"),
      status: z.array(z.string()).optional().describe("Only Tickets in one of these Status ids (list)"),
      category: z.array(z.enum(STATUS_CATEGORIES)).optional().describe("Only Tickets whose Status is in one of these Status Categories (list)"),
      priority: z.array(z.enum(PRIORITIES)).optional().describe("Only Tickets with one of these Priorities (list)"),
      label: z.array(z.string()).optional().describe("Only Tickets with one of these Labels, ignoring case (list)"),
      assignee: z.array(z.string()).optional().describe("Only Tickets assigned to one of these User ids, or `none` for unassigned (list)"),
    },
    actions: {
      list: {
        description: "a Project's Tickets in key order, optionally filtered",
        writes: false,
        run: (api, a) => {
          const project = required(a.project, "a project", "list");
          const filters = query({ status: a.status, category: a.category, priority: a.priority, label: a.label, assignee: a.assignee });
          return api("GET", `/api/projects/${encodeURIComponent(project)}/tickets${filters}`);
        },
      },
      get: {
        description: "one Ticket with its Sub-Tickets and Relations",
        writes: false,
        run: (api, a) => api("GET", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "get"))}`),
      },
      next: {
        description: "claim your next Ready Ticket (highest Priority, then oldest) and get it; `next` is null when none is Ready",
        writes: true,
        run: (api) => api("POST", "/api/agent-sessions/current/next"),
      },
      claim: {
        description: "claim a Ticket delegated to you, so no other Agent Session works on it, and get it",
        writes: true,
        run: (api, a) => api("POST", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "claim"))}/claim`),
      },
      release: {
        description: "release your Claim on a Ticket, leaving it delegated to you for another Agent Session",
        writes: true,
        run: (api, a) => api("DELETE", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "release"))}/claim`),
      },
      move: {
        description:
          "move a Ticket you hold the Claim on into another Status (Unstarted, Started or In Review only); In Review needs a Report written during your current Claim (documents, write_report)",
        writes: true,
        run: async (api, a) => {
          const key = required(a.key, "a key", "move");
          const to = required(a.to, "a Status to move to", "move");
          const projectKey = key.slice(0, key.lastIndexOf("-"));
          const project = await api("GET", `/api/projects/${encodeURIComponent(projectKey)}`);
          if (project.status >= 400) return project;
          const statuses = project.body.statuses as { id: string; name: string }[];
          const status = statuses.find((s) => s.id === to) ?? statuses.find((s) => s.name.toLowerCase() === to.trim().toLowerCase());
          if (!status) throw new ToolError(`${projectKey.toUpperCase()} has no Status named ${to}; it has ${statuses.map((s) => s.name).join(", ")}`);
          return api("PATCH", `/api/tickets/${encodeURIComponent(key)}`, { statusId: status.id });
        },
      },
      create_sub_ticket: {
        description: "split a Ticket you hold the Claim on: create a Sub-Ticket that stays delegated to you",
        writes: true,
        run: (api, a) => {
          const key = required(a.key, "a key", "create_sub_ticket");
          const title = required(a.title, "a title", "create_sub_ticket");
          return api("POST", `/api/tickets/${encodeURIComponent(key)}/sub-tickets`, { title, ...(a.description !== undefined && { description: a.description }) });
        },
      },
    },
  });

  registerGroupedTool(server, ctx, {
    name: "activities",
    description:
      "Activities: the timestamped entries you write on a Ticket while you work on it, shown live to Users on its page. Write one while you hold the Ticket's Claim, " +
      "whenever you plan, make progress, find something or hit an error; each one keeps your Claim alive. " +
      "Ask a question as an Activity too, marking it blocking when you must wait for the answer.",
    parameters: {
      key: z.string().optional().describe("Ticket key, such as CRONK-12 (list, log, ask)"),
      kind: z.enum(ACTIVITY_KINDS.filter((k) => k !== "question") as [string, ...string[]]).optional().describe("What the Activity is (log)"),
      body: z.string().optional().describe("Markdown text of the Activity or question (log, ask)"),
      blocking: z.boolean().optional().describe("Whether you wait for the answer before carrying on; false if left out (ask)"),
    },
    actions: {
      list: {
        description: "a Ticket's Activities, oldest first",
        writes: false,
        run: (api, a) => api("GET", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "list"))}/activities`),
      },
      log: {
        description: "log a plan, progress, finding or error on a Ticket you hold the Claim on",
        writes: true,
        run: (api, a) =>
          api("POST", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "log"))}/activities`, {
            kind: required(a.kind, "a kind", "log"),
            body: required(a.body, "a body", "log"),
          }),
      },
      ask: {
        description: "ask a question on a Ticket you hold the Claim on; blocking if you wait for the answer",
        writes: true,
        run: (api, a) =>
          api("POST", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "ask"))}/activities`, {
            kind: "question",
            body: required(a.body, "a body", "ask"),
            ...(a.blocking !== undefined && { blocking: a.blocking }),
          }),
      },
    },
  });

  registerGroupedTool(server, ctx, {
    name: "comments",
    description:
      "Comments: conversation any User or Agent posts on a Ticket or a Document, kept apart from Activities. Reply to a Comment " +
      "to thread under it. A User answers your question by replying to its Activity. On a Document, a Comment can anchor to a " +
      "passage it is about. Comments that @mention you, answer your questions or land on Tickets delegated to you wait for you " +
      "in your welcome.",
    parameters: {
      key: z.string().optional().describe("Ticket key, such as CRONK-12, for its Comments (list, post)"),
      documentId: z.string().optional().describe("Document id, for its Comments, instead of a key (list, post)"),
      body: z.string().optional().describe("Markdown text of the Comment; @name mentions an Agent (post)"),
      replyToCommentId: z.string().optional().describe("The Comment to reply to, on the same Ticket or Document (post)"),
      replyToActivityId: z.string().optional().describe("The Activity on the same Ticket to reply to (post)"),
      passage: z.string().optional().describe("On a Document: the exact text of its current Version the Comment is about (post)"),
    },
    actions: {
      list: {
        description: "the Comments on a Ticket or a Document, oldest first",
        writes: false,
        run: (api, a) => api("GET", commentsPath(a, "list")),
      },
      post: {
        description: "post a Comment on a Ticket or a Document, optionally replying to a Comment or an Activity",
        writes: true,
        run: (api, a) =>
          api("POST", commentsPath(a, "post"), {
            body: required(a.body, "a body", "post"),
            ...(a.replyToCommentId !== undefined && { replyToCommentId: a.replyToCommentId }),
            ...(a.replyToActivityId !== undefined && { replyToActivityId: a.replyToActivityId }),
            ...(a.passage !== undefined && { anchor: { passage: a.passage } }),
          }),
      },
    },
  });

  registerGroupedTool(server, ctx, {
    name: "documents",
    description:
      "Documents: Markdown knowledge belonging to a Project or, without a project, the Workspace, arranged in a page tree. " +
      "Every update names the Version it is based on (`baseVersion`, the Document's `version`) and is refused if that is no " +
      "longer current; the refusal carries the current Version, so merge your change into it and update again. " +
      "Prefer `replace_section` to change one section: small edits rarely clash with anyone else's. " +
      "A Report is the Document of findings you write on a Ticket you hold the Claim on, with `write_report`; it stays with the Ticket, " +
      "out of the page tree, and you need one written during your current Claim before moving the Ticket to In Review. " +
      "You may update or replace_section a Report only while you hold its Ticket's Claim, and only a User may delete one.",
    parameters: {
      project: z.string().optional().describe("Project key, such as CRONK; leave out for the Workspace (tree, create)"),
      key: z.string().optional().describe("Ticket key, such as CRONK-12, of the Ticket you hold the Claim on (write_report)"),
      id: z.string().optional().describe("Document id, a Report's included (get, update, replace_section)"),
      parentId: z.string().optional().describe("The Document to create it under; at the top if left out (create)"),
      title: z.string().optional().describe("Title (create, update, write_report)"),
      body: z
        .string()
        .optional()
        .describe(
          "Markdown body; Ticket keys such as CRONK-12 become links (create, update, write_report). For replace_section, what goes under the heading, without the heading line",
        ),
      heading: z
        .string()
        .optional()
        .describe("The heading of the section to replace, such as `Setup`; prefix its # marks, such as `## Setup`, if several headings share the text (replace_section)"),
      baseVersion: z.number().int().optional().describe("The Version this change is based on (update, replace_section)"),
    },
    actions: {
      get: {
        description: "one Document with its Markdown body and current Version",
        writes: false,
        run: (api, a) => api("GET", `/api/documents/${encodeURIComponent(required(a.id, "an id", "get"))}`),
      },
      tree: {
        description: "a Project's (or the Workspace's) page tree, depth first, each Document with its depth",
        writes: false,
        run: (api, a) => api("GET", `${treePath(a.project)}/documents`),
      },
      create: {
        description: "a new Document at Version 1, last among its siblings",
        writes: true,
        run: (api, a) =>
          api("POST", `${treePath(a.project)}/documents`, {
            title: required(a.title, "a title", "create"),
            ...(a.body !== undefined && { body: a.body }),
            ...(a.parentId !== undefined && { parentId: a.parentId }),
          }),
      },
      update: {
        description: "saves a new Version with a new title and/or body",
        writes: true,
        run: (api, a) =>
          api("PATCH", `/api/documents/${encodeURIComponent(required(a.id, "an id", "update"))}`, {
            baseVersion: required(a.baseVersion, "a baseVersion", "update"),
            ...(a.title !== undefined && { title: a.title }),
            ...(a.body !== undefined && { body: a.body }),
          }),
      },
      replace_section: {
        description:
          "saves a new Version replacing what sits under one heading, its subsections included, down to the next heading " +
          "of the same or a higher level; the heading stays. Refused, listing the headings, if none or several match, and refused " +
          "if the body holds a heading of the section's level or higher or leaves a code block open",
        writes: true,
        run: (api, a) =>
          api("POST", `/api/documents/${encodeURIComponent(required(a.id, "an id", "replace_section"))}/replace-section`, {
            baseVersion: required(a.baseVersion, "a baseVersion", "replace_section"),
            heading: required(a.heading, "a heading", "replace_section"),
            body: required(a.body, "a body", "replace_section"),
          }),
      },
      write_report: {
        description:
          "write a Report of your findings on a Ticket you hold the Claim on: a new Document at Version 1, kept with the Ticket. " +
          "A Ticket may have several; moving it to In Review needs one written during your current Claim",
        writes: true,
        run: (api, a) =>
          api("POST", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "write_report"))}/reports`, {
            title: required(a.title, "a title", "write_report"),
            body: required(a.body, "a body", "write_report"),
          }),
      },
    },
  });

  registerGroupedTool(server, ctx, {
    name: "guidance",
    description:
      "Guidance: standing instructions Users wrote for Agents, as Markdown. The Workspace's applies everywhere; " +
      "a Project's layers on top of it when you work in that Project.",
    parameters: {
      project: z.string().optional().describe("Project key, such as CRONK, for that Project's Guidance; leave out for the Workspace's"),
    },
    actions: {
      get: {
        description: "the current Guidance of the Workspace, or of a Project",
        writes: false,
        run: (api, a) => api("GET", a.project ? `/api/projects/${encodeURIComponent(a.project)}/guidance` : "/api/workspace/guidance"),
      },
    },
  });
}

/** Where the Comments on the Ticket `key` or the Document `documentId` live; exactly one must be given. */
function commentsPath(a: { key?: string | undefined; documentId?: string | undefined }, action: string): string {
  if ((a.key === undefined) === (a.documentId === undefined)) throw new ToolError(`The ${action} action needs a key or a documentId`);
  return a.key !== undefined ? `/api/tickets/${encodeURIComponent(a.key)}/comments` : `/api/documents/${encodeURIComponent(a.documentId!)}/comments`;
}

/** Where a page tree's API lives: a Project's, or the Workspace's when no Project is named. */
const treePath = (project: string | undefined) => (project === undefined ? "/api/workspace" : `/api/projects/${encodeURIComponent(project)}`);
