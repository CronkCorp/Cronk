import type { Agent } from "./identity/agents.js";
import type { User } from "./identity/users.js";

/**
 * Whoever performed an action: a User, or an Agent acting for its Owner through
 * one of its tokens. (Agent Sessions join the Agent case when they arrive.)
 */
export type Actor = { kind: "user"; user: User } | { kind: "agent"; agent: Agent; owner: User; readOnly: boolean };

export const userActor = (user: User): Actor => ({ kind: "user", user });

/** The User an Actor is or acts for. */
export const actingUser = (actor: Actor): User => (actor.kind === "user" ? actor.user : actor.owner);
