import type { Queryable } from "../db/database.js";

/**
 * Guidance: standing instructions Users write for Agents, for the Workspace or one Project.
 * Every save is a new Version recording who made it; the highest Version is current.
 */

/** Whose Guidance: the Workspace's, or one of its Projects'. */
export interface GuidanceOwner {
  workspaceId: string;
  /** Null for the Workspace's own Guidance. */
  projectId: string | null;
}

/** Guidance as it stands: its Markdown and current Version, 0 (and empty) before anyone writes it. */
export interface Guidance {
  markdown: string;
  version: number;
}

const NONE: Guidance = { markdown: "", version: 0 };

/** The current Guidance of `owner`. */
export async function getGuidance(db: Queryable, owner: GuidanceOwner): Promise<Guidance> {
  const { rows } = await db.query<Guidance>(
    `SELECT markdown, version FROM guidance_versions
     WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY version DESC LIMIT 1`,
    [owner.workspaceId, owner.projectId],
  );
  return rows[0] ?? NONE;
}

/**
 * Saves `markdown` as the next Version of `owner`'s Guidance, if `baseVersion` is still the
 * current one; otherwise changes nothing and returns undefined.
 */
export async function writeGuidance(
  db: Queryable,
  owner: GuidanceOwner,
  input: { markdown: string; baseVersion: number; userId: string; now: Date },
): Promise<Guidance | undefined> {
  // Two saves on the same base both try to add the same Version; the unique index lets only one in.
  const { rows } = await db.query<Guidance>(
    `INSERT INTO guidance_versions (workspace_id, project_id, version, markdown, at, actor_user_id)
     SELECT $1, $2, $3::integer + 1, $4, $5, $6
     WHERE (SELECT coalesce(max(version), 0) FROM guidance_versions WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2) = $3
     ON CONFLICT DO NOTHING
     RETURNING markdown, version`,
    [owner.workspaceId, owner.projectId, input.baseVersion, input.markdown, input.now, input.userId],
  );
  return rows[0];
}

/** One saved state of Guidance, with the User who saved it and when. */
export interface GuidanceVersion extends Guidance {
  at: Date;
  actor: { kind: "user"; id: string; name: string };
}

/** Every Version of `owner`'s Guidance, oldest first. */
export async function listGuidanceVersions(db: Queryable, owner: GuidanceOwner): Promise<GuidanceVersion[]> {
  const { rows } = await db.query<Guidance & { at: Date; user_id: string; user_name: string }>(
    `SELECT g.version, g.markdown, g.at, u.id AS user_id, u.name AS user_name
     FROM guidance_versions g JOIN users u ON u.id = g.actor_user_id
     WHERE g.workspace_id = $1 AND g.project_id IS NOT DISTINCT FROM $2 ORDER BY g.version`,
    [owner.workspaceId, owner.projectId],
  );
  return rows.map((r) => ({ version: r.version, markdown: r.markdown, at: r.at, actor: { kind: "user", id: r.user_id, name: r.user_name } }));
}

/** The current Markdown of each of these Projects' Guidance, empty for one nobody has written. */
export async function projectGuidanceMarkdown(db: Queryable, projectIds: string[]): Promise<Map<string, string>> {
  const { rows } = await db.query<{ project_id: string; markdown: string }>(
    `SELECT DISTINCT ON (project_id) project_id, markdown FROM guidance_versions
     WHERE project_id = ANY($1::uuid[]) ORDER BY project_id, version DESC`,
    [projectIds],
  );
  const found = new Map(rows.map((r) => [r.project_id, r.markdown]));
  return new Map(projectIds.map((id) => [id, found.get(id) ?? ""]));
}
