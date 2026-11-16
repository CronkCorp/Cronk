import { actorColumns, toRecordedActor, type Actor, type StoredActor, type RecordedActor, type RecordedActorRow } from "../actor.js";
import { lockUntilCommit, type Queryable } from "../db/database.js";
import { ticketKeySql } from "../work/tickets.js";
import { documentReadableSql, type Readable } from "../identity/access.js";
import { recordTicketMentions } from "./ticket-mentions.js";
import { recordMentions } from "./mentions.js";
import type { LinkReason } from "../../shared/values.js";
import { withSuggestions, type VersionSuggestion } from "./version-suggestions.js";

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
  /** The Document it sits under in the page tree; null at the top, and for a Report. */
  parentId: string | null;
  /** The Ticket a Report is on; null for any other Document. Reports stay out of the page tree. */
  ticketKey: string | null;
  title: string;
  /** Markdown. */
  body: string;
  /** The number of its current Version. */
  version: number;
  /** Whether Agents may read but not change it: it is marked Protected, or sits under a Document that is. */
  protected: boolean;
  /** The Document whose Protected mark covers it: itself if marked, else the nearest marked Document above it; null if none. */
  protectedBy: { id: string; title: string } | null;
  /** How many Documents sit under it, all covered by its mark, when it is itself marked Protected; 0 otherwise. */
  covers: number;
  createdAt: Date;
  updatedAt: Date;
}

interface DocumentRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  project_key: string | null;
  parent_id: string | null;
  ticket_key: string | null;
  title: string;
  body: string;
  version: number;
  protected: boolean;
  protected_by_id: string | null;
  protected_by_title: string | null;
  covers: number;
  created_at: Date;
  updated_at: Date;
}

const toDocument = (row: DocumentRow): Document => ({
  id: row.id,
  projectId: row.project_id,
  projectKey: row.project_key,
  parentId: row.parent_id,
  ticketKey: row.ticket_key,
  title: row.title,
  body: row.body,
  version: row.version,
  protected: row.protected_by_id !== null,
  protectedBy: row.protected_by_id === null ? null : { id: row.protected_by_id, title: row.protected_by_title! },
  covers: row.covers,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT_DOCUMENTS = `
  SELECT d.*, p.key AS project_key, ${ticketKeySql("tp", "t")} AS ticket_key
  FROM documents d LEFT JOIN projects p ON p.id = d.project_id
    LEFT JOIN tickets t ON t.id = d.ticket_id LEFT JOIN projects tp ON tp.id = t.project_id`;

/**
 * A Document's row with what its Protected mark covers: the Document whose mark covers it (itself, or the
 * nearest marked one above it) and, when marked itself, how many Documents sit under it.
 */
const SELECT_DOCUMENT_WITH_PROTECTION = `
  WITH RECURSIVE found AS (${SELECT_DOCUMENTS} WHERE d.workspace_id = $1 AND d.id = $2),
  above(id, parent_id, title, protected, depth) AS (
    SELECT id, parent_id, title, protected, 0 FROM found
    UNION ALL SELECT x.id, x.parent_id, x.title, x.protected, above.depth + 1 FROM documents x JOIN above ON x.id = above.parent_id
  ),
  below(id) AS (
    SELECT x.id FROM documents x JOIN found ON x.parent_id = found.id WHERE found.protected
    UNION ALL SELECT x.id FROM documents x JOIN below ON x.parent_id = below.id
  ),
  cover AS (SELECT id, title FROM above WHERE protected ORDER BY depth LIMIT 1)
  SELECT found.*, (SELECT id FROM cover) AS protected_by_id, (SELECT title FROM cover) AS protected_by_title,
         (SELECT count(*)::int FROM below) AS covers
  FROM found`;

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
  /** Whether Agents may read but not change it: it, or a Document above it, is marked Protected. */
  protected: boolean;
}

/** A page tree's Documents depth first: each followed by those under it, siblings in their order. Reports are left out. */
export async function listTree(db: Queryable, tree: Tree): Promise<TreeEntry[]> {
  const { rows } = await db.query<TreeEntry>(
    `WITH RECURSIVE tree AS (
       SELECT id, parent_id, title, 0 AS depth, ARRAY[position] AS path, protected
       FROM documents WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND parent_id IS NULL AND ticket_id IS NULL
       UNION ALL
       SELECT d.id, d.parent_id, d.title, t.depth + 1, t.path || d.position, t.protected OR d.protected
       FROM documents d JOIN tree t ON d.parent_id = t.id
     )
     SELECT id, parent_id AS "parentId", title, depth, protected FROM tree ORDER BY path`,
    [tree.workspaceId, tree.projectId],
  );
  return rows;
}

/** Why a Document can't go where it was asked to in its page tree. */
export type TreeRefusal = "no such parent" | "under itself" | "no such position" | "a report";

/** Whether `parentId` is null (the top) or a Document of `tree` other than a Report. Lock the tree first, so it can't be deleted meanwhile. */
async function isParentIn(db: Queryable, tree: Tree, parentId: string | null): Promise<boolean> {
  if (parentId === null) return true;
  const { rows } = await db.query("SELECT 1 FROM documents WHERE id = $1 AND workspace_id = $2 AND project_id IS NOT DISTINCT FROM $3 AND ticket_id IS NULL", [
    parentId,
    tree.workspaceId,
    tree.projectId,
  ]);
  return rows.length > 0;
}

/**
 * Creates a Document last among its siblings under `parentId` (null for the top), with its
 * first Version, or refuses if the parent isn't a Document of the same tree. Run inside a transaction.
 */
export async function insertDocument(
  db: Queryable,
  input: { tree: Tree; parentId: string | null; title: string; body: string; actor: Actor; now: Date },
): Promise<Document | "no such parent"> {
  await lockTree(db, input.tree);
  if (!(await isParentIn(db, input.tree, input.parentId))) return "no such parent";
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, project_id, parent_id, position, title, body, version, created_at, updated_at)
     SELECT $1, $2, $3, coalesce(max(position) + 1, 0), $4, $5, 1, $6, $6
     FROM documents WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND parent_id IS NOT DISTINCT FROM $3 AND ticket_id IS NULL
     RETURNING id`,
    [input.tree.workspaceId, input.tree.projectId, input.parentId, input.title, input.body, input.now],
  );
  const id = rows[0]!.id;
  await insertVersion(db, id, { number: 1, title: input.title, body: input.body, actor: input.actor, now: input.now, restoredFrom: null });
  await recordTicketMentions(db, id, input);
  await recordMentions(db, { kind: "document", id });
  return (await findDocument(db, input.tree.workspaceId, id))!;
}

/** A Document's row as written in full: by a Report, which isn't in the page tree, and by an import, which keeps its times. */
export interface DocumentRowInput {
  workspaceId: string;
  projectId: string | null;
  parentId: string | null;
  position: number;
  title: string;
  body: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  ticketId: string | null;
  claimId: string | null;
}

/** Writes a Document's row as given, with the Tickets its title and body mention, and returns its id; callers record its Versions. Run inside a transaction. */
export async function insertDocumentRow(db: Queryable, d: DocumentRowInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, project_id, parent_id, position, title, body, version, created_at, updated_at, ticket_id, claim_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [d.workspaceId, d.projectId, d.parentId, d.position, d.title, d.body, d.version, d.createdAt, d.updatedAt, d.ticketId, d.claimId],
  );
  const id = rows[0]!.id;
  await recordTicketMentions(db, id, d);
  await recordMentions(db, { kind: "document", id });
  return id;
}

/** Records Version `number` of a Document. Run inside the transaction that creates or saves it. */
export async function insertVersion(
  db: Queryable,
  documentId: string,
  v: { number: number; title: string; body: string; actor: Actor | StoredActor; now: Date; restoredFrom: number | null },
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
  if (opts.forUpdate) await db.query("SELECT 1 FROM documents WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [workspaceId, id]);
  const { rows } = await db.query<DocumentRow>(SELECT_DOCUMENT_WITH_PROTECTION, [workspaceId, id]);
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
  /** The Suggestion a User accepted to make it, unchanged or edited; null for a Version saved otherwise. */
  suggestion: VersionSuggestion | null;
}

interface VersionRow extends RecordedActorRow {
  number: number;
  title: string;
  body: string;
  at: Date;
  restored_from: number | null;
}

const toVersion = (row: VersionRow): Omit<Version, "suggestion"> => ({
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
  return rows[0] && (await withSuggestions(db, { kind: "document", id: documentId }, [toVersion(rows[0])]))[0];
}

/** A Document's Versions, newest first, without their bodies. */
export async function listVersions(db: Queryable, documentId: string): Promise<Omit<Version, "body">[]> {
  const { rows } = await db.query<VersionRow>(`${SELECT_VERSIONS} WHERE v.document_id = $1 ORDER BY v.number DESC`, [documentId]);
  return withSuggestions(db, { kind: "document", id: documentId }, rows.map(toVersion).map(({ body: _, ...summary }) => summary));
}

/**
 * Saves a new Version of a Document, unless it would change nothing (and isn't a restore).
 * Pass a Document locked with `forUpdate` whose Version the save was based on, inside a transaction.
 */
export async function saveVersion(
  db: Queryable,
  document: Document,
  save: { title: string; body: string; actor: Actor | StoredActor; now: Date; restoredFrom?: number },
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
  await recordTicketMentions(db, document.id, save);
  await recordMentions(db, { kind: "document", id: document.id });
  return { ...document, title: save.title, body: save.body, version: number, updatedAt: save.now };
}

/**
 * Moves a Document, with what sits under it, under `parentId` (null for the top) at `position`
 * among its new siblings, counted from 0, or last if left out. Refuses a parent outside its tree,
 * itself or below it, and a position past the end, and a Report, which stays out of the tree. Changes no
 * Version. Run inside a transaction.
 */
export async function moveDocument(
  db: Queryable,
  tree: Tree,
  document: Document,
  to: { parentId: string | null; position?: number | undefined },
): Promise<Document | TreeRefusal> {
  if (document.ticketKey !== null) return "a report";
  await lockTree(db, tree);
  if (!(await isParentIn(db, tree, to.parentId))) return "no such parent";
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
     WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND parent_id IS NOT DISTINCT FROM $3 AND id <> $4 AND ticket_id IS NULL
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
  return (await findDocument(db, tree.workspaceId, document.id))!;
}

/** The first Document marked Protected anywhere under `documentId` in its page tree, if any. */
export async function findProtectedUnder(db: Queryable, documentId: string): Promise<{ id: string; title: string } | undefined> {
  const { rows } = await db.query<{ id: string; title: string }>(
    `WITH RECURSIVE below(id, title, protected) AS (
       SELECT id, title, protected FROM documents WHERE parent_id = $1
       UNION ALL SELECT d.id, d.title, d.protected FROM documents d JOIN below b ON d.parent_id = b.id
     )
     SELECT id, title FROM below WHERE protected LIMIT 1`,
    [documentId],
  );
  return rows[0];
}

/** Deletes a Document and its Versions, or returns false if any Document sits under it. Run inside a transaction. */
export async function deleteDocument(db: Queryable, tree: Tree, document: Document): Promise<boolean> {
  await lockTree(db, tree);
  const { rows } = await db.query("SELECT 1 FROM documents WHERE parent_id = $1 LIMIT 1", [document.id]);
  if (rows.length > 0) return false;
  await db.query("DELETE FROM documents WHERE id = $1", [document.id]);
  return true;
}

/** A Document as a Ticket lists it among its linked Documents, without its body; read it by its id. */
export interface LinkedDocument {
  id: string;
  title: string;
  /** Null for a Workspace Document. */
  projectKey: string | null;
  /** The Ticket a Report is on; null for any other Document. */
  ticketKey: string | null;
  version: number;
  updatedAt: Date;
  reason: LinkReason;
}

/** How many Documents mentioning a Ticket it lists, besides its Reports and the Documents linked to it. */
const MENTIONS_LIMIT = 20;

/**
 * The Documents linked to a Ticket, each once: its own Reports, oldest first; then the Documents
 * linked to it, in the order they were linked; then the other Documents (other Tickets' Reports
 * included) whose current Version mentions its key, as Markdown links Ticket keys, most recently
 * changed first. Only those in `readable` places are listed; the Ticket's Reports always are, as
 * they share its Project.
 */
export async function listLinkedDocuments(
  db: Queryable,
  ticket: { id: string; key: string },
  readable: Readable,
): Promise<LinkedDocument[]> {
  const select = (reason: LinkReason) =>
    `SELECT d.id, d.title, d.project_key AS "projectKey", d.ticket_key AS "ticketKey", d.version, d.updated_at AS "updatedAt", '${reason}' AS reason
     FROM (${SELECT_DOCUMENTS}) d`;
  const isReadable = documentReadableSql("d", "$2::uuid[]", "$3::uuid");
  const reports = await db.query<LinkedDocument>(`${select("report")} WHERE d.ticket_id = $1 ORDER BY d.created_at, d.id`, [ticket.id]);
  const linked = await db.query<LinkedDocument>(
    `${select("linked")} JOIN ticket_document_links l ON l.document_id = d.id AND l.ticket_id = $1
     WHERE d.ticket_id IS DISTINCT FROM $1 AND ${isReadable}
     ORDER BY l.seq`,
    [ticket.id, readable.projectIds, readable.workspaceId],
  );
  const mentions = await db.query<LinkedDocument>(
    `${select("mention")} JOIN document_ticket_mentions m ON m.document_id = d.id AND m.ticket_key = $4
     WHERE d.ticket_id IS DISTINCT FROM $1
       AND NOT EXISTS (SELECT 1 FROM ticket_document_links l WHERE l.ticket_id = $1 AND l.document_id = d.id)
       AND ${isReadable}
     ORDER BY d.updated_at DESC, d.id LIMIT ${MENTIONS_LIMIT}`,
    [ticket.id, readable.projectIds, readable.workspaceId, ticket.key],
  );
  return [...reports.rows, ...linked.rows, ...mentions.rows];
}
