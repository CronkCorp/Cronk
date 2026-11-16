import type { FastifyInstance } from "fastify";
import { ACTIVITY_KINDS, DECISION_STATUSES, LINK_REASONS, PRIORITIES, RELATION_KINDS, SEARCH_KINDS, STATUS_CATEGORIES, VERIFICATIONS, WAITING_REASONS } from "../shared/values.js";

/** JSON schemas for request fields used by more than one route. */

/** A display name: non-blank, at most 200 characters. Routes trim it before storing. */
export const nameSchema = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } as const;

/** Agent Access: the most Agents may do in a Project or the Workspace. */
export const agentAccessSchema = { type: "string", enum: ["none", "read", "write"] } as const;

/** A User's Role in the Workspace. */
export const roleSchema = { type: "string", enum: ["admin", "member"] } as const;

/** A User's access in a Project. */
export const accessSchema = { type: "string", enum: ["read", "write"] } as const;

/** Route schema for an operation anyone may call, signed in or not; the OpenAPI description lists no security for it. */
export const publicRoute = { security: [] } as const;

/*
 * Response shapes shared by several routes. Each is registered once (see `addSharedSchemas`),
 * appears under `components.schemas` in the OpenAPI description, and is referenced with `ref`.
 *
 * Fastify serializes a response with its schema and drops any property the schema doesn't
 * list, so each one must list every field the API returns.
 */

export type SharedSchemaName =
  | "Error"
  | "User"
  | "Invitation"
  | "Workspace"
  | "Agent"
  | "AgentSession"
  | "AgentToken"
  | "Claim"
  | "Project"
  | "Status"
  | "Ticket"
  | "TicketRef"
  | "Relations"
  | "RecordedChange"
  | "Activity"
  | "Comment"
  | "WaitingWork"
  | "Document"
  | "Report"
  | "DocumentTreeEntry"
  | "Version"
  | "VersionSummary"
  | "StaleVersion"
  | "SectionRefused"
  | "Merge"
  | "Guidance"
  | "GuidanceVersion"
  | "StaleGuidance"
  | "GuidanceMerge"
  | "SearchResult"
  | "LinkedDocument"
  | "Transcript"
  | "TranscriptSummary"
  | "AgentRecordEntry"
  | "Decision"
  | "DecisionSummary"
  | "DecisionVersion"
  | "DecisionVersionSummary"
  | "StaleDecision"
  | "Term"
  | "TermVersion"
  | "StaleTermVersion"
  | "RenamedId"
  | "ProtectionMarking"
  | "Attachment"
  | "AvoidedWord";

/** A reference to a shared schema by name, such as `ref("Ticket")`. */
export const ref = (name: SharedSchemaName) => ({ $ref: `${name}#` }) as const;

const id = { type: "string", format: "uuid" } as const;
const timestamp = { type: "string", format: "date-time" } as const;
/** An object schema whose properties are all required, except those listed as `optional`. */
const object = (properties: Record<string, object>, optional: string[] = []) => ({
  type: "object",
  required: Object.keys(properties).filter((p) => !optional.includes(p)),
  properties,
});
/** A User or Agent as another record names it. */
const named = object({ id, name: { type: "string" } });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });

/** What a Transcript and its summary share. */
const transcriptFields = {
  id,
  chatId: { type: "string", description: "The client's id for the chat, such as Claude Code's `session_id`; one Transcript per Agent and chat." },
  agent: {
    ...object({ id, name: { type: "string" }, owner: named }),
    description: "The Agent that uploaded it, with its Owner.",
  },
  sessions: { type: "array", items: object({ id }), description: "The uploading Agent's Agent Sessions it names, in the order they started." },
  tickets: {
    type: "array",
    items: object({ key: { type: "string" }, title: { type: "string" } }),
    description: "The Tickets its Sessions changed, wrote Activities or Comments on, or attached files to, that the caller can read.",
  },
  documents: {
    type: "array",
    items: object({ id, title: { type: "string" } }),
    description: "The Documents and Reports its Sessions saved or commented on, that the caller can read.",
  },
  terms: {
    type: "array",
    items: object({ id, name: { type: "string" } }),
    description: "The Terms its Sessions saved, that the caller can read.",
  },
  createdAt: timestamp,
  updatedAt: timestamp,
};
/** Another Ticket as a Ticket's parent and history name it. */
/** Who wrote an Activity or a Report: the Agent with the Owner it acts for, and the Agent Session it was in. */
const writtenBy = {
  agent: { ...object({ id, name: { type: "string" }, owner: named }), description: "The Agent that wrote it, with the Owner it acts for." },
  session: { ...object({ id }), description: "The Agent Session it was written in." },
};

const ticketName = object({ key: { type: "string" }, title: { type: "string" } });
const priority = { type: "string", enum: PRIORITIES } as const;
const labels = { type: "array", items: { type: "string" } } as const;

/** Who did something, as history records it. */
const recordedActor = {
  description: "A User, or an Agent with the Owner it acted for and the Agent Session it was in.",
  ...object(
    {
      kind: { type: "string", enum: ["user", "agent"] },
      id,
      name: { type: "string" },
      owner: named,
      session: { ...nullable(object({ id })), description: "The Agent Session an Agent acted in, if any." },
    },
    ["owner", "session"],
  ),
};

/** Describes an item's `protected` flag: true when `when`. */
const protectedDescription = (when: string) =>
  `Whether Agents may read but not change it, whatever their Agent Access: true when ${when}. An Agent proposes a change to it as a Suggestion.`;

/** A Version's fields, all but its body. */
const versionFields = {
  number: { type: "integer", description: "Counts from 1 per Document." },
  title: { type: "string" },
  at: timestamp,
  actor: { ...recordedActor, description: "Who saved it." },
  restoredFrom: { ...nullable({ type: "integer" }), description: "The Version it restored, if it was a restore." },
};

const decisionStatus = { type: "string", enum: DECISION_STATUSES } as const;
/** Another Decision of the same Project or Workspace, as a Decision names it. */
const decisionRef = object({ key: { type: "string" }, title: { type: "string" }, status: decisionStatus });

/** A Decision's fields as its register lists them. */
const decisionSummaryFields = {
  id,
  key: { type: "string", description: "Such as `CRONK-D7`, or `D7` for a Workspace Decision." },
  number: { type: "integer", description: "Counts from 1 per Project, and in the Workspace." },
  projectId: { ...nullable(id), description: "Null for a Workspace Decision." },
  projectKey: { ...nullable({ type: "string" }), description: "Null for a Workspace Decision." },
  title: { type: "string" },
  status: decisionStatus,
  group: { ...nullable({ type: "string" }), description: "The group it is filed under; null for none." },
  version: { type: "integer", description: "The number of its current Version; name it as `baseVersion` when editing." },
  protected: { type: "boolean", description: protectedDescription("a User marked it Protected, as accepting it does") },
  supersededBy: { ...nullable(decisionRef), description: "The accepted Decision that replaced it, if it is superseded." },
  createdAt: timestamp,
  updatedAt: timestamp,
};

const decisionFields = {
  ...decisionSummaryFields,
  body: { type: "string", description: "Markdown." },
  supersedes: { type: "array", items: decisionRef, description: "The Decisions it replaces once accepted, of the same Project or Workspace." },
  proposedBy: { ...recordedActor, description: "Who recorded it." },
  statusChangedAt: { ...timestamp, description: "When it took its current status." },
  statusChangedBy: { ...recordedActor, description: "Who gave it its current status." },
};

/** A Decision Version's fields, all but its body. */
const decisionVersionFields = {
  number: { type: "integer", description: "Counts from 1 per Decision." },
  title: { type: "string" },
  status: decisionStatus,
  group: nullable({ type: "string" }),
  supersedes: { type: "array", items: { type: "string" }, description: "The keys of the Decisions it superseded at that Version." },
  at: timestamp,
  actor: { ...recordedActor, description: "Who saved it." },
};

/** What a Term says, as each of its Versions records it. */
const termFields = {
  name: { type: "string" },
  definition: { type: "string", description: "Markdown." },
  avoid: { type: "array", items: { type: "string" }, description: "The words to avoid for it, in the order given." },
  group: { ...nullable({ type: "string" }), description: "The group the glossary lists it under; null for none." },
};

/** Each side's text of a part both sides of a merge changed differently. */
const conflict = {
  description: "Each side's text of a part both sides changed differently; null where a side has no such part (it removed the section).",
  ...object({
    base: nullable({ type: "string" }),
    mine: nullable({ type: "string" }),
    theirs: nullable({ type: "string" }),
    both: { type: "string", description: "Mine followed by theirs, for keeping both; a section heading they share appears once." },
  }),
};

/** The sections of a merge, in order; joined, they make the merged `whole`. */
const mergedSections = (whole: string) => ({
  type: "array",
  description: `The merged sections in order, each from one heading to the next; joined, their texts (or the chosen text of each conflict) make the ${whole}.`,
  items: object({
    heading: { ...nullable({ type: "string" }), description: "Its heading line, such as `## Setup`; null for the text before the first heading." },
    text: { ...nullable({ type: "string" }), description: "The merged text, heading line included; null when it conflicts." },
    conflict: { ...nullable(conflict), description: "Set when both sides changed the section differently." },
  }),
});

const sharedSchemas: Record<SharedSchemaName, object> = {
  Error: { description: "Every API error has this shape.", ...object({ error: { type: "string" } }) },
  User: object({
    id,
    email: { type: "string" },
    name: { type: "string" },
    role: roleSchema,
    active: { type: "boolean", description: "False once an Admin has deactivated the User." },
    joined: {
      type: "boolean",
      description: "False for a User an import brought in who hasn't accepted an invitation yet: they have no password and can't sign in until an Admin invites them and they accept.",
    },
  }),
  Invitation: object({
    id,
    email: { type: "string" },
    role: roleSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
  }),
  Workspace: object({
    name: { type: "string" },
    agentAccess: agentAccessSchema,
    silenceThresholdSeconds: { type: "integer", description: "How long an Agent Session may stay silent before it ends and its Claims lapse." },
    attachmentMaxBytes: { type: "integer", description: "The largest file an Attachment may be, in bytes." },
    transcriptMaxBytes: { type: "integer", description: "The most a Transcript may hold, all its texts together, in bytes of UTF-8." },
  }),
  Guidance: {
    description: "Standing instructions Users write for Agents, as Markdown.",
    ...object({
      markdown: { type: "string" },
      version: { type: "integer", description: "The current Version, counted from 1; 0 before anyone writes the Guidance." },
    }),
  },
  GuidanceVersion: {
    description: "One saved state of Guidance, with the User who saved it and when.",
    ...object({
      version: { type: "integer" },
      markdown: { type: "string" },
      at: timestamp,
      actor: object({ kind: { type: "string", const: "user" }, id, name: { type: "string" } }),
    }),
  },
  Agent: object(
    {
      id,
      name: { type: "string" },
      owner: named,
      createdAt: timestamp,
      sessions: {
        type: "array",
        items: ref("AgentSession"),
        description: "Its live Agent Sessions, oldest first; only the Agents list has it.",
      },
      lastSessionEndedAt: {
        ...nullable(timestamp),
        description:
          "When its last Agent Session that is no longer live ended or fell silent, or null if it has had none; only the Agents list has it.",
      },
      delegateTicketCount: {
        type: "integer",
        description: "How many unfinished Tickets it is Delegate on in Projects the caller can read; only the Agents list has it.",
      },
    },
    ["sessions", "lastSessionEndedAt", "delegateTicketCount"],
  ),
  AgentSession: {
    description: "One continuous connection of an Agent, from connect to disconnect.",
    ...object({
      id,
      startedAt: timestamp,
      lastSeenAt: timestamp,
      endsIfSilentAt: { ...timestamp, description: "When the Session ends if it stays silent until then." },
      claims: {
        type: "array",
        description:
          "The Tickets it holds the live Claims on, in key order, leaving out those in Projects the caller can't read; only the Agents list has it.",
        items: object({ ticketKey: { type: "string" }, title: { type: "string" } }),
      },
    }, ["claims"]),
  },
  AgentToken: {
    description: "A token an Agent calls the API with. A read-only token is refused every write.",
    ...object({ id, readOnly: { type: "boolean" }, createdAt: timestamp }),
  },
  Claim: {
    description: "An Agent Session's exclusive, temporary hold on a Ticket. It lapses when the Session stays silent too long.",
    ...object({
      agent: named,
      session: object({ id }),
      claimedAt: timestamp,
      lastSeenAt: { ...timestamp, description: "When the Claim's Agent Session was last heard from." },
      endsIfSilentAt: { ...timestamp, description: "When the Claim lapses if its Agent Session stays silent until then." },
    }),
  },
  Project: object({
    id,
    name: { type: "string" },
    key: { type: "string" },
    archived: { type: "boolean" },
    visibility: { type: "string", enum: ["open", "private"] },
    agentAccess: agentAccessSchema,
    autonomousByDefault: {
      type: "boolean",
      description: "What delegating one of its Tickets sets Autonomous Delegation to, unless the delegating User says otherwise. Off unless a User turns it on.",
    },
    access: { ...accessSchema, description: "What the caller may do in the Project." },
  }),
  Status: object({
    id,
    name: { type: "string" },
    category: { type: "string", enum: STATUS_CATEGORIES },
  }),
  Ticket: object({
    id,
    projectId: id,
    projectKey: { type: "string" },
    key: { type: "string", description: "`<Project key>-<number>`, such as `CRONK-12`." },
    number: { type: "integer" },
    title: { type: "string" },
    description: { type: "string", description: "Markdown." },
    status: ref("Status"),
    priority,
    labels,
    assignee: nullable(named),
    delegate: { ...nullable(named), description: "The Agent the Assignee handed the Ticket to; always one of the Assignee's own." },
    parent: { ...nullable(ticketName), description: "Set on a Sub-Ticket." },
    autonomous: {
      type: "boolean",
      description: "Autonomous Delegation: the Delegate may complete the Ticket itself, each completion Unverified until a User Accepts it. Only Users set it.",
    },
    verification: {
      ...nullable({ type: "string", enum: VERIFICATIONS }),
      description:
        "Where an Agent's completion under Autonomous Delegation stands: `unverified` until a User Accepts it, then `verified`. Null for any other Ticket.",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  TicketRef: {
    description: "Another Ticket, as a Ticket lists it among its Sub-Tickets or relations.",
    ...object({ key: { type: "string" }, title: { type: "string" }, status: ref("Status") }),
  },
  Relations: {
    description: "A Ticket's relations to other Tickets, each list in key order.",
    ...object({
      blocks: { type: "array", items: ref("TicketRef") },
      blockedBy: { type: "array", items: ref("TicketRef") },
      relatesTo: { type: "array", items: ref("TicketRef") },
    }),
  },
  RecordedChange: {
    description: "One Change to a Ticket: `change` says which; the other fields depend on it.",
    ...object({
      at: timestamp,
      actor: {
        description:
          "Who made the change: a User, an Agent with the Owner it acted for and the Agent Session it was in, " +
          "or Cronk itself (`kind` `system`) for a change no one made, such as one an upgrade makes.",
        anyOf: [recordedActor, object({ kind: { const: "system" } })],
      },
      change: {
        type: "string",
        enum: [
          ...["created", "title", "description", "status", "priority", "labels", "assignee", "delegate", "parent", "autonomous", "verification"],
          ...["relation added", "relation removed"],
          ...["document linked", "document unlinked"],
        ],
      },
    }),
    anyOf: [
      object({ change: { const: "created" }, title: { type: "string" }, description: { type: "string" }, status: ref("Status") }),
      ...(["title", "description"] as const).map((c) => object({ change: { const: c }, from: { type: "string" }, to: { type: "string" } })),
      object({
        change: { const: "status" },
        from: ref("Status"),
        to: ref("Status"),
        sentBack: { type: "boolean", description: "True for the move back to a Started Status a User made sending the Ticket back from review." },
      }),
      object({ change: { const: "priority" }, from: priority, to: priority }),
      object({ change: { const: "labels" }, from: labels, to: labels }),
      ...(["assignee", "delegate"] as const).map((c) => object({ change: { const: c }, from: nullable(named), to: nullable(named) })),
      object({ change: { const: "parent" }, from: nullable(ticketName), to: nullable(ticketName) }),
      object({ change: { const: "autonomous" }, from: { type: "boolean" }, to: { type: "boolean" } }),
      object({ change: { const: "verification" }, from: nullable({ type: "string", enum: VERIFICATIONS }), to: nullable({ type: "string", enum: VERIFICATIONS }) }),
      object({
        change: { type: "string", enum: ["relation added", "relation removed"] },
        kind: { type: "string", enum: RELATION_KINDS },
        ticket: ticketName,
      }),
      object({
        change: { type: "string", enum: ["document linked", "document unlinked"] },
        document: object({
          id,
          title: { type: "string" },
          projectKey: { ...nullable({ type: "string" }), description: "Null for a Workspace Document." },
        }),
      }),
    ],
  },
  Activity: {
    description: "One timestamped entry an Agent Session wrote on a Ticket while holding its Claim.",
    ...object({
      id,
      ticketKey: { type: "string" },
      kind: { type: "string", enum: ACTIVITY_KINDS },
      body: { type: "string", description: "Markdown." },
      blocking: { type: "boolean", description: "True for a question the Agent waits on; only questions can be." },
      at: timestamp,
      ...writtenBy,
      answer: {
        ...nullable(object({ commentId: id, at: timestamp })),
        description: "For a question, once answered: the first Comment a User replied to it with.",
      },
    }),
  },
  Comment: {
    description: "A message an Actor posted on a Ticket or a Document: conversation, as opposed to an Agent's own Activities.",
    ...object({
      id,
      ticketKey: { ...nullable({ type: "string" }), description: "The Ticket it is on; null on a Document." },
      documentId: { ...nullable(id), description: "The Document it is on; null on a Ticket." },
      replyToCommentId: { ...nullable(id), description: "The Comment it replies to, if any." },
      replyToActivityId: { ...nullable(id), description: "The Activity it replies to, if any; a reply to a question answers it." },
      anchor: {
        ...nullable(
          object({
            passage: { type: "string", description: "The text it is about, exactly as the Document held it." },
            version: { type: "integer", description: "The Version of the Document it was anchored in." },
            inCurrentVersion: { type: "boolean", description: "Whether the current Version still holds the passage; it stays anchored while it does." },
          }),
        ),
        description: "The passage of its Document it is anchored to; null when it isn't anchored.",
      },
      body: { type: "string", description: "Markdown." },
      sendBack: { type: "boolean", description: "True for the Comment a User sent its Ticket back from review with." },
      at: timestamp,
      actor: { ...recordedActor, description: "Who posted it." },
    }),
  },
  WaitingWork: {
    description: "A Comment waiting for an Agent (ADR 0005), with why and what it is on.",
    ...object({
      reason: {
        type: "string",
        enum: WAITING_REASONS,
        description: "`answer`: it answers the Agent's question. `mention`: it @mentions the Agent. `comment`: it is on a Ticket delegated to the Agent.",
      },
      comment: ref("Comment"),
      ticket: { ...nullable(ticketName), description: "The Ticket it is on; null on a Document." },
      document: { ...nullable(object({ id, title: { type: "string" } })), description: "The Document it is on; null on a Ticket." },
    }),
  },
  Document: {
    description: "A piece of written knowledge, kept as Markdown, belonging to a Project or the Workspace.",
    ...object({
      id,
      projectId: { ...nullable(id), description: "Null for a Workspace Document." },
      projectKey: { ...nullable({ type: "string" }), description: "Null for a Workspace Document." },
      parentId: { ...nullable(id), description: "The Document it sits under in the page tree; null at the top, and for a Report." },
      ticketKey: { ...nullable({ type: "string" }), description: "The Ticket a Report is on; null for any other Document. Reports stay out of the page tree." },
      title: { type: "string" },
      body: { type: "string", description: "Markdown." },
      version: { type: "integer", description: "The number of its current Version; name it as `baseVersion` when saving." },
      protected: { type: "boolean", description: protectedDescription("it is marked Protected, or sits under a Document that is") },
      protectedBy: {
        ...nullable(object({ id, title: { type: "string" } })),
        description: "The Document whose Protected mark covers it: itself if marked, else the nearest marked Document above it; null if none.",
      },
      covers: { type: "integer", description: "When it is itself marked Protected, how many Documents under it the mark covers; 0 otherwise." },
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  },
  ProtectionMarking: {
    description: "One marking or unmarking of an item as Protected, with the User who did it.",
    ...object({
      protected: { type: "boolean", description: "True when it was marked, false when unmarked." },
      at: timestamp,
      actor: { ...recordedActor, description: "The User who did it; only Users mark and unmark." },
    }),
  },
  Decision: {
    description:
      "A recorded choice with its reasoning and a status, belonging to a Project or the Workspace, kept as Markdown. Only Users change its status; " +
      "accepting a Decision that supersedes others marks them superseded.",
    ...object(decisionFields),
  },
  DecisionSummary: {
    description: "A Decision as its register lists it, without its body; read it by its key.",
    ...object(decisionSummaryFields),
  },
  DecisionVersion: {
    description: "One saved state of a Decision, an edit or a change of status, recording which Actor produced it. Never changes.",
    ...object({ ...decisionVersionFields, body: { type: "string", description: "Markdown." } }),
  },
  DecisionVersionSummary: { description: "A Decision's Version without its body, as its Version list shows it.", ...object(decisionVersionFields) },
  StaleDecision: {
    description: "An edit of a Decision refused because the Version it is based on is no longer current, with the current Version to merge with.",
    ...object({ error: { type: "string" }, current: ref("DecisionVersion") }),
  },
  Report: {
    description:
      "A Report as its Ticket and Project list it, without its body: a Document of findings an Agent Session wrote on a Ticket while holding its Claim. " +
      "Read or edit it as a Document by its id.",
    ...object({
      id,
      ticketKey: { type: "string" },
      ticketTitle: { type: "string" },
      title: { type: "string" },
      version: { type: "integer", description: "The number of its current Version." },
      createdAt: timestamp,
      updatedAt: timestamp,
      ...writtenBy,
    }),
  },
  LinkedDocument: {
    description:
      "A Document linked to a Ticket: one of its Reports, a Document linked to it from the Ticket's side, or a Document that mentions its key. Read it as a Document by its id.",
    ...object({
      id,
      title: { type: "string" },
      projectKey: { ...nullable({ type: "string" }), description: "Null for a Workspace Document." },
      ticketKey: { ...nullable({ type: "string" }), description: "The Ticket a Report is on; null for any other Document." },
      version: { type: "integer", description: "The number of its current Version." },
      updatedAt: timestamp,
      reason: {
        type: "string",
        enum: LINK_REASONS,
        description: "Why the Ticket lists it: one of its Reports, linked to it, or mentioning its key.",
      },
    }),
  },
  DocumentTreeEntry: {
    description: "A Document as its page tree lists it.",
    ...object({
      id,
      parentId: { ...nullable(id), description: "The Document it sits under; null at the top." },
      title: { type: "string" },
      depth: { type: "integer", description: "How deep it sits: 0 at the top." },
      protected: { type: "boolean", description: protectedDescription("it, or a Document above it, is marked Protected") },
    }),
  },
  Version: {
    description: "One saved state of a Document, recording which Actor produced it. Never changes.",
    ...object({ ...versionFields, body: { type: "string", description: "Markdown." } }),
  },
  VersionSummary: { description: "A Version without its body, as a Document's Version list shows it.", ...object(versionFields) },
  StaleVersion: {
    description: "A save or delete of a Document refused because the Version it is based on is no longer current, with the current Version to merge with.",
    ...object({ error: { type: "string" }, current: ref("Version") }),
  },
  SectionRefused: {
    description: "A section replacement refused because no section, or more than one, has that heading, with the Document's headings to pick from.",
    ...object({ error: { type: "string" }, headings: { type: "array", items: { type: "string" }, description: "Its heading lines, such as `## Setup`, in order." } }, ["headings"]),
  },
  Merge: {
    description: "An edit merged section by section with the current Version. Only conflicts need a User's choice.",
    ...object({
      onto: { ...ref("Version"), description: "The current Version merged onto; save the result with its number as `baseVersion`." },
      title: { ...nullable({ type: "string" }), description: "The merged title; null when it conflicts." },
      titleConflict: { ...nullable(conflict), description: "Set when both sides changed the title differently." },
      body: { ...nullable({ type: "string" }), description: "The merged Markdown; null while any section conflicts." },
      conflicts: { type: "integer", description: "How many sections conflict, plus one if the title does." },
      sections: mergedSections("body"),
    }),
  },
  StaleGuidance: {
    description: "A save of Guidance refused because the Version it is based on is no longer current, with the current Guidance to merge with.",
    ...object({ error: { type: "string" }, current: ref("Guidance") }),
  },
  GuidanceMerge: {
    description: "An edit of Guidance merged section by section with the current Guidance. Only conflicts need a User's choice.",
    ...object({
      onto: { ...ref("Guidance"), description: "The current Guidance merged onto; save the result with its `version` as `baseVersion`." },
      markdown: { ...nullable({ type: "string" }), description: "The merged Markdown; null while any section conflicts." },
      conflicts: { type: "integer", description: "How many sections conflict." },
      sections: mergedSections("Markdown"),
    }),
  },
  Term: {
    description:
      "One concept of the glossary: its name, definition and the words to avoid for it. Belongs to the Workspace or a Project; " +
      "within a Project, a Project Term replaces the Workspace Term of the same name, ignoring case.",
    ...object({
      id,
      projectId: { ...nullable(id), description: "Null for a Workspace Term." },
      projectKey: { ...nullable({ type: "string" }), description: "Null for a Workspace Term." },
      ...termFields,
      version: { type: "integer", description: "The number of its current Version; name it as `baseVersion` when saving." },
      protected: { type: "boolean", description: protectedDescription("a User marked it Protected") },
      createdAt: timestamp,
      updatedAt: timestamp,
      overrides: {
        ...nullable(object({ id, name: { type: "string" }, definition: { type: "string" } })),
        description: "For a Project Term: the Workspace Term of the same name it replaces within its Project; null if none, or if the caller can't read the Workspace.",
      },
      overriddenBy: {
        type: "array",
        items: object({ id, name: { type: "string" }, projectKey: { type: "string" } }),
        description: "For a Workspace Term: the Project Terms of the same name that replace it within their Projects, in Projects the caller can read, by Project key.",
      },
    }),
  },
  TermVersion: {
    description: "One saved state of a Term, recording which Actor produced it. Never changes.",
    ...object({
      number: { type: "integer", description: "Counts from 1 per Term." },
      ...termFields,
      at: timestamp,
      actor: { ...recordedActor, description: "Who saved it." },
    }),
  },
  StaleTermVersion: {
    description: "A save or delete of a Term refused because the Version it is based on is no longer current, with the current Version.",
    ...object({ error: { type: "string" }, current: ref("TermVersion") }),
  },
  AvoidedWord: {
    description:
      "A word a Term says to avoid, found in the prose a save wrote, with the Term to use instead. The save succeeds regardless; " +
      "words in code spans, code blocks, block quotes and raw HTML don't count.",
    ...object({
      field: { type: "string", description: "The request field it was written in, such as `title`, `body` or `description`." },
      word: { type: "string", description: "The word or phrase as written." },
      line: { type: "integer", minimum: 1, description: "The line it starts on in the field as sent, counting from 1." },
      column: {
        type: "integer",
        minimum: 1,
        description: "The column of that line it starts at, counting from 1 in UTF-16 code units, as JavaScript strings index text.",
      },
      term: { ...named, description: "The Term to use instead, as it applies where the text was saved." },
    }),
  },
  RenamedId: {
    description: "An Agent or Agent Session an import gave a new id, because the id it had in the export was taken.",
    ...object({
      kind: { type: "string", enum: ["agent", "agentSession"], description: "Whether it is an Agent or an Agent Session." },
      from: { type: "string", description: "Its id in the export, usually a UUID; an export edited by hand may hold anything." },
      to: { ...id, description: "Its id here." },
      at: { ...timestamp, description: "When it was imported." },
    }),
  },
  AgentRecordEntry: {
    description: "One entry in an Agent's record: one thing it did. `kind` says which; the field named after it holds what, and the other three are null.",
    ...object({
      kind: { type: "string", enum: ["change", "activity", "comment", "version"], description: "A Change to a Ticket, an Activity, a Comment or a saved Version." },
      at: timestamp,
      session: { ...nullable(object({ id })), description: "The Agent Session it was done in; null for an imported entry that names none." },
      projectKey: { ...nullable({ type: "string" }), description: "Null for a Document in the Workspace outside any Project." },
      ticket: { ...nullable(ticketName), description: "The Ticket it was on: a Change's, Activity's or Comment's, or a Report's." },
      document: {
        ...nullable(object({ id, title: { type: "string" } })),
        description: "The Document or Report it was on, for a Comment or a saved Version.",
      },
      change: { ...nullable(ref("RecordedChange")), description: "A Change it made to the Ticket." },
      activity: {
        ...nullable(object({ id, kind: { type: "string", enum: ACTIVITY_KINDS }, body: { type: "string" }, blocking: { type: "boolean" } })),
        description: "An Activity it logged; the body is Markdown.",
      },
      comment: { ...nullable(object({ id, body: { type: "string" } })), description: "A Comment it posted; the body is Markdown." },
      version: { ...nullable(object({ number: { type: "integer" } })), description: "A Version of the Document it saved." },
    }),
  },
  Attachment: {
    description:
      "A plain file, such as an image, video, PDF or log, attached to a Ticket. Whoever can read the Ticket can read it; " +
      "download it from GET /api/attachments/{id}/file.",
    ...object({
      id,
      ticketKey: { type: "string", description: "The Ticket it is attached to." },
      name: { type: "string", description: "Its file name, as attached." },
      contentType: { type: "string", description: "Its media type, such as `image/png`, as attached." },
      size: { type: "integer", description: "Its size in bytes." },
      at: timestamp,
      actor: { ...recordedActor, description: "Who attached it." },
    }),
  },
  Transcript: {
    description:
      "The verbatim chat that led an Agent to change things, uploaded from the client side and linked by the Agent's own Agent Session ids found in it, " +
      "and so to everything those Sessions changed.",
    ...object({
      ...transcriptFields,
      markdown: { type: "string", description: "The text of the latest upload, in the turn convention (Markdown)." },
      earlier: {
        type: "array",
        items: { type: "string" },
        description: "Texts of earlier uploads that a later one didn't continue, oldest first; kept beside the latest.",
      },
    }),
  },
  TranscriptSummary: {
    description: "A Transcript without its text.",
    ...object(transcriptFields),
  },
  SearchResult: {
    description: "One thing a search found, with an excerpt of its text around the match.",
    ...object({
      kind: { type: "string", enum: SEARCH_KINDS, description: "A Ticket, a Document in a page tree, a Report, or a Comment." },
      title: { type: "string", description: "The title of the Ticket or Document; for a Comment, of the Ticket or Document it is on." },
      excerpt: { type: "string", description: "The text around the match, as written (Markdown), without markers around the matching words." },
      projectKey: { ...nullable({ type: "string" }), description: "Null for something in the Workspace outside any Project." },
      ticketKey: { ...nullable({ type: "string" }), description: "The Ticket; a Report's or a Comment's Ticket; otherwise null." },
      documentId: { ...nullable(id), description: "The Document or Report; a Comment's Document; otherwise null." },
    }),
  },
};

/** Registers the shared response shapes, so routes can `ref` them. */
export function addSharedSchemas(app: FastifyInstance): void {
  for (const [name, schema] of Object.entries(sharedSchemas)) app.addSchema({ $id: name, ...schema });
}

/** A JSON body with one field holding a shared shape, such as `{ ticket: Ticket }`. */
export const holding = (field: string, name: SharedSchemaName) => object({ [field]: ref(name) });

/**
 * The answer to a save of text: one field holding a shared shape, such as `{ report: Document }`, and
 * `avoidedWords`, the words a Term says to avoid that the save wrote, in the order of the request's fields.
 */
export const savedHolding = (field: string, name: SharedSchemaName) =>
  object({ [field]: ref(name), avoidedWords: { type: "array", items: ref("AvoidedWord") } });

/** A JSON body with one field listing items, such as `{ tickets: Ticket[] }`. */
export const listing = (field: string, items: object) => object({ [field]: { type: "array", items } });

/** A success answer with a JSON body. */
export const answer = (description: string, schema: object) => ({ description, ...schema });

/** A success answer with no body, such as a 204. */
export const noContent = (description: string) => ({ description, type: "null" }) as const;

/** What each error status means, wherever a route answers it. */
const ERROR_MEANINGS = {
  400: "The request is invalid: a field, parameter or value the operation refuses",
  401: "Not signed in, or the Agent token is unknown or revoked",
  403:
    "The caller may not do this: an Admin-only change, Read access where Write is needed, an Agent where only a User may act, " +
    "an Agent changing something outside an Agent Session (start one with POST /api/agent-sessions), or a signed-in write sent from another site",
  404: "There is no such record, or the caller can't see it",
  409: "The change conflicts with the current state",
  410: "The Agent Session named in the Cronk-Agent-Session header has ended or wasn't started with this token",
  413: "The upload is larger than the Workspace allows: an Attachment's file, or a Transcript with every text it keeps",
  416: "The range asked for lies outside the file",
  422: "The request is well formed but can't be kept as it is",
} as const;

/** The error answers of a route, each with the shared `Error` shape. */
export const errors = (...codes: (keyof typeof ERROR_MEANINGS)[]) =>
  Object.fromEntries(codes.map((code) => [code, { description: ERROR_MEANINGS[code], ...ref("Error") }]));

/** A route's path parameters; each is required, and each schema should say what it names. */
export const pathParams = <P extends Record<string, { readonly type: string; readonly description: string }>>(properties: P) =>
  object(properties);

/** A Project's key, such as `CRONK`, in any case. */
export const projectKeyParam = { type: "string", description: "The Project's key, such as `CRONK`; any case." } as const;

/** A User's id. */
export const userIdParam = { type: "string", format: "uuid", description: "The User's id." } as const;

/** A Document's id. */
export const documentIdParam = { type: "string", format: "uuid", description: "The Document's id." } as const;

/** An Attachment's id. */
export const attachmentIdParam = { type: "string", format: "uuid", description: "The Attachment's id." } as const;

/** A Term's id. */
export const termIdParam = { type: "string", format: "uuid", description: "The Term's id." } as const;

/** A Ticket's key, such as `CRONK-12`, in any case. */
export const ticketKeyParam = { type: "string", description: "The Ticket's key, such as `CRONK-12`; any case." } as const;

/** The body of a request marking an item Protected or unmarking it. */
export const protectionBody = {
  type: "object",
  required: ["protected"],
  additionalProperties: false,
  properties: {
    protected: { type: "boolean", description: "True to mark it Protected, so Agents may read but not change it; false to unmark it." },
  },
} as const;

/** An item's protection history, newest first. */
export const protectionHistoryAnswer = answer(
  "Each time a User marked it Protected or unmarked it, newest first",
  listing("markings", ref("ProtectionMarking")),
);
