import type { Queryable } from "../db/database.js";
import type { AgentAccess } from "../identity/access.js";

export interface Workspace {
  id: string;
  name: string;
  /** The most Agents may do in the Workspace outside any Project. */
  agentAccess: AgentAccess;
}

/** The shape of the Workspace the API returns. */
export const publicWorkspace = (w: Workspace) => ({ name: w.name, agentAccess: w.agentAccess });

interface WorkspaceRow {
  id: string;
  name: string;
  agent_access: AgentAccess;
}

const toWorkspace = (row: WorkspaceRow): Workspace => ({ id: row.id, name: row.name, agentAccess: row.agent_access });

export async function insertWorkspace(db: Queryable, input: { name: string; now: Date }): Promise<Workspace> {
  const { rows } = await db.query<WorkspaceRow>("INSERT INTO workspaces (name, created_at) VALUES ($1, $2) RETURNING *", [
    input.name,
    input.now,
  ]);
  return toWorkspace(rows[0]!);
}

export async function getWorkspace(db: Queryable, id: string): Promise<Workspace> {
  const { rows } = await db.query<WorkspaceRow>("SELECT * FROM workspaces WHERE id = $1", [id]);
  return toWorkspace(rows[0]!);
}

/** Renames the Workspace and/or changes its Agent Access. */
export async function updateWorkspace(db: Queryable, id: string, changes: { name?: string; agentAccess?: AgentAccess }): Promise<Workspace> {
  const { rows } = await db.query<WorkspaceRow>(
    "UPDATE workspaces SET name = coalesce($2, name), agent_access = coalesce($3, agent_access) WHERE id = $1 RETURNING *",
    [id, changes.name ?? null, changes.agentAccess ?? null],
  );
  return toWorkspace(rows[0]!);
}
