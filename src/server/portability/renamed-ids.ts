import type { Queryable } from "../db/database.js";

/**
 * The Agents and Agent Sessions an import couldn't give the id they had in the export, because
 * the id was taken here, so that something naming the old id (a Transcript's text) still finds them.
 */

/** An Agent or Agent Session an import gave a new id: `from`, its id in the export, became `to`. */
export interface RenamedId {
  kind: "agent" | "agentSession";
  from: string;
  to: string;
  at: Date;
}

/** Each kind as the `kind` column stores it. */
const KIND_COLUMN = { agent: "agent", agentSession: "agent_session" } as const;
const KIND_OF_COLUMN = Object.fromEntries(Object.entries(KIND_COLUMN).map(([kind, column]) => [column, kind])) as Record<string, RenamedId["kind"]>;

/** Records that `renamed.from` is `renamed.to` in the Workspace `workspaceId` now. */
export async function recordRenamedId(db: Queryable, workspaceId: string, renamed: RenamedId): Promise<void> {
  await db.query("INSERT INTO renamed_ids (workspace_id, kind, from_id, to_id, at) VALUES ($1, $2, $3, $4, $5)", [
    workspaceId,
    KIND_COLUMN[renamed.kind],
    renamed.from,
    renamed.to,
    renamed.at,
  ]);
}

/** Every id the Workspace's imports renamed, in the order they did. */
export async function listRenamedIds(db: Queryable, workspaceId: string): Promise<RenamedId[]> {
  const { rows } = await db.query<{ kind: string; from_id: string; to_id: string; at: Date }>(
    "SELECT kind, from_id, to_id, at FROM renamed_ids WHERE workspace_id = $1 ORDER BY seq",
    [workspaceId],
  );
  return rows.map((r) => ({ kind: KIND_OF_COLUMN[r.kind]!, from: r.from_id, to: r.to_id, at: r.at }));
}
