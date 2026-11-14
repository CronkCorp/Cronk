import { actorColumns, toRecordedActor, type Actor, type RecordedActor, type RecordedActorRow } from "../actor.js";
import type { Queryable } from "../db/database.js";

/**
 * Comments: conversation any Actor posts on a Ticket or a Document, as opposed to an Agent's
 * own Activities. A Comment may reply to another Comment on the same Ticket or Document, or
 * to an Activity on the same Ticket. The body is Markdown.
 */
export interface Comment {
  id: string;
  /** Set on a Comment on a Ticket. */
  ticketId: string | null;
  ticketKey: string | null;
  /** Set on a Comment on a Document. */
  documentId: string | null;
  replyToCommentId: string | null;
  replyToActivityId: string | null;
  /** The passage of its Document it is anchored to; null when it isn't anchored. */
  anchor: Anchor | null;
  body: string;
  at: Date;
  actor: RecordedActor;
}

/** A passage of a Document a Comment is anchored to: text the Document held at `version`. */
export interface Anchor {
  passage: string;
  version: number;
  /** Whether the Document's current Version still holds the passage; the Comment stays anchored while it does. */
  inCurrentVersion: boolean;
}

/** What a Comment is posted on: a Ticket or a Document. */
export type CommentTarget = { ticketId: string } | { documentId: string };

interface CommentRow extends RecordedActorRow {
  id: string;
  ticket_id: string | null;
  ticket_key: string | null;
  document_id: string | null;
  reply_to_comment_id: string | null;
  reply_to_activity_id: string | null;
  anchor_passage: string | null;
  anchor_version: number | null;
  anchor_in_current_version: boolean | null;
  body: string;
  at: Date;
  ticket_title: string | null;
  document_title: string | null;
  project_id: string | null;
}

/**
 * Selects Comments, with their Ticket's key, Actor and whether their anchor is still in the
 * Document, from `source` (the table, or a CTE of new rows) as `c`.
 */
const selectFrom = (source: string) => `
  SELECT c.id, c.ticket_id, p.key || '-' || t.number AS ticket_key, c.document_id, c.reply_to_comment_id, c.reply_to_activity_id,
    c.anchor_passage, c.anchor_version, strpos(d.body, c.anchor_passage) > 0 AS anchor_in_current_version,
    c.body, c.at, t.title AS ticket_title, d.title AS document_title, coalesce(t.project_id, d.project_id) AS project_id, u.id AS user_id, u.name AS user_name, a.id AS agent_id, a.name AS agent_name, c.actor_session_id AS session_id
  FROM ${source} c JOIN users u ON u.id = c.actor_user_id LEFT JOIN agents a ON a.id = c.actor_agent_id
    LEFT JOIN tickets t ON t.id = c.ticket_id LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN documents d ON d.id = c.document_id`;

const toComment = (row: CommentRow): Comment => ({
  id: row.id,
  ticketId: row.ticket_id,
  ticketKey: row.ticket_key,
  documentId: row.document_id,
  replyToCommentId: row.reply_to_comment_id,
  replyToActivityId: row.reply_to_activity_id,
  anchor:
    row.anchor_passage === null
      ? null
      : { passage: row.anchor_passage, version: row.anchor_version!, inCurrentVersion: row.anchor_in_current_version! },
  body: row.body,
  at: row.at,
  actor: toRecordedActor(row),
});

const targetColumns = (target: CommentTarget): [ticketId: string | null, documentId: string | null] =>
  "ticketId" in target ? [target.ticketId, null] : [null, target.documentId];

/**
 * Records a Comment by `actor` on `target`. Callers check what it replies to is on the same
 * target, and that an anchor is on a Document whose Version `anchor.version` holds the passage.
 */
export async function insertComment(
  db: Queryable,
  target: CommentTarget,
  actor: Actor,
  input: {
    body: string;
    replyToCommentId: string | null;
    replyToActivityId: string | null;
    anchor: Omit<Anchor, "inCurrentVersion"> | null;
  },
  at: Date,
): Promise<Comment> {
  const { rows } = await db.query<CommentRow>(
    `WITH inserted AS (
       INSERT INTO comments (ticket_id, document_id, reply_to_comment_id, reply_to_activity_id, anchor_passage, anchor_version,
         body, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *)
     ${selectFrom("inserted")}`,
    [
      ...targetColumns(target),
      input.replyToCommentId,
      input.replyToActivityId,
      input.anchor?.passage ?? null,
      input.anchor?.version ?? null,
      input.body,
      at,
      ...actorColumns(actor),
    ],
  );
  return toComment(rows[0]!);
}

/** The Comments on `target`, oldest first. */
export async function listComments(db: Queryable, target: CommentTarget): Promise<Comment[]> {
  const [ticketId, documentId] = targetColumns(target);
  const { rows } = await db.query<CommentRow>(
    `${selectFrom("comments")} WHERE ${ticketId ? "c.ticket_id = $1" : "c.document_id = $1"} ORDER BY c.seq`,
    [ticketId ?? documentId],
  );
  return rows.map(toComment);
}

/** The Comment with this id, if it is on `target`. */
export async function findComment(db: Queryable, target: CommentTarget, id: string): Promise<Comment | undefined> {
  const [ticketId, documentId] = targetColumns(target);
  const { rows } = await db.query<CommentRow>(
    `${selectFrom("comments")} WHERE c.id = $1 AND ${ticketId ? "c.ticket_id = $2" : "c.document_id = $2"}`,
    [id, ticketId ?? documentId],
  );
  return rows[0] && toComment(rows[0]);
}

/** Where a Comment is: its Project (null for a Workspace Document) and its Ticket or Document. */
export interface CommentOn {
  projectId: string | null;
  ticket: { key: string; title: string } | null;
  document: { id: string; title: string } | null;
}

/** The Comments with these ids, in the order they were posted, each with where it is. */
export async function findCommentsByIds(db: Queryable, ids: string[]): Promise<{ comment: Comment; on: CommentOn }[]> {
  const { rows } = await db.query<CommentRow>(`${selectFrom("comments")} WHERE c.id = ANY($1) ORDER BY c.seq`, [ids]);
  return rows.map((row) => ({
    comment: toComment(row),
    on: {
      projectId: row.project_id,
      ticket: row.ticket_key === null ? null : { key: row.ticket_key, title: row.ticket_title! },
      document: row.document_id === null ? null : { id: row.document_id, title: row.document_title! },
    },
  }));
}

/** The shape of a Comment the API returns. */
export const publicComment = ({ ticketId: _, ...comment }: Comment) => comment;
