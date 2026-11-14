import type { Agent } from "./identity/agents.js";
import type { User } from "./identity/users.js";

/**
 * Whoever performed an action: a User, or an Agent acting for its Owner through
 * one of its tokens. (Agent Sessions join the Agent case when they arrive.)
 */
export type Actor = { kind: "user"; user: User } | AgentActor;

/** An Agent calling through one of its tokens, with the Owner it acts for. */
export type AgentActor = { kind: "agent" } & AgentCredential;

/** What an Agent token stands for: the Agent, its Owner, and whether the token is read-only. */
export interface AgentCredential {
  agent: Agent;
  owner: User;
  readOnly: boolean;
}

export const userActor = (user: User): Actor => ({ kind: "user", user });

/** The User an Actor is or acts for. */
export const actingUser = (actor: Actor): User => (actor.kind === "user" ? actor.user : actor.owner);
