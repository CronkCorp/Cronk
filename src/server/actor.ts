import type { AgentSession } from "./coordination/agent-sessions.js";
import type { Agent } from "./identity/agents.js";
import type { User } from "./identity/users.js";

/**
 * Whoever performed an action: a User, or an Agent acting for its Owner through
 * one of its tokens, possibly within one of its Agent Sessions.
 */
export type Actor = { kind: "user"; user: User } | AgentActor;

/** An Agent calling through one of its tokens, with the Owner it acts for and the Agent Session it calls in, if any. */
export type AgentActor = { kind: "agent"; session: AgentSession | null } & AgentCredential;

/** What an Agent token stands for: the Agent, its Owner, and whether the token is read-only. */
export interface AgentCredential {
  /** The token's id. */
  tokenId: string;
  agent: Agent;
  owner: User;
  readOnly: boolean;
}

export const userActor = (user: User): Actor => ({ kind: "user", user });

/** The User an Actor is or acts for. */
export const actingUser = (actor: Actor): User => (actor.kind === "user" ? actor.user : actor.owner);

/** Who did something, as history records it: a User, or an Agent with the Owner it acted for and the Agent Session it was in, if any. */
export type RecordedActor =
  | { kind: "user"; id: string; name: string }
  | { kind: "agent"; id: string; name: string; owner: { id: string; name: string }; session: { id: string } | null };

/** Cronk itself, as the recorded actor of a change no one made, such as one an upgrade makes. Only Ticket history records it. */
export type SystemActor = { kind: "system" };

/** Who made a Ticket change: a User, an Agent, or Cronk itself (see `SystemActor`). */
export type ChangeActor = RecordedActor | SystemActor;

/**
 * An Actor as a history row stores it, by id: the acting User (an Agent's Owner), and the Agent and
 * Agent Session if an Agent acted. An import records history this way, for Actors not calling now.
 */
export interface StoredActor {
  kind: Actor["kind"];
  userId: string;
  agentId: string | null;
  sessionId: string | null;
}

/** The values a history row stores for its Actor: `actor_kind`, `actor_user_id` (the Owner, for an Agent), `actor_agent_id`, `actor_session_id`. */
export function actorColumns(actor: Actor | StoredActor): [kind: Actor["kind"], userId: string, agentId: string | null, sessionId: string | null] {
  if ("userId" in actor) return [actor.kind, actor.userId, actor.agentId, actor.sessionId];
  const agent = actor.kind === "agent" ? actor : undefined;
  return [actor.kind, actingUser(actor).id, agent?.agent.id ?? null, agent?.session?.id ?? null];
}

/** The columns a history query selects for its Actor, joining `users u` on the acting User and `agents a` on the Agent. */
export interface RecordedActorRow {
  user_id: string;
  user_name: string;
  agent_id: string | null;
  agent_name: string | null;
  session_id: string | null;
}

/** Who a Ticket change's row records: Cronk itself where it has no acting User, otherwise as `toRecordedActor`. */
export function toChangeActor(row: Omit<RecordedActorRow, "user_id" | "user_name"> & { user_id: string | null; user_name: string | null }): ChangeActor {
  return row.user_id === null ? { kind: "system" } : toRecordedActor(row as RecordedActorRow);
}

/** The Actor a history row records, from the columns `RecordedActorRow` names. */
export function toRecordedActor(row: RecordedActorRow): RecordedActor {
  const user = { id: row.user_id, name: row.user_name };
  if (row.agent_id === null) return { kind: "user", ...user };
  const session = row.session_id === null ? null : { id: row.session_id };
  return { kind: "agent", id: row.agent_id, name: row.agent_name!, owner: user, session };
}
