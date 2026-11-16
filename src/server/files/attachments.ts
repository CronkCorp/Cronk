import { actorColumns, toRecordedActor, type Actor, type RecordedActor, type RecordedActorRow, type StoredActor } from "../actor.js";
import type { Queryable } from "../db/database.js";

/**
 * Attachments: plain files attached to a Ticket, such as images, video, PDFs and logs. Each belongs to
 * its Ticket, which decides who can read it. The row is what Cronk knows of the file; its bytes are in the
 * file store under `attachmentKey(id)`.
 */
export interface Attachment {
  id: string;
  ticketId: string;
  ticketKey: string;
  projectId: string;
  name: string;
  contentType: string;
  size: number;
  at: Date;
  actor: RecordedActor;
}

/** Where an Attachment's bytes are kept in the file store. */
export const attachmentKey = (id: string) => `attachments/${id}`;

interface AttachmentRow extends RecordedActorRow {
  id: string;
  ticket_id: string;
  ticket_key: string;
  project_id: string;
  name: string;
  content_type: string;
  size: string;
  at: Date;
}

const SELECT = `
  SELECT x.id, x.ticket_id, p.key || '-' || t.number AS ticket_key, t.project_id, x.name, x.content_type, x.size, x.at,
    u.id AS user_id, u.name AS user_name, a.id AS agent_id, a.name AS agent_name, x.actor_session_id AS session_id
  FROM attachments x JOIN tickets t ON t.id = x.ticket_id JOIN projects p ON p.id = t.project_id
    JOIN users u ON u.id = x.actor_user_id LEFT JOIN agents a ON a.id = x.actor_agent_id`;

const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  ticketId: row.ticket_id,
  ticketKey: row.ticket_key,
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
  ticketKey: a.ticketKey,
  name: a.name,
  contentType: a.contentType,
  size: a.size,
  at: a.at,
  actor: a.actor,
});

/** Records the Attachment `id` whose bytes are already stored, on the Ticket `ticketId`. Run inside a transaction. */
export async function insertAttachment(
  db: Queryable,
  input: { id: string; workspaceId: string; ticketId: string; name: string; contentType: string; size: number; actor: Actor | StoredActor; now: Date },
): Promise<Attachment> {
  await db.query(
    `INSERT INTO attachments (id, workspace_id, ticket_id, name, content_type, size, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [input.id, input.workspaceId, input.ticketId, input.name, input.contentType, input.size, input.now, ...actorColumns(input.actor)],
  );
  return (await findAttachment(db, input.workspaceId, input.id))!;
}

/** The Attachment with this id in the Workspace, if there is one. */
export async function findAttachment(db: Queryable, workspaceId: string, id: string): Promise<Attachment | undefined> {
  const { rows } = await db.query<AttachmentRow>(`${SELECT} WHERE x.workspace_id = $1 AND x.id = $2`, [workspaceId, id]);
  return rows[0] && toAttachment(rows[0]);
}

/** A Ticket's Attachments, in the order they were attached. */
export async function listAttachments(db: Queryable, ticketId: string): Promise<Attachment[]> {
  const { rows } = await db.query<AttachmentRow>(`${SELECT} WHERE x.ticket_id = $1 ORDER BY x.seq`, [ticketId]);
  return rows.map(toAttachment);
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
