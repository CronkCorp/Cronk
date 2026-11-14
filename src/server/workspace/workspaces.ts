import type { Queryable } from "../db/database.js";
import type { AgentAccess } from "../identity/access.js";

export interface Workspace {
  id: string;
  name: string;
  /** The most Agents may do in the Workspace outside any Project. */
  agentAccess: AgentAccess;
}

const COLUMNS = "id, name, agent_access AS \"agentAccess\"";

export async function insertWorkspace(db: Queryable, input: { name: string; now: Date }): Promise<Workspace> {
  const { rows } = await db.query<Workspace>(`INSERT INTO workspaces (name, created_at) VALUES ($1, $2) RETURNING ${COLUMNS}`, [
    input.name,
    input.now,
  ]);
  return rows[0]!;
}

export async function getWorkspace(db: Queryable, id: string): Promise<Workspace> {
  const { rows } = await db.query<Workspace>(`SELECT ${COLUMNS} FROM workspaces WHERE id = $1`, [id]);
  return rows[0]!;
}

/** Renames the Workspace and/or changes its Agent Access. */
export async function updateWorkspace(db: Queryable, id: string, changes: { name?: string; agentAccess?: AgentAccess }): Promise<Workspace> {
  const { rows } = await db.query<Workspace>(
    `UPDATE workspaces SET name = coalesce($2, name), agent_access = coalesce($3, agent_access) WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, changes.name ?? null, changes.agentAccess ?? null],
  );
  return rows[0]!;
}
