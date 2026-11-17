import type { FastifyInstance } from "fastify";
import { WORKSPACE_SETTINGS } from "./workspace/workspaces.js";
import { ACTIVITY_KINDS, DECISION_STATUSES, LINK_REASONS, MENTION_KINDS, PRIORITIES, RELATION_KINDS, SEARCH_KINDS, STATUS_CATEGORIES, SUGGESTION_KINDS, SUGGESTION_STATES, VERIFICATIONS, EXTRA_ORIGIN_USES, WAITING_REASONS } from "../shared/values.js";

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
  | "BlockingRef"
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
  | "DecisionMerge"
  | "SearchResult"
  | "LinkedDocument"
  | "Mention"
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
  | "Artifact"
  | "ArtifactVersion"
  | "ExtraOrigin"
  | "StaleArtifact"
  | "EmbeddedIn"
  | "AvoidedWord"
  | "Suggestion";

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
  decisions: {
    type: "array",
    items: object({ key: { type: "string" }, title: { type: "string" } }),
    description: "The Decisions its Sessions proposed or refined, that the caller can read.",
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

/** The Artifacts a Markdown body embeds: their addresses standing alone on a line. */
const embeds = (whose: string) => ({
  type: "array",
  items: object({
    artifactId: id,
    version: { ...nullable({ type: "integer" }), description: "The Version the address names, which the embed keeps showing; null for the latest." },
  }),
  description:
    `The Artifacts ${whose} embeds, in order, each once: an Artifact's address (\`url\` or \`versionUrl\`) standing alone on a line, bare, shows the ` +
    "Artifact in place. An address inside a sentence, or naming no Artifact of the Workspace, stays a link.",
});

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

/** What a Suggestion proposes: the fields its item's kind holds. */
const suggestedContent = {
  type: "object",
  description:
    "The item's whole content as its next Version would hold it: a Document's `title` and `body`; a Term's `name`, `definition`, `avoid` and `group`; " +
    "a Decision's `title`, `body` and `group`; Guidance's `markdown`.",
  properties: {
    title: { type: "string" },
    body: { type: "string", description: "Markdown." },
    name: { type: "string" },
    definition: { type: "string", description: "Markdown." },
    avoid: { type: "array", items: { type: "string" } },
    group: nullable({ type: "string" }),
    markdown: { type: "string" },
  },
} as const;

/** The accepted Suggestion a Version came from (ADR 0014). */
const versionSuggestion = {
  ...nullable(object({ id, acceptedWithEdits: { type: "boolean" }, acceptedBy: named })),
  description:
    "The Suggestion a User accepted to make it: unchanged, when the Version is credited to the Agent; or edited first, when it is the User's. Null for a Version saved otherwise.",
};

/** A Version's fields, all but its body. */
const versionFields = {
  number: { type: "integer", description: "Counts from 1 per Document." },
  title: { type: "string" },
  at: timestamp,
  actor: { ...recordedActor, description: "Who saved it." },
  restoredFrom: { ...nullable({ type: "integer" }), description: "The Version it restored, if it was a restore." },
  suggestion: versionSuggestion,
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
  sourceTicket: {
    ...nullable(object({ key: { type: "string" }, title: { type: "string" } })),
    description: "The Ticket an Agent was working on when it proposed it, holding its Claim; null otherwise.",
  },
  proposedBy: { ...recordedActor, description: "Who recorded it." },
  statusReason: { ...nullable({ type: "string" }), description: "Why it took its current status, as the User gave it: the reason it was rejected. Null when none was given." },
  statusChangedAt: { ...timestamp, description: "When it took its current status." },
  statusChangedBy: { ...recordedActor, description: "Who gave it its current status." },
};

/** A Decision Version's fields, all but its body. */
const decisionVersionFields = {
  number: { type: "integer", description: "Counts from 1 per Decision." },
  title: { type: "string" },
  status: decisionStatus,
  statusReason: { ...nullable({ type: "string" }), description: "Why it had that status, as given when it took it." },
  group: nullable({ type: "string" }),
  supersedes: { type: "array", items: { type: "string" }, description: "The keys of the Decisions it superseded at that Version." },
  at: timestamp,
  actor: { ...recordedActor, description: "Who saved it." },
  suggestion: versionSuggestion,
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

/** Decision keys, in order. */
const keyList = { type: "array", items: { type: "string" } } as const;

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
    ...Object.fromEntries(WORKSPACE_SETTINGS.map((s) => [s.name, { type: "integer", description: s.responseDescription }])),
    artifactAllowedOrigins: {
      type: "array",
      items: { type: "string" },
      description: "The origins every Artifact may load scripts, styles and fonts from, besides its own files.",
    },
    artifactExtraOriginsAllowed: {
      type: "boolean",
      description: "Whether a publish may declare extra origins for its Version; turned off, Versions are served without those they declared.",
    },
  }),
  Guidance: {
    description: "Standing instructions Users write for Agents, as Markdown.",
    ...object({
      markdown: { type: "string" },
      version: { type: "integer", description: "The current Version, counted from 1; 0 before anyone writes the Guidance." },
    }),
  },
  GuidanceVersion: {
    description: "One saved state of Guidance, with the Actor who saved it and when: a User, or an Agent whose Suggestion a User accepted unchanged.",
    ...object({
      version: { type: "integer" },
      markdown: { type: "string" },
      at: timestamp,
      actor: { ...recordedActor, description: "Who saved it." },
      suggestion: versionSuggestion,
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
    discovered: {
      ...nullable(
        object({
          agent: { ...named, description: "The Agent that filed it." },
          session: { ...nullable(object({ id })), description: "The Agent Session it was filed in." },
          sourceTicket: { ...nullable(ticketName), description: "The Ticket of the same Project the Agent was working on, holding its Claim; null for none." },
          kept: { type: "boolean", description: "Whether a User chose Keep in Backlog for it, which takes it out of the Inbox." },
        }),
      ),
      description:
        "The Discovered marker: set on every Ticket an Agent created other than a Sub-Ticket of its own Claimed Ticket. Until a User delegates it, " +
        "the Agent that filed it may edit it without a Claim, but can't work on it. Null for any other Ticket.",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  TicketRef: {
    description: "Another Ticket, as a Ticket lists it among its Sub-Tickets or relations.",
    ...object({ key: { type: "string" }, title: { type: "string" }, status: ref("Status") }),
  },
  BlockingRef: {
    description: "Another Ticket at the other end of a block, as a Ticket lists it among its relations.",
    ...object({
      key: { type: "string" },
      title: { type: "string" },
      status: ref("Status"),
      block: {
        ...nullable(object({ agent: { ...named, description: "The Agent that added it." }, reason: { type: "string" } })),
        description: "Set on a block an Agent added from its own Discovered Ticket: the Agent that added it, and why. Null on any other block.",
      },
    }),
  },
  Relations: {
    description: "A Ticket's relations to other Tickets, each list in key order.",
    ...object({
      blocks: { type: "array", items: ref("BlockingRef") },
      blockedBy: { type: "array", items: ref("BlockingRef") },
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
          ...["created", "title", "description", "status", "priority", "labels", "assignee", "delegate", "parent", "autonomous", "verification", "kept"],
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
        reopened: { type: "boolean", description: "True for the move back to a Started Status a User made Reopening an Agent's Unverified completion." },
      }),
      object({ change: { const: "priority" }, from: priority, to: priority }),
      object({ change: { const: "labels" }, from: labels, to: labels }),
      ...(["assignee", "delegate"] as const).map((c) => object({ change: { const: c }, from: nullable(named), to: nullable(named) })),
      object({ change: { const: "parent" }, from: nullable(ticketName), to: nullable(ticketName) }),
      object({ change: { const: "autonomous" }, from: { type: "boolean" }, to: { type: "boolean" } }),
      object({ change: { const: "verification" }, from: nullable({ type: "string", enum: VERIFICATIONS }), to: nullable({ type: "string", enum: VERIFICATIONS }) }),
      { ...object({ change: { const: "kept" } }), description: "A User kept a Discovered Ticket in Backlog." },
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
    description: "A message an Actor posted on a Ticket, a Document or an Artifact: conversation, as opposed to an Agent's own Activities.",
    ...object({
      id,
      ticketKey: { ...nullable({ type: "string" }), description: "The Ticket it is on; null otherwise." },
      documentId: { ...nullable(id), description: "The Document it is on; null otherwise." },
      artifactId: { ...nullable(id), description: "The Artifact it is on; null otherwise." },
      artifactVersion: { ...nullable({ type: "integer" }), description: "On an Artifact: the Version whoever posted it was viewing; null otherwise." },
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
      embeds: embeds("its body"),
      sendBack: { type: "boolean", description: "True for the Comment a User sent its Ticket back from review with." },
      at: timestamp,
      actor: { ...recordedActor, description: "Who posted it." },
    }),
  },
  WaitingWork: {
    description:
      "Work waiting for an Agent (ADR 0005), with why: a Comment, with what it is on, or a User's rejection of a Decision the Agent proposed or of a " +
      "Suggestion it made, with their reason.",
    ...object(
      {
        reason: {
          type: "string",
          enum: WAITING_REASONS,
          description:
            "`answer`: the Comment answers the Agent's question. `mention`: it @mentions the Agent. `comment`: it is on a Ticket delegated to the Agent. " +
            "`published`: it is on an Artifact Version the Agent published. " +
            "`rejected`: a User rejected a Decision the Agent proposed; `decision` says which and why. " +
            "`suggestion_rejected`: a User rejected a Suggestion the Agent made; `suggestion` says which and why.",
        },
        comment: { ...nullable(ref("Comment")), description: "The Comment; null for a rejection." },
        decision: {
          ...object({
            key: { type: "string" },
            title: { type: "string" },
            reason: { type: "string", description: "Why the User rejected it, in Markdown." },
            rejectedBy: recordedActor,
            at: timestamp,
          }),
          description: "For a rejection only: the Decision, as the Version that rejected it holds it.",
        },
        suggestion: {
          ...object({
            id,
            item: object({
              kind: { type: "string", enum: SUGGESTION_KINDS },
              id: nullable(id),
              key: nullable({ type: "string" }),
              title: { type: "string" },
              projectKey: nullable({ type: "string" }),
            }),
            reason: { type: "string", description: "Why the User rejected it, in Markdown." },
            rejectedBy: recordedActor,
            at: timestamp,
          }),
          description: "For a rejected Suggestion only: which, and why.",
        },
        ticket: { ...nullable(ticketName), description: "The Ticket the Comment is on, or the rejected Decision or Suggestion came from; null otherwise." },
        document: { ...nullable(object({ id, title: { type: "string" } })), description: "The Document the Comment is on; null otherwise." },
        artifact: {
          ...nullable(object({ id, title: { type: "string" }, version: { type: "integer", description: "The Version the Comment is on." } })),
          description: "The Artifact the Comment is on, with the Version whoever posted it was viewing; null otherwise.",
        },
      },
      ["decision", "suggestion"],
    ),
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
      embeds: embeds("its body"),
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
  DecisionMerge: {
    description:
      "An edit of a Decision merged with its current Version: the body section by section, the title, group and superseded Decisions each as one field. " +
      "Only conflicts need a User's choice.",
    ...object({
      onto: { ...ref("DecisionVersion"), description: "The current Version merged onto; save the result with its number as `baseVersion`." },
      title: { ...nullable({ type: "string" }), description: "The merged title; null when it conflicts." },
      titleConflict: { ...nullable(conflict), description: "Set when both sides changed the title differently." },
      body: { ...nullable({ type: "string" }), description: "The merged Markdown; null while any section conflicts." },
      sections: mergedSections("body"),
      group: { ...nullable({ type: "string" }), description: "The merged group; null for none, or when it conflicts." },
      groupConflict: {
        ...nullable(object({ base: nullable({ type: "string" }), mine: nullable({ type: "string" }), theirs: nullable({ type: "string" }) })),
        description: "Each side's group, set when both sides changed it differently.",
      },
      supersedes: { ...nullable(keyList), description: "The keys of the Decisions the merge supersedes; null when they conflict." },
      supersedesConflict: {
        ...nullable(object({ base: keyList, mine: keyList, theirs: keyList })),
        description: "Each side's superseded Decisions, by key, set when both sides changed them differently; they merge as one field, never key by key.",
      },
      conflicts: { type: "integer", description: "How many sections conflict, plus one for each of the title, group and superseded Decisions that does." },
    }),
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
      decisions: {
        type: "array",
        items: decisionRef,
        description: "The Decisions Agents proposed during the Claim it was written in, of its Ticket's Project or the Workspace, oldest first.",
      },
      discovered: {
        type: "array",
        items: ref("TicketRef"),
        description: "The Discovered Tickets the Agent filed from its Ticket during the Claim it was written in, in key order, as they stand now.",
      },
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
      protected: { type: "boolean", description: protectedDescription("it, or a Document above it, is marked Protected (a Report counts only its own mark)") },
    }),
  },
  EmbeddedIn: {
    description: "A Document, Report or Comment whose current text embeds an Artifact: its address standing alone on a line.",
    ...object({
      kind: { type: "string", enum: ["document", "report", "comment"], description: "What embeds it." },
      id: { ...id, description: "The Document's, Report's or Comment's id; read a Report as a Document." },
      title: { type: "string", description: "Its title; for a Comment, the title of the Ticket, Document or Artifact it is on." },
      projectKey: { ...nullable({ type: "string" }), description: "Null when it lies in the Workspace outside any Project." },
      ticketKey: { ...nullable({ type: "string" }), description: "For a Report, or a Comment on a Ticket: the Ticket's key." },
      documentId: { ...nullable(id), description: "For a Comment on a Document: the Document's id." },
      artifactId: { ...nullable(id), description: "For a Comment on an Artifact: that Artifact's id." },
      version: { ...nullable({ type: "integer" }), description: "The Version it embeds; null for the latest." },
      at: { ...timestamp, description: "When it last changed; for a Comment, when it was posted." },
    }),
  },
  Mention: {
    description:
      "Something whose current text mentions a Decision's key or a Term's name, as the web client links them: a Ticket, Document, Comment, Term or Decision.",
    ...object({
      kind: { type: "string", enum: MENTION_KINDS, description: "What mentions it." },
      id: { ...id, description: "Its id; read a Ticket or Decision by its key instead." },
      key: { ...nullable({ type: "string" }), description: "A Ticket's or Decision's key; null for the others." },
      title: { type: "string", description: "Its title; a Term's name; for a Comment, the title of the Ticket, Document or Artifact it is on." },
      projectKey: { ...nullable({ type: "string" }), description: "Null when it lies in the Workspace outside any Project." },
      ticketKey: { ...nullable({ type: "string" }), description: "For a Comment on a Ticket, or a Report: the Ticket's key." },
      documentId: { ...nullable(id), description: "For a Comment on a Document: the Document's id." },
      artifactId: { ...nullable(id), description: "For a Comment on an Artifact: the Artifact's id." },
      at: { ...timestamp, description: "When it last changed; for a Comment, when it was posted." },
      protected: {
        ...nullable({ type: "boolean" }),
        description: `${protectedDescription("a Document, or one above it, is marked Protected; a Term or Decision is marked itself")} Null for a Ticket or Comment.`,
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
    ...object({ ...versionFields, body: { type: "string", description: "Markdown." }, embeds: embeds("its body") }),
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
      suggestion: versionSuggestion,
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
    description: "One entry in an Agent Record: one thing the Agent did. `kind` says which; the field named after it holds what, and the other three are null.",
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
      "A plain file, such as an image, video, PDF or log, attached to a Ticket, a Document or Report, or a Comment. Whoever can read " +
      "that item can read it; download it from GET /api/attachments/{id}/file. One on a Document belongs to the Document, not to a Version.",
    ...object({
      id,
      on: { type: "string", enum: ["ticket", "document", "comment"], description: "What it is attached to." },
      ticketKey: {
        ...nullable({ type: "string" }),
        description: "The Ticket it is on: attached to it, or in one of its Comments or Reports, or in a Comment on one of its Reports.",
      },
      documentId: { ...nullable({ type: "string", format: "uuid" }), description: "The Document or Report it is on: attached to it, or in one of its Comments." },
      commentId: { ...nullable({ type: "string", format: "uuid" }), description: "The Comment it is attached to." },
      name: { type: "string", description: "Its file name, as attached." },
      contentType: { type: "string", description: "Its media type, such as `image/png`, as attached." },
      size: { type: "integer", description: "Its size in bytes." },
      at: timestamp,
      actor: { ...recordedActor, description: "Who attached it." },
    }),
  },
  ExtraOrigin: {
    description: "An origin a publish declared for its Version beyond the Workspace's allow-list: what the page loads from there, and why.",
    ...object({
      origin: { type: "string", description: "A bare origin, such as `https://cdn.plot.ly`." },
      uses: {
        type: "array",
        items: { type: "string", enum: EXTRA_ORIGIN_USES },
        description: "What the page may load from it; `connect` lets it send requests there.",
      },
      reason: { type: "string", description: "Why the page needs it, as the publisher wrote it." },
    }),
  },
  Artifact: {
    description:
      "A folder of files with `index.html`, such as a prototype or dashboard, published by a User or an Agent and served in isolation " +
      "on the Artifact hostname. It belongs to a Project or the Workspace; each publish is a new Version.",
    ...object(
      {
        id,
        title: { type: "string", description: "Its title, as its latest Version gave it." },
        projectKey: { ...nullable({ type: "string" }), description: "The Project it belongs to; null for the Workspace." },
        version: { type: "integer", description: "The latest Version's number, counting from 1." },
        protected: { type: "boolean", description: "Whether it is Protected: Agents may read it but not publish new Versions of it." },
        url: { type: "string", description: "Its address in Cronk, which always shows the latest Version." },
        versionUrl: { type: "string", description: "The address of its latest Version, which keeps showing that Version after later publishes." },
        frameUrl: {
          type: "string",
          description: "Where its latest Version is served on the Artifact hostname, for a sandboxed frame; signed for the caller and valid for 12 hours.",
        },
        publishedBy: { ...recordedActor, description: "Who published the latest Version." },
        sourceTicket: {
          ...nullable(object({ key: { type: "string" }, title: { type: "string" } })),
          description: "The Ticket the latest Version came from: the one whose Claim the publishing Agent Session held.",
        },
        extraOrigins: {
          type: "array",
          items: { $ref: "ExtraOrigin#" },
          description: "The extra origins the latest Version's publish declared; served with it only while the Workspace allows extra origins.",
        },
        createdAt: timestamp,
        updatedAt: { ...timestamp, description: "When its latest Version was published." },
        versions: { type: "array", items: { $ref: "ArtifactVersion#" }, description: "Its Versions, newest first; only when one Artifact is asked for." },
      },
      ["frameUrl", "versions"],
    ),
  },
  StaleArtifact: {
    description: "A publish refused for being based on a Version that is no longer the latest; merge with the latest and publish again.",
    ...object({ error: { type: "string" }, version: { type: "integer", description: "The latest Version's number." } }),
  },
  ArtifactVersion: {
    description: "One publish of an Artifact: the whole folder as it was then.",
    ...object(
      {
        number: { type: "integer", description: "Counts from 1." },
        title: { type: "string" },
        at: timestamp,
        actor: { ...recordedActor, description: "Who published it, with the Agent Session if an Agent did." },
        sourceTicket: { ...nullable(object({ key: { type: "string" }, title: { type: "string" } })), description: "The Ticket it came from, if any." },
        fileCount: { type: "integer", description: "How many files it holds." },
        size: { type: "integer", description: "How many bytes its files take." },
        extraOrigins: {
          type: "array",
          items: { $ref: "ExtraOrigin#" },
          description: "The extra origins its publish declared, never carried over from an earlier Version; served with it only while the Workspace allows extra origins.",
        },
        url: { type: "string", description: "Its address in Cronk." },
        frameUrl: { type: "string", description: "Where it is served on the Artifact hostname, signed for the caller and valid for 12 hours; only when one Version is asked for." },
        files: {
          type: "array",
          items: object({ path: { type: "string" }, contentType: { type: "string" }, size: { type: "integer" } }),
          description: "Its files by path; only when one Version is asked for.",
        },
      },
      ["frameUrl", "files"],
    ),
  },
  Transcript: {
    description:
      "The verbatim chat that led an Agent to change things, uploaded from the client side and linked by the Agent's own Agent Session ids found in it, " +
      "and so to everything those Sessions changed.",
    ...object({
      ...transcriptFields,
      markdown: {
        type: "string",
        description:
          "The text of the latest upload, in the turn convention (Markdown), with known secrets scrubbed (best-effort) and its Owner's hand redactions applied.",
      },
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
  Suggestion: {
    description:
      "A new Version of a Protected Document, Term or Decision, or of Guidance, or a new Document under a protected branch, that an Agent proposes (ADR 0014): " +
      "the item's whole new content, the Version it " +
      "started from and the Agent's reasoning. It takes effect only when a User accepts it: unchanged, as the item's next Version credited to the Agent; " +
      "edited first, credited to the User and linked to the Suggestion. Rejecting it needs a reason, which reaches the Agent as Waiting Work.",
    ...object({
      id,
      item: {
        description: "The item it would change, as it stands now.",
        ...object({
          kind: { type: "string", enum: SUGGESTION_KINDS },
          id: { ...nullable(id), description: "The Document's, Term's or Decision's id; null for Guidance, and for a new Document until it is accepted." },
          key: { ...nullable({ type: "string" }), description: "A Decision's key; null for the other kinds." },
          title: { type: "string", description: "A Document's or Decision's title (a new Document's as suggested), a Term's name, or `Guidance`." },
          status: { ...nullable(decisionStatus), description: "A Decision's status; null for the other kinds." },
          projectId: { ...nullable(id), description: "Null for a Workspace item." },
          projectKey: { ...nullable({ type: "string" }), description: "Null for a Workspace item." },
          protected: { type: "boolean", description: protectedDescription("it is marked Protected (Guidance always is)") },
          version: { type: "integer", description: "Its current Version; 0 for a new Document until it is accepted." },
        }),
      },
      baseVersion: { type: "integer", description: "The Version of the item the Suggestion started from." },
      base: { ...suggestedContent, description: "What the item held at the base Version, in the same shape as `content`." },
      content: suggestedContent,
      reasoning: { type: "string", description: "Why the Agent suggests the change, in Markdown." },
      parent: {
        ...nullable(object({ id, title: { type: "string" } })),
        description:
          "For a Suggestion of a new Document under a protected branch (`baseVersion` 0, `item.id` null until accepted): the Document it goes under; " +
          "once accepted, the one the new Document sits under now, null at the top. Null for a Suggestion changing an existing item.",
      },
      proposedBy: { ...recordedActor, description: "The Agent that made it, with its Owner and Agent Session." },
      at: timestamp,
      sourceTicket: { ...nullable(ticketName), description: "The Ticket whose Claim the Agent held when making it; null for none." },
      reviewer: {
        ...nullable(named),
        description:
          "The User whose Inbox it is in: on a Project item, the source Ticket's Assignee, else the Agent's Owner; null when it is in Triage, as on a Workspace item.",
      },
      state: { type: "string", enum: SUGGESTION_STATES },
      outdated: { type: "boolean", description: "True while it is open and the item has a newer Version than its base; accepting it then needs a merge." },
      acceptedWithEdits: { ...nullable({ type: "boolean" }), description: "Whether the User changed it before accepting it; null unless accepted." },
      resultVersion: { ...nullable({ type: "integer" }), description: "The Version of the item accepting it made; null unless accepted." },
      decidedBy: { ...nullable(named), description: "The User who accepted or rejected it." },
      decidedAt: nullable(timestamp),
      reason: { ...nullable({ type: "string" }), description: "Why it was rejected; null unless rejected." },
    }),
  },
  SearchResult: {
    description: "One thing a search found, with an excerpt of its text around the match.",
    ...object({
      kind: { type: "string", enum: SEARCH_KINDS, description: "A Ticket, a Document in a page tree, a Report, a Comment, or a Term." },
      title: { type: "string", description: "The title of the Ticket or Document; for a Comment, of the Ticket or Document it is on; for a Term, its name." },
      excerpt: { type: "string", description: "The text around the match, as written (Markdown), without markers around the matching words." },
      projectKey: { ...nullable({ type: "string" }), description: "Null for something in the Workspace outside any Project." },
      ticketKey: { ...nullable({ type: "string" }), description: "The Ticket; a Report's or a Comment's Ticket; otherwise null." },
      documentId: { ...nullable(id), description: "The Document or Report; a Comment's Document; otherwise null." },
      termId: { ...nullable(id), description: "The Term; otherwise null." },
      protected: {
        ...nullable({ type: "boolean" }),
        description: `${protectedDescription(
          "a Document, or one above it, is marked Protected; a Report or Term is marked itself",
        )} Null for a Ticket or Comment.`,
      },
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
/** A Comment's id. */
export const commentIdParam = { type: "string", format: "uuid", description: "The Comment's id." } as const;

/** An Artifact's id. */
export const artifactIdParam = { type: "string", format: "uuid", description: "The Artifact's id." } as const;

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
