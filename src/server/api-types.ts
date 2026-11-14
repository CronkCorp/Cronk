/**
 * The shapes the HTTP API sends and accepts, as they look on the wire. The web
 * client imports these with `import type`, so a change to a response shows up
 * there as a type error. Types only: nothing here may reach the web bundle.
 */
import type { publicAgentSession } from "./coordination/agent-sessions.js";
import type { welcome } from "./coordination/routes.js";
import type { AgentToken as StoredAgentToken, issueAgentToken, publicAgent } from "./identity/agents.js";
import type { Access } from "./identity/access.js";
import type { publicInvitation } from "./identity/invitations.js";
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
import type { Document as StoredDocument, TreeEntry, Version as StoredVersion } from "./knowledge/documents.js";

export type { Access, AgentAccess } from "./identity/access.js";
export type { Role } from "./identity/users.js";
export type { Status, Visibility } from "./work/projects.js";
export type { TicketChanges } from "./work/tickets.js";
export type { Priority, RelationKind, StatusCategory } from "../shared/values.js";
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
/** An Agent, with its live Agent Sessions oldest first as the Agents list returns them. */
export type Agent = Serialized<ReturnType<typeof publicAgent>> & { sessions: AgentSession[] };
/** What an Agent is told when its Agent Session starts. */
export type Welcome = Serialized<Awaited<ReturnType<typeof welcome>>>;
export type AgentToken = Serialized<StoredAgentToken>;
/** A newly issued Agent token with its secret, which the API returns only this once. */
export type IssuedAgentToken = Serialized<Awaited<ReturnType<typeof issueAgentToken>>>;
export type Invitation = Serialized<ReturnType<typeof publicInvitation>>;
export type Workspace = Serialized<ReturnType<typeof publicWorkspace>>;

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

/** A Ticket with the Tickets around it, as its page shows it. */
export interface TicketDetail {
  ticket: Ticket;
  subTickets: TicketRef[];
  relations: Relations;
}

export type RecordedChange = Serialized<StoredRecordedChange>;

/** A Document at its current Version. */
export type Document = Serialized<StoredDocument>;
/** One saved state of a Document. */
export type Version = Serialized<StoredVersion>;
/** A Version without its body, as a Document's Version list shows it. */
export type VersionSummary = Omit<Version, "body">;
/** A Document as its page tree lists it. */
export type DocumentTreeEntry = TreeEntry;
