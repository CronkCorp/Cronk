import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ACTIVITY_KINDS, DECISION_STATUSES, MENTION_SYNTAX, PRIORITIES, RELATION_KINDS, SEARCH_KINDS, STATUS_CATEGORIES } from "../../shared/values.js";
import type { AvoidedWord } from "../api-types.js";
import type { ApiCall, ApiResponse, Caller } from "./api.js";
import { namedSession } from "./welcome.js";

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
  registerCronkTool(server, ctx, tool.name, `${tool.description}\n\nActions:\n${actionList}`, inputSchema, (api, input) => {
    const { action, ...args } = input as { action: string };
    return tool.actions[action]!.run(api, args as z.infer<z.ZodObject<Shape>>);
  });
}

/**
 * Registers one of Cronk's tools: `run` maps its input onto the API, called as the Agent within its
 * Agent Session. Every result, errors included, starts with that Session's id, which is how a
 * Transcript is linked to the Session (ADR 0013).
 */
function registerCronkTool<Schema extends z.ZodObject<z.ZodRawShape>>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  description: string,
  inputSchema: Schema,
  run: (api: ApiCall, input: z.infer<Schema>) => Promise<ApiResponse> | ApiResponse,
): void {
  server.registerTool(name, { description, inputSchema: inputSchema as z.ZodObject<z.ZodRawShape> }, async (input, extra) => {
    let result: CallToolResult;
    try {
      const api = ctx.api({ token: extra.authInfo!.token, sessionId: extra.sessionId });
      result = toResult(await run(api, input as z.infer<Schema>));
    } catch (err) {
      // A ToolError, or a fault in the tool itself: either way an error result, so it names the Session too.
      result = error(err instanceof Error ? err.message : String(err));
    }
    return { ...result, content: [{ type: "text", text: namedSession(extra.sessionId!) }, ...result.content] };
  });
}

/** A tool call the Agent got wrong, such as a missing parameter, answered as a tool error with this message for the Agent to act on. */
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
  const hint = avoidedWordsHint(res.body?.avoidedWords);
  return { content: [{ type: "text", text: JSON.stringify(res.body ?? {}) }, ...(hint ? [{ type: "text" as const, text: hint }] : [])] };
}

/** A save's words a Term says to avoid, one per line with where it is and the Term to use; none for a save without any. */
function avoidedWordsHint(words: AvoidedWord[] | undefined): string | null {
  if (!words || words.length === 0) return null;
  const lines = words.map((w) => `- "${w.word}" (${w.field}, line ${w.line}, column ${w.column}): use ${w.term.name}`);
  return ["Saved, but it uses words a Term says to avoid:", ...lines].join("\n");
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
      key: z.string().optional().describe("Ticket key, such as CRONK-12 (get, claim, release, move, create_sub_ticket, edit, relate, unrelate)"),
      to: z.string().optional().describe("The Status to move into, by name or id (move)"),
      title: z.string().optional().describe("The new Sub-Ticket's title (create_sub_ticket), or the Ticket's new title (edit)"),
      description: z.string().optional().describe("The new Sub-Ticket's Markdown description (create_sub_ticket), or the Ticket's new one (edit)"),
      labels: z.array(z.string()).optional().describe("The Ticket's new Labels, replacing all of its current ones (edit)"),
      parent: z.string().optional().describe("The key of the Ticket's new parent in the same Project, or `none` to make it a top-level Ticket (edit)"),
      relation: z.enum(RELATION_KINDS).optional().describe("How the Ticket relates to the other, read from the Ticket's side (relate, unrelate)"),
      other: z.string().optional().describe("The other Ticket's key, such as CRONK-7 (relate, unrelate)"),
      status: z.array(z.string()).optional().describe("Only Tickets in one of these Status ids (list)"),
      category: z.array(z.enum(STATUS_CATEGORIES)).optional().describe("Only Tickets whose Status is in one of these Status Categories (list)"),
      priority: z
        .union([z.enum(PRIORITIES), z.array(z.enum(PRIORITIES))])
        .optional()
        .describe("The Ticket's new Priority (edit), or only Tickets with one of these Priorities (list)"),
      label: z.array(z.string()).optional().describe("Only Tickets with one of these Labels, ignoring case (list)"),
      assignee: z.array(z.string()).optional().describe("Only Tickets assigned to one of these User ids, or `none` for unassigned (list)"),
      delegate: z.array(z.string()).optional().describe("Only Tickets delegated to one of these Agent ids, or `none` for undelegated (list)"),
    },
    actions: {
      list: {
        description: "a Project's Tickets in key order, optionally filtered",
        writes: false,
        run: (api, a) => {
          const project = required(a.project, "a project", "list");
          const priority = typeof a.priority === "string" ? [a.priority] : a.priority;
          const filters = query({ status: a.status, category: a.category, priority, label: a.label, assignee: a.assignee, delegate: a.delegate });
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
          "move a Ticket you hold the Claim on into another Status: Unstarted, Started or In Review, or Completed when the Ticket is `autonomous` (Autonomous Delegation); " +
          "In Review and Completed need a Report written during your current Claim (documents, write_report). A completion stays Unverified until a User Accepts it",
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
      edit: {
        description: "change the title, description, priority, labels or parent of a Ticket you hold the Claim on; fields left out stay as they are",
        writes: true,
        run: (api, a) => {
          const key = required(a.key, "a key", "edit");
          if (Array.isArray(a.priority)) throw new ToolError("The edit action takes one priority, not a list");
          return api("PATCH", `/api/tickets/${encodeURIComponent(key)}`, {
            ...(a.title !== undefined && { title: a.title }),
            ...(a.description !== undefined && { description: a.description }),
            ...(a.priority !== undefined && { priority: a.priority }),
            ...(a.labels !== undefined && { labels: a.labels }),
            ...(a.parent !== undefined && { parentKey: a.parent.trim().toLowerCase() === "none" ? null : a.parent }),
          });
        },
      },
      relate: {
        description: "add a Relation from a Ticket you hold the Claim on to another: it blocks, is blocked_by or relates_to the other",
        writes: true,
        run: (api, a) =>
          api("POST", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "relate"))}/relations`, {
            kind: required(a.relation, "a Relation", "relate"),
            ticketKey: required(a.other, "an other Ticket", "relate"),
          }),
      },
      unrelate: {
        description: "remove a Relation from a Ticket you hold the Claim on",
        writes: true,
        run: (api, a) => {
          const key = required(a.key, "a key", "unrelate");
          const kind = required(a.relation, "a Relation", "unrelate");
          const other = required(a.other, "an other Ticket", "unrelate");
          return api("DELETE", `/api/tickets/${encodeURIComponent(key)}/relations/${kind}/${encodeURIComponent(other)}`);
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
        description: "ask a question on a Ticket you hold the Claim on; blocking if you wait for the answer, except on an `autonomous` Ticket, where questions never block",
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
      `in your welcome. ${MENTION_SYNTAX}`,
    parameters: {
      key: z.string().optional().describe("Ticket key, such as CRONK-12, for its Comments (list, post)"),
      documentId: z.string().optional().describe("Document id, for its Comments, instead of a key (list, post)"),
      body: z.string().optional().describe("Markdown text of the Comment; @name, @owner/name or @\"quoted name\" mentions an Agent (post)"),
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
      "You may update or replace_section a Report only while you hold its Ticket's Claim. You can't delete any Document, a Report or not: a User decides.",
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
        run: (api, a) => api("GET", `${scopePath(a.project)}/documents`),
      },
      create: {
        description: "a new Document at Version 1, last among its siblings",
        writes: true,
        run: (api, a) =>
          api("POST", `${scopePath(a.project)}/documents`, {
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

  registerGroupedTool(server, ctx, {
    name: "decisions",
    description:
      "Decisions: recorded choices with their reasoning, belonging to a Project or, without a project, the Workspace, keyed like " +
      "CRONK-D7 (D7 in the Workspace). Each has a status: proposed, accepted, rejected, deprecated, or superseded by a newer accepted " +
      "Decision, which `supersededBy` names. Follow accepted Decisions; only Users change a Decision's status.",
    parameters: {
      project: z.string().optional().describe("Project key, such as CRONK; leave out for the Workspace's Decisions (list)"),
      key: z.string().optional().describe("Decision key, such as CRONK-D7 or D7 (get, mentions)"),
      status: z.array(z.enum(DECISION_STATUSES)).optional().describe("Only Decisions with one of these statuses (list)"),
      group: z.array(z.string()).optional().describe("Only Decisions in one of these groups, ignoring case (list)"),
    },
    actions: {
      list: {
        description: "a Project's (or the Workspace's) Decisions, newest first, without their bodies, optionally filtered",
        writes: false,
        run: (api, a) => api("GET", `${scopePath(a.project)}/decisions${query({ status: a.status, group: a.group })}`),
      },
      get: {
        description: "one Decision with its Markdown body, what it supersedes and what superseded it",
        writes: false,
        run: (api, a) => api("GET", `/api/decisions/${encodeURIComponent(required(a.key, "a key", "get"))}`),
      },
      mentions: {
        description: "what names a Decision's key: Tickets, Documents, Comments, Terms and Decisions, most recently changed first",
        writes: false,
        run: (api, a) => api("GET", `/api/decisions/${encodeURIComponent(required(a.key, "a key", "mentions"))}/mentions`),
      },
    },
  });

  registerGroupedTool(server, ctx, {
    name: "terms",
    description:
      "Terms: the glossary. Each names one concept with its definition and the words to avoid for it; use the name and avoid those words. " +
      "The Workspace's apply everywhere; within a Project, a Project Term replaces the Workspace Term of the same name, ignoring case. " +
      "Saving text that uses a word to avoid, outside code and quotes, still goes through: the result lists each such word with the Term to use, as `avoidedWords`.",
    parameters: {
      project: z.string().optional().describe("Project key, such as CRONK, for the Terms that apply in it; leave out for the Workspace's (list, get by name)"),
      name: z.string().optional().describe("The Term's name, ignoring case (get)"),
      id: z.string().optional().describe("The Term's id (mentions; or get, instead of a name)"),
    },
    actions: {
      list: {
        description: "the Terms that apply in a Project, or the Workspace's, by name, with their definitions",
        writes: false,
        run: (api, a) => api("GET", `${scopePath(a.project)}/terms`),
      },
      get: {
        description: "one Term by name, as it applies in a Project or the Workspace, or by id",
        writes: false,
        run: async (api, a) => {
          if (a.id !== undefined) return api("GET", `/api/terms/${encodeURIComponent(a.id)}`);
          if (a.name === undefined) throw new ToolError("The get action needs a name or an id");
          const found = await api("GET", `${scopePath(a.project)}/terms${query({ name: [a.name] })}`);
          if (found.status >= 400) return found;
          const [term] = found.body.terms as unknown[];
          if (!term) throw new ToolError(`No Term named ${a.name.trim()} applies in ${a.project?.toUpperCase() ?? "the Workspace"}`);
          return { status: 200, body: { term } };
        },
      },
      mentions: {
        description: "what names a Term with its capitalisation where it applies: Tickets, Documents, Comments, other Terms and Decisions, most recently changed first",
        writes: false,
        run: (api, a) => api("GET", `/api/terms/${encodeURIComponent(required(a.id, "an id", "mentions"))}/mentions`),
      },
    },
  });

  registerSearchTool(server, ctx);
}

/** Registers the `search` tool: one operation, so it takes no `action`. It only reads, so every token is offered it. */
function registerSearchTool(server: McpServer, ctx: ToolContext): void {
  const inputSchema = z.object({
    query: z.string().describe('What to look for, as typed into a search box: words, "quoted phrases", and -words to leave out'),
    kind: z.array(z.enum(SEARCH_KINDS)).optional().describe("Only these kinds: ticket, document (in a page tree), report, comment"),
    project: z.array(z.string()).optional().describe("Only in these Projects, by key such as CRONK; leaves out the Workspace outside any Project"),
    limit: z.number().int().optional().describe("At most this many results, up to 100; 20 if left out"),
  });
  registerCronkTool(
    server,
    ctx,
    "search",
    "Full-text search across the Tickets, Documents, Reports and Comments you may read, best match first, each result with an " +
      "excerpt around the match. Get a result with the tickets or documents tool by its ticketKey or documentId.",
    inputSchema,
    (api, { query: q, kind, project, limit }) =>
      api("GET", `/api/search${query({ q: [q], kind, project, limit: limit === undefined ? undefined : [String(limit)] })}`),
  );
}

/** Where the Comments on the Ticket `key` or the Document `documentId` live; exactly one must be given. */
function commentsPath(a: { key?: string | undefined; documentId?: string | undefined }, action: string): string {
  if ((a.key === undefined) === (a.documentId === undefined)) throw new ToolError(`The ${action} action needs a key or a documentId`);
  return a.key !== undefined ? `/api/tickets/${encodeURIComponent(a.key)}/comments` : `/api/documents/${encodeURIComponent(a.documentId!)}/comments`;
}

/** Where a Project's API lives, for its page tree or Decisions, or the Workspace's when no Project is named. */
const scopePath = (project: string | undefined) => (project === undefined ? "/api/workspace" : `/api/projects/${encodeURIComponent(project)}`);
