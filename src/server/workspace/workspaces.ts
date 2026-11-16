import type { Queryable } from "../db/database.js";
import type { AgentAccess } from "../identity/access.js";

export interface Workspace {
  id: string;
  name: string;
  /** The most Agents may do in the Workspace outside any Project. */
  agentAccess: AgentAccess;
  /** How long an Agent Session may stay silent before it ends and its Claims lapse. */
  silenceThresholdSeconds: number;
  /** The largest file an Attachment may be, in bytes. */
  attachmentMaxBytes: number;
}

/** The shape of the Workspace the API returns. */
export const publicWorkspace = (w: Workspace) => ({
  name: w.name,
  agentAccess: w.agentAccess,
  silenceThresholdSeconds: w.silenceThresholdSeconds,
  attachmentMaxBytes: w.attachmentMaxBytes,
});

interface WorkspaceRow {
  id: string;
  name: string;
  agent_access: AgentAccess;
  silence_threshold_seconds: number;
  attachment_max_bytes: string;
}

const toWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  name: row.name,
  agentAccess: row.agent_access,
  silenceThresholdSeconds: row.silence_threshold_seconds,
  attachmentMaxBytes: Number(row.attachment_max_bytes),
});

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

/** Renames the Workspace and/or changes its Agent Access, silence threshold or Attachment size limit. */
export async function updateWorkspace(
  db: Queryable,
  id: string,
  changes: { name?: string; agentAccess?: AgentAccess; silenceThresholdSeconds?: number; attachmentMaxBytes?: number },
): Promise<Workspace> {
  const { rows } = await db.query<WorkspaceRow>(
    `UPDATE workspaces SET name = coalesce($2, name), agent_access = coalesce($3, agent_access),
       silence_threshold_seconds = coalesce($4, silence_threshold_seconds), attachment_max_bytes = coalesce($5, attachment_max_bytes)
     WHERE id = $1 RETURNING *`,
    [id, changes.name ?? null, changes.agentAccess ?? null, changes.silenceThresholdSeconds ?? null, changes.attachmentMaxBytes ?? null],
  );
  return toWorkspace(rows[0]!);
}
