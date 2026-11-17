import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ACTIVITY_KINDS, DECISION_STATUSES, EXTRA_ORIGIN_USES, MENTION_SYNTAX, PRIORITIES, RELATION_KINDS, SEARCH_KINDS, STATUS_CATEGORIES } from "../../shared/values.js";
import type { AvoidedWord, Transcript, Welcome } from "../api-types.js";
import { turnsOf } from "../../shared/transcript-turns.js";
import { LINKED_KIND_NAMES, LINKED_KINDS } from "../../shared/from-transcript.js";
import { formatBytes } from "../files/sizes.js";
import { FileBody, type ApiCall, type ApiResponse, type Caller } from "./api.js";
import { namedSession } from "./welcome.js";
import { packFolder, type Folder } from "../portability/archive.js";

/** What the tools need: whether the token is read-only, and a way to call the API as the Agent, within its Session. */
export interface ToolContext {
  readOnly: boolean;
  api: (caller: Caller) => ApiCall;
  /** What an Artifact may load and hold in the Workspace when the Agent Session started, which the artifacts tool describes. */
  artifacts: Welcome["artifacts"];
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

/** The one group a Decision is filed under, as `propose` and `update` take it: empty for none. */
function singleGroup(group: string | string[] | undefined, action: string): string | null | undefined {
  if (Array.isArray(group)) throw new ToolError(`The ${action} action takes one group, as text`);
  return group === undefined ? undefined : group.trim() === "" ? null : group;
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
    description:
      "Tickets: the units of work tracked in a Project, keyed like CRONK-12. When you notice work outside the Ticket you are on, or while on none, " +
      "file it as a Discovered Ticket: it waits in Backlog for a User, who delegates, keeps or cancels it. You may edit your own Discovered Tickets " +
      "until a User delegates them, but not work on them. If other work shouldn't build on what you found, have your Discovered Ticket block it, saying why.",
    parameters: {
      project: z.string().optional().describe("Project key, such as CRONK (list, file)"),
      key: z.string().optional().describe("Ticket key, such as CRONK-12 (get, claim, release, move, create_sub_ticket, edit, relate, unrelate)"),
      to: z.string().optional().describe("The Status to move into, by name or id (move)"),
      title: z.string().optional().describe("The new Sub-Ticket's or Discovered Ticket's title (create_sub_ticket, file), or the Ticket's new title (edit)"),
      description: z.string().optional().describe("The new Sub-Ticket's or Discovered Ticket's Markdown description (create_sub_ticket, file), or the Ticket's new one (edit)"),
      source: z
        .string()
        .optional()
        .describe("The key of the Ticket, of any Project, you hold the Claim on that you found it while working on; needed only when you hold more than one Claim (file)"),
      labels: z.array(z.string()).optional().describe("The Ticket's new Labels, replacing all of its current ones (edit)"),
      parent: z.string().optional().describe("The key of the Ticket's new parent in the same Project, or `none` to make it a top-level Ticket (edit)"),
      relation: z.enum(RELATION_KINDS).optional().describe("How the Ticket relates to the other, read from the Ticket's side (relate, unrelate)"),
      other: z.string().optional().describe("The other Ticket's key, such as CRONK-7 (relate, unrelate)"),
      blocks: z.array(z.string()).optional().describe("Keys of Tickets of any Project you can read that your Discovered Ticket blocks from the start (file)"),
      reason: z
        .string()
        .optional()
        .describe("Why your Discovered Ticket blocks those Tickets, which each blocked Ticket shows; needed with `blocks` (file) and to block from it without a Claim (relate)"),
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
      file: {
        description:
          "file a Discovered Ticket in a Project, needing no Claim: it goes to Backlog, undelegated, for the Assignee of the Ticket you hold the Claim on, " +
          "or else your Owner, and that Ticket's Reports from this Claim list it; with `blocks` and a `reason`, it blocks those Tickets until finished or a User removes the block",
        writes: true,
        run: (api, a) => {
          const project = required(a.project, "a project", "file");
          const title = required(a.title, "a title", "file");
          const reason = a.blocks?.length ? required(a.reason, "a reason for its blocks", "file") : undefined;
          return api("POST", `/api/projects/${encodeURIComponent(project)}/tickets`, {
            title,
            ...(a.description !== undefined && { description: a.description }),
            ...(a.source !== undefined && { ticket: a.source }),
            ...(reason !== undefined && { blocks: a.blocks!.map((ticketKey) => ({ ticketKey, reason })) }),
          });
        },
      },
      edit: {
        description:
          "change the title, description, priority, labels or parent of a Ticket you hold the Claim on, or of your own Discovered Ticket no User has delegated or finished yet; fields left out stay as they are",
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
        description:
          "add a Relation from a Ticket you hold the Claim on to another: it blocks, is blocked_by or relates_to the other; " +
          "or, with a `reason`, have your own Discovered Ticket no User has delegated or finished yet block any Ticket you can read",
        writes: true,
        run: (api, a) =>
          api("POST", `/api/tickets/${encodeURIComponent(required(a.key, "a key", "relate"))}/relations`, {
            kind: required(a.relation, "a Relation", "relate"),
            ticketKey: required(a.other, "an other Ticket", "relate"),
            ...(a.reason !== undefined && { reason: a.reason }),
          }),
      },
      unrelate: {
        description: "remove a Relation from a Ticket you hold the Claim on, or a block from your own Discovered Ticket no User has delegated or finished yet",
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
      "Comments: conversation any User or Agent posts on a Ticket, a Document or an Artifact, kept apart from Activities. Reply to a Comment " +
      "to thread under it. A User answers your question by replying to its Activity. On a Document, a Comment can anchor to a " +
      "passage it is about; on an Artifact, it records the Version it is on. Comments that @mention you, answer your questions, " +
      "land on Tickets delegated to you or on Artifact Versions you published wait for you " +
      `in your welcome. ${MENTION_SYNTAX}`,
    parameters: {
      key: z.string().optional().describe("Ticket key, such as CRONK-12, for its Comments (list, post)"),
      documentId: z.string().optional().describe("Document id, for its Comments, instead of a key (list, post)"),
      artifactId: z.string().optional().describe("Artifact id, for its Comments on all its Versions, instead of a key (list, post)"),
      version: z.number().int().optional().describe("On an Artifact: the number of the Version the Comment is about; the latest if left out (post)"),
      body: z.string().optional().describe("Markdown text of the Comment; @name, @owner/name or @\"quoted name\" mentions an Agent (post)"),
      replyToCommentId: z.string().optional().describe("The Comment to reply to, on the same Ticket, Document or Artifact (post)"),
      replyToActivityId: z.string().optional().describe("The Activity on the same Ticket to reply to (post)"),
      passage: z.string().optional().describe("On a Document: the exact text of its current Version the Comment is about (post)"),
    },
    actions: {
      list: {
        description: "the Comments on a Ticket, a Document or an Artifact, oldest first",
        writes: false,
        run: (api, a) => api("GET", commentsPath(a, "list")),
      },
      post: {
        description: "post a Comment on a Ticket, a Document or an Artifact Version, optionally replying to a Comment or an Activity",
        writes: true,
        run: (api, a) =>
          api("POST", commentsPath(a, "post"), {
            body: required(a.body, "a body", "post"),
            ...(a.replyToCommentId !== undefined && { replyToCommentId: a.replyToCommentId }),
            ...(a.replyToActivityId !== undefined && { replyToActivityId: a.replyToActivityId }),
            ...(a.passage !== undefined && { anchor: { passage: a.passage } }),
            ...(a.version !== undefined && { version: a.version }),
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
      "You may update or replace_section a Report only while you hold its Ticket's Claim. You can't delete any Document, a Report or not: a User decides. " +
      "Move a Document within its page tree with `move`. " +
      "A Document with `protected` true, marked itself or sitting under a marked one (`protectedBy`), you may read and comment on but not change, " +
      "move, or create Documents under. Propose a change to it, or a new Document under it, with the `suggestions` tool instead. " +
      "A Suggestion can't carry a move: to move it, a Document with one under it, or a Document into or out of a protected branch, ask a User to make the move instead, " +
      "in a Comment on the Document you are moving with the `comments` tool, saying where it should go and why.",
    parameters: {
      project: z.string().optional().describe("Project key, such as CRONK; leave out for the Workspace (tree, create)"),
      key: z.string().optional().describe("Ticket key, such as CRONK-12, of the Ticket you hold the Claim on (write_report)"),
      id: z.string().optional().describe("Document id, a Report's included (get, update, replace_section); a Document in the page tree (move)"),
      parentId: z
        .string()
        .nullable()
        .optional()
        .describe("The Document to create it under (create) or move it under (move), in the same page tree; at the top if null or left out"),
      position: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Its place among its new siblings, counted from 0; last if left out (move)"),
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
            ...(a.parentId != null && { parentId: a.parentId }),
          }),
      },
      move: {
        description: "moves a Document to another place in its page tree, under another Document or at the top, keeping its Version",
        writes: true,
        run: (api, a) =>
          api("POST", `/api/documents/${encodeURIComponent(required(a.id, "an id", "move"))}/move`, {
            parentId: a.parentId ?? null,
            ...(a.position !== undefined && { position: a.position }),
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
      "Decision, which `supersededBy` names. Follow accepted Decisions; only Users change a Decision's status. When you make a choice " +
      "worth keeping, propose a Decision: a User reviews it (the Assignee of the Ticket you hold the Claim on, or else your Owner) and " +
      "accepts or rejects it; a rejection reaches you as waiting work, with the reason. You may update your proposal while it is " +
      "proposed, unless a User marked it `protected`; an accepted Decision is Protected, so propose a change to it with the `suggestions` tool. Saving text that uses a word a Term says to " +
      "avoid still goes through: the result lists each such word with the Term to use, as `avoidedWords`.",
    parameters: {
      project: z.string().optional().describe("Project key, such as CRONK; leave out for the Workspace's Decisions (list, propose)"),
      key: z.string().optional().describe("Decision key, such as CRONK-D7 or D7 (get, mentions, update)"),
      status: z.array(z.enum(DECISION_STATUSES)).optional().describe("Only Decisions with one of these statuses (list)"),
      group: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Only Decisions in one of these groups, ignoring case (list); or the group to file it under, empty for none (propose, update)"),
      title: z.string().optional().describe("The Decision's title (propose), or its new one (update)"),
      body: z
        .string()
        .optional()
        .describe("Markdown: what was decided and why, its Consequences and the Considered Options (propose; left out, those sections to fill in), or its new body (update)"),
      supersedes: z.array(z.string()).optional().describe("Keys of the Decisions of the same Project or Workspace it replaces once accepted (propose, update)"),
      ticket: z
        .string()
        .optional()
        .describe("The key of the Ticket you hold the Claim on that it came from; needed only when you hold more than one Claim (propose)"),
      baseVersion: z.number().int().optional().describe("The Decision's `version` you are editing from; refused if it is no longer current (update)"),
    },
    actions: {
      list: {
        description: "a Project's (or the Workspace's) Decisions, newest first, without their bodies, optionally filtered",
        writes: false,
        run: (api, a) => api("GET", `${scopePath(a.project)}/decisions${query({ status: a.status, group: typeof a.group === "string" ? [a.group] : a.group })}`),
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
      propose: {
        description: "record a new Decision in a Project (or the Workspace), as proposed, for a User to accept or reject",
        writes: true,
        run: (api, a) =>
          api("POST", `${scopePath(a.project)}/decisions`, {
            title: required(a.title, "a title", "propose"),
            body: a.body,
            group: singleGroup(a.group, "propose"),
            supersedes: a.supersedes,
            ticket: a.ticket,
          }),
      },
      update: {
        description: "edit a Decision while it is still proposed: its title, body, group or what it supersedes; give only what changes",
        writes: true,
        run: (api, a) =>
          api("PATCH", `/api/decisions/${encodeURIComponent(required(a.key, "a key", "update"))}`, {
            baseVersion: required(a.baseVersion, "a baseVersion", "update"),
            title: a.title,
            body: a.body,
            group: singleGroup(a.group, "update"),
            supersedes: a.supersedes,
          }),
      },
    },
  });

  registerGroupedTool(server, ctx, {
    name: "suggestions",
    description:
      "Suggestions: how you propose a change to an item you may not change yourself: a Protected Document, Term or Decision (an accepted Decision is " +
      "Protected), or Guidance, which only Users write. Send the item's new content based on the Version you read (`baseVersion`, the item's `version`; " +
      "Guidance at 0 when nobody has written it) with your reasoning; fields you leave out keep what that Version holds. A User reviews it (the Assignee " +
      "of the Ticket you hold the Claim on, or else your Owner; a Workspace item goes to Triage) and accepts it as is, credited to you, edits and accepts " +
      "it, credited to them, or rejects it with a reason, which reaches you as waiting work. Check where yours stand with `list`. " +
      "To add a Document under a protected branch, suggest the new Document: kind `document`, the Document it goes under as `parentId`, `baseVersion` 0, " +
      "and its `title` and `body`; accepting it creates the Document there.",
    parameters: {
      kind: z.enum(["document", "term", "decision", "guidance"]).optional().describe("What kind of item to change (create)"),
      itemId: z.string().optional().describe("The Document's or Term's id (create)"),
      parentId: z.string().optional().describe("For a new Document, instead of an itemId: the Document under the protected branch it goes under (create)"),
      key: z.string().optional().describe("The Decision's key, such as CRONK-D7 (create)"),
      project: z.string().optional().describe("For Guidance, the Project key whose Guidance to change; leave out for the Workspace's (create)"),
      baseVersion: z.number().int().optional().describe("The item's `version` you read and are changing; 0 for a new Document (create)"),
      title: z.string().optional().describe("A Document's or Decision's new title (create)"),
      body: z.string().optional().describe("A Document's or Decision's new Markdown body (create)"),
      name: z.string().optional().describe("A Term's new name (create)"),
      definition: z.string().optional().describe("A Term's new definition, in Markdown (create)"),
      avoid: z.array(z.string()).optional().describe("A Term's new words to avoid (create)"),
      group: z.string().nullable().optional().describe("A Term's or Decision's new group; null for none (create)"),
      markdown: z.string().optional().describe("Guidance's new Markdown (create)"),
      reasoning: z.string().optional().describe("Why the change, in Markdown, for the User who reviews it (create)"),
      ticket: z
        .string()
        .optional()
        .describe("The key of the Ticket you hold the Claim on that it came from; needed only when you hold more than one Claim (create)"),
      state: z.array(z.enum(["open", "accepted", "rejected"])).optional().describe("Only your Suggestions in these states (list)"),
      id: z.string().optional().describe("The Suggestion's id (get)"),
    },
    actions: {
      create: {
        description: "suggest a new Version of a Protected Document, Term or Decision, or of Guidance, or a new Document under a protected branch",
        writes: true,
        run: (api, a) => {
          const kind = required(a.kind, "a kind", "create");
          if (a.itemId !== undefined && a.parentId !== undefined) {
            throw new ToolError("The create action takes an itemId to change a Document, or a parentId to suggest a new one, not both");
          }
          const item =
            kind === "decision"
              ? { kind, key: required(a.key, "a key for a Decision", "create") }
              : kind === "guidance"
                ? { kind, project: a.project ?? null }
                : kind === "document" && a.itemId === undefined
                  ? { kind, parentId: required(a.parentId, "an itemId for a Document, or a parentId for a new one", "create") }
                  : { kind, id: required(a.itemId, `an itemId for a ${kind === "document" ? "Document" : "Term"}`, "create") };
          const fields = { title: a.title, body: a.body, name: a.name, definition: a.definition, avoid: a.avoid, group: a.group, markdown: a.markdown };
          const content = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
          return api("POST", "/api/suggestions", {
            item,
            baseVersion: required(a.baseVersion, "a baseVersion", "create"),
            content,
            reasoning: required(a.reasoning, "reasoning", "create"),
            ticket: a.ticket,
          });
        },
      },
      list: {
        description: "your own Suggestions, newest first, with where each stands: open, accepted (and the Version it made) or rejected (and why)",
        writes: false,
        run: (api, a) => api("GET", `/api/suggestions${query({ state: a.state })}`),
      },
      get: {
        description: "one Suggestion, with its item as it stands now",
        writes: false,
        run: (api, a) => api("GET", `/api/suggestions/${encodeURIComponent(required(a.id, "an id", "get"))}`),
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

  registerGroupedTool(server, ctx, {
    name: "attachments",
    description:
      "Attachments: plain files on a Ticket, a Document or Report, or a Comment, such as screenshots, recordings, logs or PDFs, kept as " +
      "evidence with the work. Whoever can read the item can read them, and listing a Ticket's includes those in its Comments and Reports. " +
      "Attach one to a Ticket you hold the Claim on or your own undelegated Discovered Ticket, a Document that isn't Protected (a Report only while holding its Ticket's Claim), or " +
      "a Comment you posted, as text (`content`) or as base64 (`contentBase64`) for anything else; each may be as large as the Workspace " +
      "allows (100 MB unless an Admin changed it), and at most 100 MB through this tool. For a larger file, POST it to " +
      "/api/tickets/{key}/attachments, /api/documents/{id}/attachments or /api/comments/{id}/attachments with ?name=<name> over the HTTP API. " +
      "To show an image in a Document, put ![name](/api/attachments/{id}/file) in its Markdown; every Version keeps showing it.",
    parameters: {
      key: z.string().optional().describe("Ticket key, such as CRONK-12 (attach, list)"),
      documentId: z.string().optional().describe("Document or Report id, instead of a key (attach, list)"),
      commentId: z.string().optional().describe("The id of a Comment you posted, instead of a key (attach)"),
      name: z.string().optional().describe("The file's name, such as sign-in-flood.log or proxy-ip.png (attach)"),
      content: z.string().optional().describe("The file's text, stored as UTF-8 (attach)"),
      contentBase64: z.string().optional().describe("The file's bytes as base64, instead of content (attach)"),
      contentType: z
        .string()
        .optional()
        .describe("The file's media type, such as image/png; text/plain for content and application/octet-stream for contentBase64 if left out (attach)"),
    },
    actions: {
      list: {
        description:
          "a Ticket's or Document's Attachments, those in its Comments (and a Ticket's Reports) included, in the order they were attached; " +
          "download one at GET /api/attachments/{id}/file",
        writes: false,
        run: (api, a) => {
          if (a.commentId !== undefined || (a.key === undefined) === (a.documentId === undefined)) throw new ToolError("The list action needs a key or a documentId");
          return api("GET", attachmentsPath(a, "list"));
        },
      },
      attach: {
        description: "attach a file to a Ticket you hold the Claim on or your own undelegated Discovered Ticket, a Document or Report, or a Comment you posted",
        writes: true,
        run: (api, a) => {
          const path = attachmentsPath(a, "attach");
          const name = required(a.name, "a name", "attach");
          if ((a.content === undefined) === (a.contentBase64 === undefined)) throw new ToolError("The attach action needs either content or contentBase64, not both");
          const file =
            a.content !== undefined
              ? new FileBody(Buffer.from(a.content, "utf8"), a.contentType ?? "text/plain")
              : new FileBody(Buffer.from(a.contentBase64!, "base64"), a.contentType ?? "application/octet-stream");
          return api("POST", `${path}?name=${encodeURIComponent(name)}`, file);
        },
      },
    },
  });

  registerGroupedTool(server, ctx, {
    name: "artifacts",
    description:
      "Artifacts: things you build to be seen, such as an HTML prototype, a dashboard or a report page, published as a folder of files with " +
      "`index.html` at its top. Each belongs to a Project or, without a project, the Workspace, and records the Ticket whose Claim you held. " +
      "Every publish is the whole folder again, as a new Version; publishing a new Version names the Version you based it on (`baseVersion`, " +
      "the Artifact's `version`) and is refused if a later one was published meanwhile, so merge with it first. `url` always shows the latest " +
      "Version and `versionUrl` the one just published. An address alone on a line of a Report, Document or Comment embeds the Artifact there; " +
      "in a Report, embed `versionUrl`, so the evidence stays as reviewed (the publish answer says so in `embedding`). " +
      artifactRules(ctx.artifacts) +
      " You can't publish a new Version of an Artifact a User marked `protected`.",
    parameters: {
      project: z.string().optional().describe("Project key, such as CRONK; leave out for the Workspace (list, publish a new Artifact)"),
      id: z.string().optional().describe("The Artifact's id (get; publish, for a new Version of it)"),
      title: z.string().optional().describe("The Artifact's title (publish a new Artifact), or its new one (publish a new Version)"),
      files: z
        .array(
          z.object({
            path: z.string().describe("The file's path in the folder, such as index.html or js/app.js"),
            content: z.string().optional().describe("The file's text, stored as UTF-8"),
            contentBase64: z.string().optional().describe("The file's bytes as base64, instead of content, for an image or font"),
          }),
        )
        .optional()
        .describe("Every file of the folder, index.html among them (publish)"),
      baseVersion: z.number().int().optional().describe("The Version a new Version is based on: the Artifact's `version` when you read it (publish with an id)"),
      ticket: z
        .string()
        .optional()
        .describe("The key of the Ticket you hold the Claim on that it came from; needed only when you hold more than one Claim (publish)"),
      extraOrigins: z
        .array(
          z.object({
            origin: z.string().describe("A bare origin, such as https://cdn.plot.ly"),
            uses: z.array(z.enum(EXTRA_ORIGIN_USES)).describe("What the page loads from it; connect lets it send requests there"),
            reason: z.string().describe("Why the page needs it, shown to Users on the Artifact"),
          }),
        )
        .optional()
        .describe("Origins this Version needs beyond the allow-list, each with a reason; for this Version only, so declare them again on the next (publish)"),
    },
    actions: {
      list: {
        description: "a Project's (or the Workspace's) Artifacts, most recently published first",
        writes: false,
        run: (api, a) => api("GET", `${scopePath(a.project)}/artifacts`),
      },
      get: {
        description: "one Artifact with its Versions, newest first",
        writes: false,
        run: (api, a) => api("GET", `/api/artifacts/${encodeURIComponent(required(a.id, "an id", "get"))}`),
      },
      publish: {
        description: "publish a folder as a new Artifact in a Project (or the Workspace), or, given an id and baseVersion, as that Artifact's next Version",
        writes: true,
        run: async (api, a) => {
          const files = required(a.files, "files", "publish");
          const folder: Folder = new Map();
          for (const file of files) {
            if ((file.content === undefined) === (file.contentBase64 === undefined)) {
              throw new ToolError(`The publish action needs either content or contentBase64 for ${file.path}, not both`);
            }
            folder.set(file.path, file.content ?? Buffer.from(file.contentBase64!, "base64"));
          }
          const extraOrigins = a.extraOrigins && a.extraOrigins.length > 0 ? JSON.stringify(a.extraOrigins) : undefined;
          const query = (params: Record<string, string | undefined>) =>
            `?${new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString()}`;
          if (a.id === undefined) {
            const title = required(a.title, "a title", "publish");
            return api("POST", `${scopePath(a.project)}/artifacts${query({ title, ticket: a.ticket, extraOrigins })}`, new FileBody(await packFolder(folder), "application/gzip"));
          }
          const baseVersion = required(a.baseVersion, "a baseVersion with an id", "publish");
          return api(
            "POST",
            `/api/artifacts/${encodeURIComponent(a.id)}/versions${query({ baseVersion: String(baseVersion), title: a.title, ticket: a.ticket, extraOrigins })}`,
            new FileBody(await packFolder(folder), "application/gzip"),
          );
        },
      },
    },
  });

  registerGroupedTool(server, ctx, {
    name: "transcripts",
    description:
      "Transcripts: the chats that led Agents to change things, uploaded by their clients, each in turns (`## User` and `## Assistant`, numbered from 1). " +
      "Find them with the search tool, whose Transcript hits carry a transcriptId and the turn that matches.",
    parameters: {
      id: z.string().optional().describe("The Transcript's id, such as a search hit's transcriptId (get)"),
      turn: z.number().int().optional().describe("Only this turn of the Transcript, numbered from 1, such as a search hit's turn (get)"),
      kind: z.enum(LINKED_KIND_NAMES).optional().describe("What kind of item the Transcripts came from; a Report is a document (from)"),
      key: z.string().optional().describe("The Ticket's or Decision's key, such as CRONK-12 or CRONK-D3 (from)"),
      itemId: z.string().optional().describe("The Document's, Report's, Term's or Artifact's id (from)"),
    },
    actions: {
      get: {
        description: "one Transcript with its text; given a turn, only that turn's text, with the number of turns it has",
        writes: false,
        run: async (api, a) => {
          const read = await api("GET", `/api/transcripts/${encodeURIComponent(required(a.id, "an id", "get"))}`);
          if (read.status >= 400 || a.turn === undefined) return read;
          const { markdown, earlier: _earlier, ...transcript } = read.body.transcript as Transcript;
          const turns = turnsOf(markdown);
          const turn = turns.find((t) => t.n === a.turn);
          if (turns.length === 0) throw new ToolError("This Transcript has no turns");
          if (!turn) throw new ToolError(`This Transcript has turns 1 to ${turns.length}, so no turn ${a.turn}`);
          return { status: 200, body: { transcript: { ...transcript, turns: turns.length, turn } } };
        },
      },
      list: {
        description: "the Transcripts you may read, most recently uploaded first, without their text",
        writes: false,
        run: (api) => api("GET", "/api/transcripts"),
      },
      from: {
        description:
          "the Transcripts a Ticket, Document (or Report), Term, Decision or Artifact came from (\"From Transcript\"), most recently uploaded first, " +
          "each with the turn where the item first appears, or null for none",
        writes: false,
        run: (api, a) => {
          const { collection, by } = LINKED_KINDS[required(a.kind, "a kind", "from")];
          const item = by === "key" ? required(a.key, "a key", "from") : required(a.itemId, "an itemId", "from");
          return api("GET", `/api/${collection}/${encodeURIComponent(item)}/transcripts`);
        },
      },
    },
  });

  registerSearchTool(server, ctx);
}

/** What an Artifact's page may load and a Version may hold, as the artifacts tool tells it: the Workspace's settings in force. */
function artifactRules(rules: Welcome["artifacts"]): string {
  const allowed =
    rules.allowedOrigins.length > 0 ? `its own files and ${rules.allowedOrigins.join(", ")}` : "its own files (the Workspace allows no other origins)";
  const extras = rules.extraOriginsAllowed
    ? "If it truly needs another origin, such as a library from elsewhere or a data source it sends requests to, declare it in `extraOrigins` " +
      "with what it loads from there and why; Users see them on the Version, and they are never carried over, so declare them again on the next one. " +
      "Declare as few as you can."
    : "This Workspace doesn't allow extra origins, so a publish declaring `extraOrigins` is refused.";
  return (
    `The page runs sandboxed on a hostname of its own: it may load scripts, styles and fonts only from ${allowed}, and may make no network ` +
    `requests, so put its data in its files. ${extras} A Version may hold ${rules.maxFiles} files and ${formatBytes(rules.maxBytes)}.`
  );
}

/** Registers the `search` tool: one operation, so it takes no `action`. It only reads, so every token is offered it. */
function registerSearchTool(server: McpServer, ctx: ToolContext): void {
  const inputSchema = z.object({
    query: z.string().describe('What to look for, as typed into a search box: words, "quoted phrases", and -words to leave out'),
    kind: z.array(z.enum(SEARCH_KINDS)).optional().describe("Only these kinds: ticket, document (in a page tree), report, comment, term, decision, transcript"),
    project: z.array(z.string()).optional().describe("Only in these Projects, by key such as CRONK; leaves out the Workspace outside any Project"),
    limit: z.number().int().optional().describe("At most this many results, up to 100; 20 if left out"),
  });
  registerCronkTool(
    server,
    ctx,
    "search",
    "Full-text search across the Tickets, Documents, Reports, Comments (on Tickets, Documents and Artifacts), Terms and Decisions you may read, " +
      "best match first, each result with an excerpt around the match; a Term is found by its name, definition or words to avoid, a Decision of " +
      "any status by its title or body, and a Ticket or Decision key such as CRONK-12 or CRONK-D3 puts that one first. Get a result with the " +
      "tickets or documents tool by its ticketKey or documentId, a Comment's Artifact with the artifacts tool by its artifactId, a Term with " +
      "the terms tool by its termId, or a Decision with the decisions tool by its decisionKey. " +
      "Transcripts (the chats that led Agents to change things) are found too, after everything else, each by its transcriptId with the turn that matches; " +
      "read that turn with the transcripts tool's get action, giving it the transcriptId as id and the turn.",
    inputSchema,
    (api, { query: q, kind, project, limit }) =>
      api("GET", `/api/search${query({ q: [q], kind, project, limit: limit === undefined ? undefined : [String(limit)] })}`),
  );
}

/** Where the Comments on the Ticket `key`, the Document `documentId` or the Artifact `artifactId` live; exactly one must be given. */
function commentsPath(a: { key?: string | undefined; documentId?: string | undefined; artifactId?: string | undefined }, action: string): string {
  if ([a.key, a.documentId, a.artifactId].filter((v) => v !== undefined).length !== 1) {
    throw new ToolError(`The ${action} action needs one of key, documentId or artifactId`);
  }
  if (a.key !== undefined) return `/api/tickets/${encodeURIComponent(a.key)}/comments`;
  if (a.documentId !== undefined) return `/api/documents/${encodeURIComponent(a.documentId)}/comments`;
  return `/api/artifacts/${encodeURIComponent(a.artifactId!)}/comments`;
}

/** Where the Attachments of the one Ticket (`key`), Document or Comment the arguments name are. */
function attachmentsPath(a: { key?: string | undefined; documentId?: string | undefined; commentId?: string | undefined }, action: string): string {
  if ([a.key, a.documentId, a.commentId].filter((v) => v !== undefined).length !== 1) throw new ToolError(`The ${action} action needs one of key, documentId or commentId`);
  if (a.key !== undefined) return `/api/tickets/${encodeURIComponent(a.key)}/attachments`;
  if (a.documentId !== undefined) return `/api/documents/${encodeURIComponent(a.documentId)}/attachments`;
  return `/api/comments/${encodeURIComponent(a.commentId!)}/attachments`;
}


/** Where a Project's API lives, for its page tree or Decisions, or the Workspace's when no Project is named. */
const scopePath = (project: string | undefined) => (project === undefined ? "/api/workspace" : `/api/projects/${encodeURIComponent(project)}`);
