/** JSON schemas for request fields used by more than one route. */

/** A display name: non-blank, at most 200 characters. Routes trim it before storing. */
export const nameSchema = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } as const;

/** Agent Access: the most Agents may do in a Project or the Workspace. */
export const agentAccessSchema = { type: "string", enum: ["none", "read", "write"] } as const;
