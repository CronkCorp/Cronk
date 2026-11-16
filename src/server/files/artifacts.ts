import { actorColumns, toRecordedActor, type Actor, type RecordedActor, type RecordedActorRow, type StoredActor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { ticketKeySql } from "../work/tickets.js";

/**
 * Artifacts: folders of files with `index.html`, published by Users and Agents and served in isolation on the
 * Artifact hostname (ADR 0007). Each belongs to a Project or the Workspace, which decides who can read it. Every
 * publish adds a Version holding the whole folder; the rows are what Cronk knows of the files, whose bytes are
 * in the file store under `artifactFileKey(id)`.
 */
export interface Artifact {
  id: string;
  workspaceId: string;
  projectId: string | null;
  projectKey: string | null;
  title: string;
  /** The latest Version's number. */
  version: number;
  protected: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** The latest Version. */
  latest: ArtifactVersion;
}

/** One publish of an Artifact, without its files. */
export interface ArtifactVersion {
  number: number;
  title: string;
  at: Date;
  actor: RecordedActor;
  /** The Ticket it came from: the one whose Claim the publishing Agent Session held, or the one a User named. */
  sourceTicket: { key: string; title: string } | null;
  /** How many files it holds, and how many bytes they take. */
  files: number;
  size: number;
}

/** One file of a Version, by its path in the folder. */
export interface ArtifactFile {
  id: string;
  path: string;
  contentType: string;
  size: number;
}

/** Where an Artifact file's bytes are kept in the file store. */
export const artifactFileKey = (id: string) => `artifact-files/${id}`;

interface VersionRow extends RecordedActorRow {
  number: number;
  title: string;
  at: Date;
  source_ticket_key: string | null;
  source_ticket_title: string | null;
  files: number;
  size: string;
}

const VERSION_SELECT = `
  SELECT v.artifact_id, v.number, v.title, v.at, ${ticketKeySql("tp", "t")} AS source_ticket_key, t.title AS source_ticket_title,
    (SELECT count(*)::int FROM artifact_files f WHERE f.artifact_id = v.artifact_id AND f.version = v.number) AS files,
    (SELECT coalesce(sum(size), 0)::bigint FROM artifact_files f WHERE f.artifact_id = v.artifact_id AND f.version = v.number) AS size,
    u.id AS user_id, u.name AS user_name, a.id AS agent_id, a.name AS agent_name, v.actor_session_id AS session_id
  FROM artifact_versions v JOIN users u ON u.id = v.actor_user_id LEFT JOIN agents a ON a.id = v.actor_agent_id
    LEFT JOIN tickets t ON t.id = v.source_ticket_id LEFT JOIN projects tp ON tp.id = t.project_id`;

const toVersion = (row: VersionRow): ArtifactVersion => ({
  number: row.number,
  title: row.title,
  at: row.at,
  actor: toRecordedActor(row),
  sourceTicket: row.source_ticket_key === null ? null : { key: row.source_ticket_key, title: row.source_ticket_title! },
  files: row.files,
  size: Number(row.size),
});

interface ArtifactRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  project_key: string | null;
  title: string;
  version: number;
  protected: boolean;
  created_at: Date;
  updated_at: Date;
}

const ARTIFACT_SELECT = `SELECT x.*, p.key AS project_key FROM artifacts x LEFT JOIN projects p ON p.id = x.project_id`;

/** The Artifacts of `rows`, each with its latest Version. */
async function withLatest(db: Queryable, rows: ArtifactRow[]): Promise<Artifact[]> {
  if (rows.length === 0) return [];
  const { rows: versions } = await db.query<VersionRow & { artifact_id: string }>(
    `${VERSION_SELECT} JOIN artifacts x ON x.id = v.artifact_id AND x.version = v.number WHERE v.artifact_id = ANY($1)`,
    [rows.map((r) => r.id)],
  );
  const latest = new Map(versions.map((v) => [v.artifact_id, toVersion(v)]));
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    projectKey: r.project_key,
    title: r.title,
    version: r.version,
    protected: r.protected,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    latest: latest.get(r.id)!,
  }));
}

/** The Artifact with this id in the Workspace, if there is one; `forUpdate` locks it until the transaction ends. */
export async function findArtifact(db: Queryable, workspaceId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<Artifact | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  const { rows } = await db.query<ArtifactRow>(`${ARTIFACT_SELECT} WHERE x.workspace_id = $1 AND x.id = $2${opts.forUpdate ? " FOR UPDATE OF x" : ""}`, [
    workspaceId,
    id,
  ]);
  return (await withLatest(db, rows))[0];
}

/** The Artifacts of a Project, or of the Workspace outside any Project, most recently published first. */
export async function listArtifacts(db: Queryable, place: { workspaceId: string; projectId: string | null }): Promise<Artifact[]> {
  const { rows } = await db.query<ArtifactRow>(
    `${ARTIFACT_SELECT} WHERE x.workspace_id = $1 AND x.project_id IS NOT DISTINCT FROM $2 ORDER BY x.updated_at DESC, x.id`,
    [place.workspaceId, place.projectId],
  );
  return withLatest(db, rows);
}

/** Every Artifact of the Workspace, its Projects' included, oldest first, as an export takes them. */
export async function listAllArtifacts(db: Queryable, workspaceId: string, projectId?: string | null): Promise<Artifact[]> {
  const { rows } = await db.query<ArtifactRow>(
    `${ARTIFACT_SELECT} WHERE x.workspace_id = $1 AND ($2::boolean OR x.project_id IS NOT DISTINCT FROM $3) ORDER BY x.created_at, x.id`,
    [workspaceId, projectId === undefined, projectId ?? null],
  );
  return withLatest(db, rows);
}

/** An Artifact's Versions, newest first. */
export async function listArtifactVersions(db: Queryable, artifactId: string): Promise<ArtifactVersion[]> {
  const { rows } = await db.query<VersionRow>(`${VERSION_SELECT} WHERE v.artifact_id = $1 ORDER BY v.number DESC`, [artifactId]);
  return rows.map(toVersion);
}

/** One Version of an Artifact, if it has it. */
export async function findArtifactVersion(db: Queryable, artifactId: string, number: number): Promise<ArtifactVersion | undefined> {
  const { rows } = await db.query<VersionRow>(`${VERSION_SELECT} WHERE v.artifact_id = $1 AND v.number = $2`, [artifactId, number]);
  return rows[0] && toVersion(rows[0]);
}

/** The files of one Version, by path. */
export async function listArtifactFiles(db: Queryable, artifactId: string, version: number): Promise<ArtifactFile[]> {
  const { rows } = await db.query<{ id: string; path: string; content_type: string; size: string }>(
    "SELECT id, path, content_type, size FROM artifact_files WHERE artifact_id = $1 AND version = $2 ORDER BY path",
    [artifactId, version],
  );
  return rows.map((r) => ({ id: r.id, path: r.path, contentType: r.content_type, size: Number(r.size) }));
}

/** One file of a Version by its path, if it holds one there. */
export async function findArtifactFile(db: Queryable, artifactId: string, version: number, path: string): Promise<ArtifactFile | undefined> {
  const { rows } = await db.query<{ id: string; path: string; content_type: string; size: string }>(
    "SELECT id, path, content_type, size FROM artifact_files WHERE artifact_id = $1 AND version = $2 AND path = $3",
    [artifactId, version, path],
  );
  return rows[0] && { id: rows[0].id, path: rows[0].path, contentType: rows[0].content_type, size: Number(rows[0].size) };
}

/** What a publish records: the Version's title, who published it and from which Ticket, and its files, whose bytes are already stored. */
export interface Publish {
  title: string;
  actor: Actor | StoredActor;
  sourceTicketId: string | null;
  files: ArtifactFile[];
  now: Date;
}

/** Creates an Artifact in a Project or the Workspace with `publish` as its Version 1. Run inside a transaction. */
export async function insertArtifact(db: Queryable, place: { workspaceId: string; projectId: string | null }, publish: Publish): Promise<Artifact> {
  return insertArtifactVersion(db, await insertArtifactRow(db, { ...place, title: publish.title, now: publish.now }), publish);
}

/** Creates an Artifact with no Version yet, as an import does before adding the Versions it holds. Run inside a transaction. */
export async function insertArtifactRow(
  db: Queryable,
  input: { id?: string; workspaceId: string; projectId: string | null; title: string; now: Date },
): Promise<{ id: string; workspaceId: string; version: number }> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO artifacts (id, workspace_id, project_id, title, created_at, updated_at) VALUES (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $5) RETURNING id",
    [input.id ?? null, input.workspaceId, input.projectId, input.title, input.now],
  );
  return { id: rows[0]!.id, workspaceId: input.workspaceId, version: 0 };
}

/**
 * Adds `publish` as the Artifact's next Version, which becomes its latest, or with `number`, as that Version, as an
 * import does when it brings in only some Versions. Run inside a transaction holding the Artifact's lock.
 */
export async function insertArtifactVersion(
  db: Queryable,
  artifact: { id: string; workspaceId: string; version: number },
  publish: Publish,
  number = artifact.version + 1,
): Promise<Artifact> {
  await db.query(
    `INSERT INTO artifact_versions (artifact_id, number, title, source_ticket_id, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [artifact.id, number, publish.title, publish.sourceTicketId, publish.now, ...actorColumns(publish.actor)],
  );
  for (const file of publish.files) {
    await db.query("INSERT INTO artifact_files (id, artifact_id, version, path, content_type, size) VALUES ($1, $2, $3, $4, $5, $6)", [
      file.id,
      artifact.id,
      number,
      file.path,
      file.contentType,
      file.size,
    ]);
  }
  await db.query("UPDATE artifacts SET version = $2, title = $3, updated_at = $4 WHERE id = $1", [artifact.id, number, publish.title, publish.now]);
  return (await findArtifact(db, artifact.workspaceId, artifact.id))!;
}

async function findArtifactRow(db: Queryable, id: string): Promise<{ id: string; workspaceId: string; version: number } | undefined> {
  const { rows } = await db.query<{ id: string; workspace_id: string; version: number }>("SELECT id, workspace_id, version FROM artifacts WHERE id = $1", [id]);
  return rows[0] && { id: rows[0].id, workspaceId: rows[0].workspace_id, version: rows[0].version };
}

/** The secret the Workspace's Artifact addresses are signed with. */
export async function artifactSigningKey(db: Queryable, workspaceId: string): Promise<string> {
  const { rows } = await db.query<{ artifact_signing_key: string }>("SELECT artifact_signing_key FROM workspaces WHERE id = $1", [workspaceId]);
  return rows[0]!.artifact_signing_key;
}

/** The Workspace an Artifact belongs to, and its latest Version, looked up by id alone, as the Artifact hostname must. */
export async function findArtifactAnywhere(db: Queryable, id: string): Promise<{ workspaceId: string; version: number } | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  const row = await findArtifactRow(db, id);
  return row && { workspaceId: row.workspaceId, version: row.version };
}
