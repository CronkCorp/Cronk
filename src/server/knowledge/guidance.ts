import { actorColumns, toRecordedActor, type Actor, type RecordedActor, type RecordedActorRow, type StoredActor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { versionSuggestions, type VersionSuggestion } from "./version-suggestions.js";

/**
 * Guidance: standing instructions Users write for Agents, for the Workspace or one Project.
 * Every save is a new Version recording who made it: a User, or an Agent whose Suggestion a User
 * accepted unchanged. The highest Version is current.
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
  input: { markdown: string; baseVersion: number; actor: Actor | StoredActor; now: Date },
): Promise<Guidance | undefined> {
  // Two saves on the same base both try to add the same Version; the unique index lets only one in.
  const { rows } = await db.query<Guidance>(
    `INSERT INTO guidance_versions (workspace_id, project_id, version, markdown, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id)
     SELECT $1, $2, $3::integer + 1, $4, $5, $6, $7, $8, $9
     WHERE (SELECT coalesce(max(version), 0) FROM guidance_versions WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2) = $3
     ON CONFLICT DO NOTHING
     RETURNING markdown, version`,
    [owner.workspaceId, owner.projectId, input.baseVersion, input.markdown, input.now, ...actorColumns(input.actor)],
  );
  return rows[0];
}

/** One saved state of Guidance, with the Actor who saved it and when. */
export interface GuidanceVersion extends Guidance {
  at: Date;
  actor: RecordedActor;
  /** The Suggestion a User accepted to make it, unchanged or edited; null for a Version saved otherwise. */
  suggestion: VersionSuggestion | null;
}

/** The Markdown `owner`'s Guidance had at `version`: empty at 0, undefined for a Version not saved yet. */
export async function guidanceAt(db: Queryable, owner: GuidanceOwner, version: number): Promise<string | undefined> {
  if (version === 0) return "";
  const { rows } = await db.query<{ markdown: string }>(
    "SELECT markdown FROM guidance_versions WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND version = $3",
    [owner.workspaceId, owner.projectId, version],
  );
  return rows[0]?.markdown;
}

/** Every Version of `owner`'s Guidance, oldest first. */
export async function listGuidanceVersions(db: Queryable, owner: GuidanceOwner): Promise<GuidanceVersion[]> {
  const { rows } = await db.query<Guidance & RecordedActorRow & { at: Date }>(
    `SELECT g.version, g.markdown, g.at, u.id AS user_id, u.name AS user_name, a.id AS agent_id, a.name AS agent_name, g.actor_session_id AS session_id
     FROM guidance_versions g JOIN users u ON u.id = g.actor_user_id LEFT JOIN agents a ON a.id = g.actor_agent_id
     WHERE g.workspace_id = $1 AND g.project_id IS NOT DISTINCT FROM $2 ORDER BY g.version`,
    [owner.workspaceId, owner.projectId],
  );
  const suggestions = await versionSuggestions(db, { kind: "guidance", ...owner });
  return rows.map((r) => ({ version: r.version, markdown: r.markdown, at: r.at, actor: toRecordedActor(r), suggestion: suggestions.get(r.version) ?? null }));
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
