import type { Queryable } from "../db/database.js";
import { hashToken, newToken } from "./tokens.js";
import { findUserById, type User } from "./users.js";

/** A non-human account acting in Cronk for exactly one User, its Owner. */
export interface Agent {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  createdAt: Date;
}

interface AgentRow {
  id: string;
  workspace_id: string;
  owner_id: string;
  name: string;
  created_at: Date;
}

const toAgent = (row: AgentRow): Agent => ({
  id: row.id,
  workspaceId: row.workspace_id,
  ownerId: row.owner_id,
  name: row.name,
  createdAt: row.created_at,
});

/** The shape of an Agent the API returns. */
export const publicAgent = (agent: Agent, owner: User) => ({
  id: agent.id,
  name: agent.name,
  owner: { id: owner.id, name: owner.name },
  createdAt: agent.createdAt,
});

/** Registers an Agent for `owner`, or returns undefined if they already have one by that name. */
export async function insertAgent(db: Queryable, input: { owner: User; name: string; now: Date }): Promise<Agent | undefined> {
  const { rows } = await db.query<AgentRow>(
    `INSERT INTO agents (workspace_id, owner_id, name, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_id, lower(name)) WHERE removed_at IS NULL DO NOTHING RETURNING *`,
    [input.owner.workspaceId, input.owner.id, input.name, input.now],
  );
  return rows[0] && toAgent(rows[0]);
}

/** An Agent that hasn't been removed. */
export async function findAgent(db: Queryable, workspaceId: string, id: string): Promise<Agent | undefined> {
  const { rows } = await db.query<AgentRow>("SELECT * FROM agents WHERE workspace_id = $1 AND id = $2 AND removed_at IS NULL", [
    workspaceId,
    id,
  ]);
  return rows[0] && toAgent(rows[0]);
}

/** The Agents of one Owner, or with no Owner every Agent in the Workspace, each with its Owner, by Owner then name. */
export async function listAgents(db: Queryable, workspaceId: string, ownerId?: string): Promise<{ agent: Agent; owner: User }[]> {
  const { rows } = await db.query<AgentRow>(
    `SELECT a.* FROM agents a JOIN users u ON u.id = a.owner_id
     WHERE a.workspace_id = $1 AND a.removed_at IS NULL AND ($2::uuid IS NULL OR a.owner_id = $2)
     ORDER BY lower(u.name), lower(a.name)`,
    [workspaceId, ownerId ?? null],
  );
  const agents = rows.map(toAgent);
  const owners = await Promise.all(agents.map((a) => findUserById(db, a.ownerId)));
  return agents.map((agent, i) => ({ agent, owner: owners[i]! }));
}

/** Renames an Agent. Throws a unique violation if its Owner already has another by that name. */
export async function renameAgent(db: Queryable, agent: Agent, name: string): Promise<Agent> {
  const { rows } = await db.query<AgentRow>("UPDATE agents SET name = $2 WHERE id = $1 RETURNING *", [agent.id, name]);
  return toAgent(rows[0]!);
}

/** Removes an Agent and revokes its tokens. Its row stays so history keeps naming it. */
export async function removeAgent(db: Queryable, agent: Agent, now: Date): Promise<void> {
  await db.query("UPDATE agents SET removed_at = $2 WHERE id = $1", [agent.id, now]);
  await db.query("DELETE FROM agent_tokens WHERE agent_id = $1", [agent.id]);
}

/** A token an Agent calls the API with. A read-only token is refused every write. */
export interface AgentToken {
  id: string;
  readOnly: boolean;
  createdAt: Date;
}

interface AgentTokenRow {
  id: string;
  read_only: boolean;
  created_at: Date;
}

const toAgentToken = (row: AgentTokenRow): AgentToken => ({ id: row.id, readOnly: row.read_only, createdAt: row.created_at });

/** Issues a token for an Agent and returns it with its secret. Only the secret's hash is stored. */
export async function issueAgentToken(
  db: Queryable,
  input: { agent: Agent; readOnly: boolean; now: Date },
): Promise<{ token: AgentToken; secret: string }> {
  const secret = newToken();
  const { rows } = await db.query<AgentTokenRow>(
    "INSERT INTO agent_tokens (agent_id, token_hash, read_only, created_at) VALUES ($1, $2, $3, $4) RETURNING *",
    [input.agent.id, hashToken(secret), input.readOnly, input.now],
  );
  return { token: toAgentToken(rows[0]!), secret };
}

/** An Agent's tokens, oldest first. */
export async function listAgentTokens(db: Queryable, agent: Agent): Promise<AgentToken[]> {
  const { rows } = await db.query<AgentTokenRow>("SELECT * FROM agent_tokens WHERE agent_id = $1 ORDER BY created_at, id", [agent.id]);
  return rows.map(toAgentToken);
}

/** Revokes one of an Agent's tokens; returns whether there was one. */
export async function revokeAgentToken(db: Queryable, agent: Agent, tokenId: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM agent_tokens WHERE agent_id = $1 AND id = $2", [agent.id, tokenId]);
  return (rowCount ?? 0) > 0;
}

/**
 * The Agent a token secret belongs to, with its Owner and whether the token is read-only.
 * Undefined if the token is unknown or revoked, or the Agent was removed or its Owner deactivated.
 */
export async function agentForToken(
  db: Queryable,
  secret: string,
): Promise<{ agent: Agent; owner: User; readOnly: boolean } | undefined> {
  const { rows } = await db.query<AgentRow & { read_only: boolean }>(
    `SELECT a.*, t.read_only FROM agent_tokens t JOIN agents a ON a.id = t.agent_id
     WHERE t.token_hash = $1 AND a.removed_at IS NULL`,
    [hashToken(secret)],
  );
  const row = rows[0];
  const owner = row && (await findUserById(db, row.owner_id));
  if (!row || !owner?.active) return undefined;
  return { agent: toAgent(row), owner, readOnly: row.read_only };
}
