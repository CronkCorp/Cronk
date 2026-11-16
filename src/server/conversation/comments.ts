import { actorColumns, toRecordedActor, type Actor, type RecordedActor, type RecordedActorRow, type StoredActor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { recordMentions } from "../knowledge/mentions.js";

/**
 * Comments: conversation any Actor posts on a Ticket, a Document or an Artifact, as opposed to an
 * Agent's own Activities. A Comment may reply to another Comment on the same Ticket, Document or
 * Artifact, or to an Activity on the same Ticket. The body is Markdown.
 */
export interface Comment {
  id: string;
  /** Set on a Comment on a Ticket. */
  ticketId: string | null;
  ticketKey: string | null;
  /** Set on a Comment on a Document. */
  documentId: string | null;
  /** Set on a Comment on an Artifact. */
  artifactId: string | null;
  /** On an Artifact: the Version whoever posted it was viewing. */
  artifactVersion: number | null;
  replyToCommentId: string | null;
  replyToActivityId: string | null;
  /** The passage of its Document it is anchored to; null when it isn't anchored. */
  anchor: Anchor | null;
  body: string;
  /** Whether a User posted it sending its Ticket back from review. */
  sendBack: boolean;
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

/**
 * What a Comment is posted on: a Ticket, a Document, or an Artifact. A Comment posted on an Artifact
 * records `version`, the Version being viewed; listing and looking up Comments ignore it.
 */
export type CommentTarget = { ticketId: string } | { documentId: string } | { artifactId: string; version?: number };

interface CommentRow extends RecordedActorRow {
  id: string;
  ticket_id: string | null;
  ticket_key: string | null;
  document_id: string | null;
  artifact_id: string | null;
  artifact_version: number | null;
  reply_to_comment_id: string | null;
  reply_to_activity_id: string | null;
  anchor_passage: string | null;
  anchor_version: number | null;
  anchor_in_current_version: boolean | null;
  body: string;
  send_back: boolean;
  at: Date;
  ticket_title: string | null;
  document_title: string | null;
  artifact_title: string | null;
  project_id: string | null;
}

/**
 * Selects Comments, with their Ticket's key, Actor, whether their anchor is still in the Document,
 * and the Project and title of the Ticket, Document or Artifact they are on, from `source` (the table, or a CTE of new rows) as `c`.
 */
const selectFrom = (source: string) => `
  SELECT c.id, c.ticket_id, p.key || '-' || t.number AS ticket_key, c.document_id, c.artifact_id, c.artifact_version, c.reply_to_comment_id, c.reply_to_activity_id,
    c.anchor_passage, c.anchor_version, strpos(d.body, c.anchor_passage) > 0 AS anchor_in_current_version,
    c.body, c.send_back, c.at, t.title AS ticket_title, d.title AS document_title, x.title AS artifact_title,
    coalesce(t.project_id, d.project_id, x.project_id) AS project_id, u.id AS user_id, u.name AS user_name, a.id AS agent_id, a.name AS agent_name, c.actor_session_id AS session_id
  FROM ${source} c JOIN users u ON u.id = c.actor_user_id LEFT JOIN agents a ON a.id = c.actor_agent_id
    LEFT JOIN tickets t ON t.id = c.ticket_id LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN documents d ON d.id = c.document_id
    LEFT JOIN artifacts x ON x.id = c.artifact_id`;

const toComment = (row: CommentRow): Comment => ({
  id: row.id,
  ticketId: row.ticket_id,
  ticketKey: row.ticket_key,
  documentId: row.document_id,
  artifactId: row.artifact_id,
  artifactVersion: row.artifact_version,
  replyToCommentId: row.reply_to_comment_id,
  replyToActivityId: row.reply_to_activity_id,
  anchor:
    row.anchor_passage === null
      ? null
      : { passage: row.anchor_passage, version: row.anchor_version!, inCurrentVersion: row.anchor_in_current_version! },
  body: row.body,
  sendBack: row.send_back,
  at: row.at,
  actor: toRecordedActor(row),
});

/** The `ticket_id`, `document_id`, `artifact_id` and `artifact_version` a Comment on `target` is stored with. */
function targetColumns(target: CommentTarget): [ticketId: string | null, documentId: string | null, artifactId: string | null, artifactVersion: number | null] {
  if ("ticketId" in target) return [target.ticketId, null, null, null];
  if ("documentId" in target) return [null, target.documentId, null, null];
  if (target.version === undefined) throw new Error("A Comment on an Artifact records the Version being viewed");
  return [null, null, target.artifactId, target.version];
}

/** SQL condition: the Comment `c` is on `target`, whose id is the parameter `param`, such as `$1`; with that id. */
function onTarget(target: CommentTarget, param: string): [condition: string, id: string] {
  if ("ticketId" in target) return [`c.ticket_id = ${param}`, target.ticketId];
  if ("documentId" in target) return [`c.document_id = ${param}`, target.documentId];
  return [`c.artifact_id = ${param}`, target.artifactId];
}

/**
 * Records a Comment by `actor` on `target`. Callers check what it replies to is on the same
 * target, and that an anchor is on a Document whose Version `anchor.version` holds the passage.
 */
export async function insertComment(
  db: Queryable,
  target: CommentTarget,
  actor: Actor | StoredActor,
  input: {
    body: string;
    replyToCommentId: string | null;
    replyToActivityId: string | null;
    anchor: Omit<Anchor, "inCurrentVersion"> | null;
    /** Set for the Comment a Ticket is sent back from review with; false if left out. */
    sendBack?: boolean;
  },
  at: Date,
): Promise<Comment> {
  const { rows } = await db.query<CommentRow>(
    `WITH inserted AS (
       INSERT INTO comments (ticket_id, document_id, artifact_id, artifact_version, reply_to_comment_id, reply_to_activity_id,
         anchor_passage, anchor_version, body, send_back, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *)
     ${selectFrom("inserted")}`,
    [
      ...targetColumns(target),
      input.replyToCommentId,
      input.replyToActivityId,
      input.anchor?.passage ?? null,
      input.anchor?.version ?? null,
      input.body,
      input.sendBack ?? false,
      at,
      ...actorColumns(actor),
    ],
  );
  await recordMentions(db, { kind: "comment", id: rows[0]!.id });
  return toComment(rows[0]!);
}

/** The Comments on `target`, oldest first. */
export async function listComments(db: Queryable, target: CommentTarget): Promise<Comment[]> {
  const [on, targetId] = onTarget(target, "$1");
  const { rows } = await db.query<CommentRow>(`${selectFrom("comments")} WHERE ${on} ORDER BY c.seq`, [targetId]);
  return rows.map(toComment);
}

/** The Comment with this id, if it is on `target`. */
export async function findComment(db: Queryable, target: CommentTarget, id: string): Promise<Comment | undefined> {
  const [on, targetId] = onTarget(target, "$2");
  const { rows } = await db.query<CommentRow>(`${selectFrom("comments")} WHERE c.id = $1 AND ${on}`, [id, targetId]);
  return rows[0] && toComment(rows[0]);
}

/** Where a Comment is: its Project (null for a Workspace Document or Artifact) and its Ticket, Document or Artifact. */
export interface CommentOn {
  projectId: string | null;
  ticket: { key: string; title: string } | null;
  document: { id: string; title: string } | null;
  /** On an Artifact: which, with the Version the Comment was on. */
  artifact: { id: string; title: string; version: number } | null;
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
      artifact: row.artifact_id === null ? null : { id: row.artifact_id, title: row.artifact_title!, version: row.artifact_version! },
    },
  }));
}

/** The shape of a Comment the API returns. */
export const publicComment = ({ ticketId: _, ...comment }: Comment) => comment;
