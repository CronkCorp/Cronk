import { actorColumns, toRecordedActor, type Actor, type RecordedActor, type RecordedActorRow, type StoredActor } from "../actor.js";
import type { Queryable } from "../db/database.js";

/**
 * Attachments: plain files, such as images, video, PDFs and logs, attached to a Ticket, a Document (a Report
 * too) or a Comment. Each belongs to that item, which decides who can read it; one on a Document belongs to the
 * Document rather than to one of its Versions, so it stays for them all. The row is what Cronk knows of the file;
 * its bytes are in the file store under `attachmentKey(id)`.
 */
export interface Attachment {
  id: string;
  /** What it is attached to. */
  on: AttachedTo;
  /** The Ticket it is on, directly, in one of its Comments or Reports, or in a Comment on one of its Reports. */
  ticketId: string | null;
  ticketKey: string | null;
  /** The Document (or Report) it is on, directly or in one of its Comments. */
  documentId: string | null;
  /** The Comment it is on. */
  commentId: string | null;
  /** The Artifact it is on, in one of its Comments. */
  artifactId: string | null;
  /** The Project it is in; null for a Workspace Document's or Artifact's. */
  projectId: string | null;
  name: string;
  contentType: string;
  size: number;
  at: Date;
  actor: RecordedActor;
}

/** The kinds of item an Attachment can be on. */
export type AttachedTo = "ticket" | "document" | "comment";

/** The item an Attachment is put on, by its id. */
export type AttachmentTarget = { ticketId: string } | { documentId: string } | { commentId: string };

/** Where an Attachment's bytes are kept in the file store. */
export const attachmentKey = (id: string) => `attachments/${id}`;

interface AttachmentRow extends RecordedActorRow {
  id: string;
  attached_to: AttachedTo;
  ticket_id: string | null;
  ticket_key: string | null;
  document_id: string | null;
  comment_id: string | null;
  artifact_id: string | null;
  project_id: string | null;
  name: string;
  content_type: string;
  size: string;
  at: Date;
}

/** Selects Attachments as `x`, with the Comment `c`, Document `d`, Ticket `t` and Artifact `ax` they are on or in. */
const SELECT = `
  SELECT x.id, CASE WHEN x.ticket_id IS NOT NULL THEN 'ticket' WHEN x.document_id IS NOT NULL THEN 'document' ELSE 'comment' END AS attached_to,
    t.id AS ticket_id, p.key || '-' || t.number AS ticket_key, d.id AS document_id, x.comment_id, ax.id AS artifact_id,
    coalesce(t.project_id, d.project_id, ax.project_id) AS project_id, x.name, x.content_type, x.size, x.at,
    u.id AS user_id, u.name AS user_name, a.id AS agent_id, a.name AS agent_name, x.actor_session_id AS session_id
  FROM attachments x LEFT JOIN comments c ON c.id = x.comment_id
    LEFT JOIN documents d ON d.id = coalesce(x.document_id, c.document_id)
    LEFT JOIN tickets t ON t.id = coalesce(x.ticket_id, c.ticket_id, d.ticket_id) LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN artifacts ax ON ax.id = c.artifact_id
    JOIN users u ON u.id = x.actor_user_id LEFT JOIN agents a ON a.id = x.actor_agent_id`;

const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  on: row.attached_to,
  ticketId: row.ticket_id,
  ticketKey: row.ticket_key,
  documentId: row.document_id,
  commentId: row.comment_id,
  artifactId: row.artifact_id,
  projectId: row.project_id,
  name: row.name,
  contentType: row.content_type,
  size: Number(row.size),
  at: row.at,
  actor: toRecordedActor(row),
});

/** What the API answers for an Attachment. */
export const publicAttachment = (a: Attachment) => ({
  id: a.id,
  on: a.on,
  ticketKey: a.ticketKey,
  documentId: a.documentId,
  commentId: a.commentId,
  name: a.name,
  contentType: a.contentType,
  size: a.size,
  at: a.at,
  actor: a.actor,
});

/** The `ticket_id`, `document_id` and `comment_id` an Attachment on `target` is stored with: one set, the others null. */
const targetColumns = (target: AttachmentTarget): [ticketId: string | null, documentId: string | null, commentId: string | null] => [
  "ticketId" in target ? target.ticketId : null,
  "documentId" in target ? target.documentId : null,
  "commentId" in target ? target.commentId : null,
];

/** Records the Attachment `id` whose bytes are already stored, on `target`. Run inside a transaction. */
export async function insertAttachment(
  db: Queryable,
  input: { id: string; workspaceId: string; target: AttachmentTarget; name: string; contentType: string; size: number; actor: Actor | StoredActor; now: Date },
): Promise<Attachment> {
  await db.query(
    `INSERT INTO attachments (id, workspace_id, ticket_id, document_id, comment_id, name, content_type, size, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [input.id, input.workspaceId, ...targetColumns(input.target), input.name, input.contentType, input.size, input.now, ...actorColumns(input.actor)],
  );
  return (await findAttachment(db, input.workspaceId, input.id))!;
}

/** The Attachment with this id in the Workspace, if there is one. */
export async function findAttachment(db: Queryable, workspaceId: string, id: string): Promise<Attachment | undefined> {
  const { rows } = await db.query<AttachmentRow>(`${SELECT} WHERE x.workspace_id = $1 AND x.id = $2`, [workspaceId, id]);
  return rows[0] && toAttachment(rows[0]);
}

/**
 * Every Attachment on a Ticket, in the order they were attached: its own, and those in its Comments, its Reports
 * and the Comments on its Reports.
 */
export async function listTicketAttachments(db: Queryable, ticketId: string): Promise<Attachment[]> {
  const { rows } = await db.query<AttachmentRow>(`${SELECT} WHERE t.id = $1 ORDER BY x.at, x.seq`, [ticketId]);
  return rows.map(toAttachment);
}

/** Every Attachment on a Document, in the order they were attached: its own and those in its Comments. */
export async function listDocumentAttachments(db: Queryable, documentId: string): Promise<Attachment[]> {
  const { rows } = await db.query<AttachmentRow>(`${SELECT} WHERE d.id = $1 ORDER BY x.at, x.seq`, [documentId]);
  return rows.map(toAttachment);
}

/** Every Attachment in an Artifact's Comments, in the order they were attached. */
export async function listArtifactAttachments(db: Queryable, artifactId: string): Promise<Attachment[]> {
  const { rows } = await db.query<AttachmentRow>(`${SELECT} WHERE ax.id = $1 ORDER BY x.at, x.seq`, [artifactId]);
  return rows.map(toAttachment);
}

/** The ids of every Attachment on a Document, directly or in its Comments: those deleting it removes. */
export async function documentAttachmentIds(db: Queryable, documentId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT x.id FROM attachments x LEFT JOIN comments c ON c.id = x.comment_id WHERE x.document_id = $1 OR c.document_id = $1",
    [documentId],
  );
  return rows.map((r) => r.id);
}

/** Removes the record of an Attachment; its bytes are for the caller to remove once this commits. Returns whether there was one. */
export async function deleteAttachment(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM attachments WHERE id = $1", [id]);
  return rowCount !== 0;
}

/** How many Attachments the Workspace holds, and how many bytes their files take. */
export async function attachmentStorage(db: Queryable, workspaceId: string): Promise<{ files: number; bytes: number }> {
  const { rows } = await db.query<{ files: number; bytes: string }>(
    "SELECT count(*)::int AS files, coalesce(sum(size), 0)::bigint AS bytes FROM attachments WHERE workspace_id = $1",
    [workspaceId],
  );
  return { files: rows[0]!.files, bytes: Number(rows[0]!.bytes) };
}
