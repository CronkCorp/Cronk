import type { User } from "./identity/users.js";

/**
 * Whoever performed an action. Only Users act so far; Agents (with their
 * Agent Session) join this union when they arrive.
 */
export type Actor = { kind: "user"; user: User };

export const userActor = (user: User): Actor => ({ kind: "user", user });
