/**
 * The shapes the HTTP API sends and accepts, as they look on the wire. The web
 * client imports these with `import type`, so a change to a response shows up
 * there as a type error. Types only: nothing here may reach the web bundle.
 */
import type { publicAgentSession } from "./coordination/agent-sessions.js";
import type { publicActivity } from "./coordination/activities.js";
import type { publicComment } from "./conversation/comments.js";
import type { WaitingWork as StoredWaitingWork } from "./coordination/waiting-work.js";
import type { Claim as StoredClaim } from "./coordination/claims.js";
import type { welcome } from "./coordination/routes.js";
import type { AgentToken as StoredAgentToken, issueAgentToken, publicAgent } from "./identity/agents.js";
import type { Access } from "./identity/access.js";
import type { publicInvitation } from "./identity/invitations.js";
import type { Guidance as StoredGuidance, GuidanceVersion as StoredGuidanceVersion } from "./knowledge/guidance.js";
import type { publicUser } from "./identity/users.js";
import type { Project as StoredProject } from "./work/projects.js";
import type { Relations as StoredRelations } from "./work/relations.js";
import type {
  RecordedActor,
  RecordedChange as StoredRecordedChange,
  Ticket as StoredTicket,
  TicketName,
  TicketRef,
  UserRef,
} from "./work/tickets.js";
import type { publicWorkspace } from "./workspace/workspaces.js";
import type { Document as StoredDocument, LinkedDocument as StoredLinkedDocument, TreeEntry, Version as StoredVersion } from "./knowledge/documents.js";
import type { MarkdownMerge, Merge as StoredMerge } from "./knowledge/sections.js";
import type { Report as StoredReport } from "./knowledge/reports.js";
import type { AvoidedWord } from "./knowledge/avoided-words.js";
import type { SearchResult } from "./search/search.js";
import type { Term as StoredTerm, TermVersion as StoredTermVersion } from "./knowledge/terms.js";
import type { AgentRecordEntry as StoredAgentRecordEntry } from "./coordination/agent-record.js";
import type { QuestionItem, ReviewItem, UnverifiedItem } from "./inbox/inbox.js";
import type {
  Decision as StoredDecision,
  DecisionSummary as StoredDecisionSummary,
  DecisionVersion as StoredDecisionVersion,
} from "./knowledge/decisions.js";

export type { Access, AgentAccess } from "./identity/access.js";
export type { Role } from "./identity/users.js";
export type { Status, Visibility } from "./work/projects.js";
export type { TicketChanges } from "./work/tickets.js";
export type { ActivityKind, DecisionStatus, Priority, RelationKind, SearchKind, StatusCategory, Verification } from "../shared/values.js";
export type { SearchResult };
export type { RecordedActor, TicketName, TicketRef, UserRef };

/** A value as JSON carries it: `Date`s arrive as ISO strings. */
export type Serialized<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;

export type User = Serialized<ReturnType<typeof publicUser>>;
/** One continuous connection of an Agent, from connect to disconnect. */
export type AgentSession = Serialized<ReturnType<typeof publicAgentSession>>;
/** A Ticket a live Agent Session holds the Claim on, as the Agents list shows it. */
export interface ClaimedTicket {
  ticketKey: string;
  title: string;
}
/** An Agent, with its live Agent Sessions oldest first and their Claims, as the Agents list returns them. */
export type Agent = Serialized<ReturnType<typeof publicAgent>> & {
  sessions: (AgentSession & { claims: ClaimedTicket[] })[];
  /** When its last Agent Session that is no longer live ended or fell silent; null if it has had none. */
  lastSessionEndedAt: string | null;
  /** How many unfinished Tickets it is Delegate on that the caller can read. */
  delegateTicketCount: number;
};
/** What an Agent is told when its Agent Session starts. */
export type Welcome = Serialized<Awaited<ReturnType<typeof welcome>>>;
export type AgentToken = Serialized<StoredAgentToken>;
/** A newly issued Agent token with its secret, which the API returns only this once. */
export type IssuedAgentToken = Serialized<Awaited<ReturnType<typeof issueAgentToken>>>;
export type Invitation = Serialized<ReturnType<typeof publicInvitation>>;
export type Workspace = Serialized<ReturnType<typeof publicWorkspace>>;
/** Standing instructions Users write for Agents: its Markdown and current Version (0 before anyone writes it). */
export type Guidance = Serialized<StoredGuidance>;
/** One saved state of Guidance, with the User who saved it and when. */
export type GuidanceVersion = Serialized<StoredGuidanceVersion>;

/** A Project member: a User and what they may do in the Project. */
export interface Member {
  user: User;
  access: Access;
}

export type Project = Serialized<StoredProject> & {
  /** What the signed-in User may do in the Project. */
  access: Access;
};

export type Ticket = Serialized<StoredTicket>;
export type Relations = Serialized<StoredRelations>;

/** An Agent Session's hold on a Ticket. */
export type Claim = Serialized<StoredClaim>;

/** A Document linked to a Ticket: one of its Reports, or a Document mentioning its key. */
export type LinkedDocument = Serialized<StoredLinkedDocument>;

/** A Ticket with the Tickets and Documents around it and its live Claim, as its page shows it. */
export interface TicketDetail {
  ticket: Ticket;
  subTickets: TicketRef[];
  relations: Relations;
  documents: LinkedDocument[];
  claim: Claim | null;
}

export type RecordedChange = Serialized<StoredRecordedChange>;

/** One timestamped entry an Agent Session wrote on a Ticket while holding its Claim. */
export type Activity = Serialized<ReturnType<typeof publicActivity>>;

/** A message an Actor posted on a Ticket or a Document. */
export type Comment = Serialized<ReturnType<typeof publicComment>>;

/** One entry in an Agent's record: a Change, an Activity, a Comment or a saved Version. */
export type AgentRecordEntry = Serialized<StoredAgentRecordEntry>;

/** A Comment waiting for an Agent, with why and what it is on. */
export type WaitingWork = Serialized<StoredWaitingWork>;

/** A Document at its current Version. */
export type Document = Serialized<StoredDocument>;
/** One saved state of a Document. */
export type Version = Serialized<StoredVersion>;
/** A Term of the Workspace or a Project, with what overrides it or what it overrides. */
export type Term = Serialized<StoredTerm>;
/** One saved state of a Term, with the Actor who saved it. */
export type TermVersion = Serialized<StoredTermVersion>;
/** A Version without its body, as a Document's Version list shows it. */
export type VersionSummary = Omit<Version, "body">;
/** A Document as its page tree lists it. */
export type DocumentTreeEntry = TreeEntry;
/** A Report as its Ticket and Project list it, without its body; read it as a Document by its id. */
export type Report = Serialized<StoredReport>;
/** An edit merged section by section with the Version it is merged `onto`. */
export type Merge = StoredMerge & { onto: Version };
/** An edit of Guidance merged section by section with the Guidance it is merged `onto`. */
export type GuidanceMerge = MarkdownMerge & { onto: Guidance };
export type { Conflict, MergedSection } from "./knowledge/sections.js";

/** One item in a User's Inbox: a Ticket to review, an Unverified completion, or an open question of one of their Agents. */
export type InboxItem = Serialized<ReviewItem> | Serialized<UnverifiedItem> | (Serialized<Omit<QuestionItem, "question">> & { question: Activity });
export type InboxKind = InboxItem["kind"];

/** A word a Term says to avoid, found in what a save wrote, as every save of text answers them in `avoidedWords`. */
export type { AvoidedWord };
/** A recorded choice with its reasoning and status, at its current Version. */
export type Decision = Serialized<StoredDecision>;
/** A Decision as its register lists it, without its body. */
export type DecisionSummary = Serialized<StoredDecisionSummary>;
/** One saved state of a Decision. */
export type DecisionVersion = Serialized<StoredDecisionVersion>;
