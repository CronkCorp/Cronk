import { actorColumns, toRecordedActor, type Actor, type RecordedActor, type RecordedActorRow } from "../actor.js";
import { lockUntilCommit, type Queryable } from "../db/database.js";

/**
 * Documents: Markdown (ADR 0003) belonging to a Project or the Workspace, arranged
 * in a page tree. Every save creates an immutable Version, and every save names the
 * Version it is based on (ADR 0009).
 */
export interface Document {
  id: string;
  /** Null for a Workspace Document. */
  projectId: string | null;
  projectKey: string | null;
  /** The Document it sits under in the page tree; null at the top. */
  parentId: string | null;
  title: string;
  /** Markdown. */
  body: string;
  /** The number of its current Version. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface DocumentRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  project_key: string | null;
  parent_id: string | null;
  title: string;
  body: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const toDocument = (row: DocumentRow): Document => ({
  id: row.id,
  projectId: row.project_id,
  projectKey: row.project_key,
  parentId: row.parent_id,
  title: row.title,
  body: row.body,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT_DOCUMENTS = `
  SELECT d.*, p.key AS project_key FROM documents d LEFT JOIN projects p ON p.id = d.project_id`;

/** The page tree a Document sits in: a Project's, or the Workspace's when `projectId` is null. */
export interface Tree {
  workspaceId: string;
  projectId: string | null;
}

/** Takes a lock on a page tree until the transaction ends, so its arrangement changes one at a time. */
async function lockTree(db: Queryable, tree: Tree): Promise<void> {
  await lockUntilCommit(db, `document-tree:${tree.workspaceId}:${tree.projectId ?? "workspace"}`);
}

/** A Document as its page tree lists it. */
export interface TreeEntry {
  id: string;
  parentId: string | null;
  title: string;
  /** How deep it sits: 0 at the top. */
  depth: number;
}

/** A page tree's Documents depth first: each followed by those under it, siblings in their order. */
export async function listTree(db: Queryable, tree: Tree): Promise<TreeEntry[]> {
  const { rows } = await db.query<TreeEntry>(
    `WITH RECURSIVE tree AS (
       SELECT id, parent_id, title, 0 AS depth, ARRAY[position] AS path
       FROM documents WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND parent_id IS NULL
       UNION ALL
       SELECT d.id, d.parent_id, d.title, t.depth + 1, t.path || d.position
       FROM documents d JOIN tree t ON d.parent_id = t.id
     )
     SELECT id, parent_id AS "parentId", title, depth FROM tree ORDER BY path`,
    [tree.workspaceId, tree.projectId],
  );
  return rows;
}

/**
 * Creates a Document last among its siblings, with its first Version. `parentId` must
 * be a Document of the same tree (see `findDocument`). Run inside a transaction.
 */
export async function insertDocument(
  db: Queryable,
  input: { tree: Tree; parentId: string | null; title: string; body: string; actor: Actor; now: Date },
): Promise<Document> {
  await lockTree(db, input.tree);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, project_id, parent_id, position, title, body, version, created_at, updated_at)
     SELECT $1, $2, $3, coalesce(max(position) + 1, 0), $4, $5, 1, $6, $6
     FROM documents WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND parent_id IS NOT DISTINCT FROM $3
     RETURNING id`,
    [input.tree.workspaceId, input.tree.projectId, input.parentId, input.title, input.body, input.now],
  );
  const id = rows[0]!.id;
  await insertVersion(db, id, { number: 1, title: input.title, body: input.body, actor: input.actor, now: input.now, restoredFrom: null });
  return (await findDocument(db, input.tree.workspaceId, id))!;
}

async function insertVersion(
  db: Queryable,
  documentId: string,
  v: { number: number; title: string; body: string; actor: Actor; now: Date; restoredFrom: number | null },
): Promise<void> {
  await db.query(
    `INSERT INTO document_versions (document_id, number, title, body, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id, restored_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [documentId, v.number, v.title, v.body, v.now, ...actorColumns(v.actor), v.restoredFrom],
  );
}

/**
 * A Document of the Workspace, by id. With `forUpdate`, locks it until the transaction
 * ends so concurrent saves see each other's Versions.
 */
export async function findDocument(
  db: Queryable,
  workspaceId: string,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<Document | undefined> {
  const { rows } = await db.query<DocumentRow>(
    `${SELECT_DOCUMENTS} WHERE d.workspace_id = $1 AND d.id = $2${opts.forUpdate ? " FOR UPDATE OF d" : ""}`,
    [workspaceId, id],
  );
  return rows[0] && toDocument(rows[0]);
}

/** One saved state of a Document, with the Actor who saved it. */
export interface Version {
  number: number;
  title: string;
  body: string;
  at: Date;
  actor: RecordedActor;
  /** The Version it restored, if it was a restore. */
  restoredFrom: number | null;
}

interface VersionRow extends RecordedActorRow {
  number: number;
  title: string;
  body: string;
  at: Date;
  restored_from: number | null;
}

const toVersion = (row: VersionRow): Version => ({
  number: row.number,
  title: row.title,
  body: row.body,
  at: row.at,
  actor: toRecordedActor(row),
  restoredFrom: row.restored_from,
});

const SELECT_VERSIONS = `
  SELECT v.number, v.title, v.body, v.at, v.restored_from,
         u.id AS user_id, u.name AS user_name, a.id AS agent_id, a.name AS agent_name, v.actor_session_id AS session_id
  FROM document_versions v JOIN users u ON u.id = v.actor_user_id LEFT JOIN agents a ON a.id = v.actor_agent_id`;

/** One of a Document's Versions, by number. */
export async function findVersion(db: Queryable, documentId: string, number: number): Promise<Version | undefined> {
  const { rows } = await db.query<VersionRow>(`${SELECT_VERSIONS} WHERE v.document_id = $1 AND v.number = $2`, [documentId, number]);
  return rows[0] && toVersion(rows[0]);
}

/** A Document's Versions, newest first, without their bodies. */
export async function listVersions(db: Queryable, documentId: string): Promise<Omit<Version, "body">[]> {
  const { rows } = await db.query<VersionRow>(`${SELECT_VERSIONS} WHERE v.document_id = $1 ORDER BY v.number DESC`, [documentId]);
  return rows.map(toVersion).map(({ body: _, ...summary }) => summary);
}

/**
 * Saves a new Version of a Document, unless it would change nothing (and isn't a restore).
 * Pass a Document locked with `forUpdate` whose Version the save was based on, inside a transaction.
 */
export async function saveVersion(
  db: Queryable,
  document: Document,
  save: { title: string; body: string; actor: Actor; now: Date; restoredFrom?: number },
): Promise<Document> {
  if (save.restoredFrom === undefined && save.title === document.title && save.body === document.body) return document;
  const number = document.version + 1;
  await insertVersion(db, document.id, { ...save, number, restoredFrom: save.restoredFrom ?? null });
  await db.query("UPDATE documents SET title = $2, body = $3, version = $4, updated_at = $5 WHERE id = $1", [
    document.id,
    save.title,
    save.body,
    number,
    save.now,
  ]);
  return { ...document, title: save.title, body: save.body, version: number, updatedAt: save.now };
}

/** Why a Document can't move where it was asked to. */
export type MoveRefusal = "under itself" | "no such position";

/**
 * Moves a Document, with what sits under it, under `parentId` (null for the top) at `position`
 * among its new siblings, counted from 0, or last if left out. `parentId` must be a Document of
 * the same tree. Changes no Version. Run inside a transaction.
 */
export async function moveDocument(
  db: Queryable,
  tree: Tree,
  document: Document,
  to: { parentId: string | null; position?: number | undefined },
): Promise<Document | MoveRefusal> {
  await lockTree(db, tree);
  if (to.parentId !== null) {
    const { rows } = await db.query(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT $1::uuid
         UNION SELECT d.parent_id FROM documents d JOIN ancestors a ON d.id = a.id WHERE d.parent_id IS NOT NULL
       )
       SELECT 1 FROM ancestors WHERE id = $2`,
      [to.parentId, document.id],
    );
    if (rows.length > 0) return "under itself";
  }
  const { rows: siblings } = await db.query<{ id: string }>(
    `SELECT id FROM documents
     WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND parent_id IS NOT DISTINCT FROM $3 AND id <> $4
     ORDER BY position`,
    [tree.workspaceId, tree.projectId, to.parentId, document.id],
  );
  const order = siblings.map((s) => s.id);
  const position = to.position ?? order.length;
  if (position > order.length) return "no such position";
  order.splice(position, 0, document.id);
  await db.query("UPDATE documents SET parent_id = $2 WHERE id = $1", [document.id, to.parentId]);
  await db.query(
    `UPDATE documents SET position = ordered.position - 1
     FROM unnest($1::uuid[]) WITH ORDINALITY AS ordered(id, position) WHERE documents.id = ordered.id`,
    [order],
  );
  return { ...document, parentId: to.parentId };
}

/** Deletes a Document and its Versions, or returns false if any Document sits under it. Run inside a transaction. */
export async function deleteDocument(db: Queryable, tree: Tree, document: Document): Promise<boolean> {
  await lockTree(db, tree);
  const { rows } = await db.query("SELECT 1 FROM documents WHERE parent_id = $1 LIMIT 1", [document.id]);
  if (rows.length > 0) return false;
  await db.query("DELETE FROM documents WHERE id = $1", [document.id]);
  return true;
}
