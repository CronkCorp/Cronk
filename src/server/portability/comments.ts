import { insertComment, type CommentTarget } from "../conversation/comments.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { date, integer, refuse, text } from "./fields.js";
import type { ImportContext } from "./import-context.js";

/**
 * Comments on a Ticket or Document: a folder beside it of files numbered from 1 in the order they
 * were posted. Replies name the Comment or Activity they answer by its number.
 */

/** Writes the Comments on a Ticket or Document into `dir`; returns their numbers by id. */
export async function exportComments(
  ctx: ExportContext,
  dir: string,
  on: "ticket_id" | "document_id",
  id: string,
  activityNumbers = new Map<string, number>(),
): Promise<Map<string, number>> {
  const { rows } = await ctx.db.query<
    ActorColumns & {
      id: string;
      reply_to_comment_id: string | null;
      reply_to_activity_id: string | null;
      anchor_passage: string | null;
      anchor_version: number | null;
      body: string;
      at: Date;
    }
  >(`SELECT * FROM comments WHERE ${on} = $1 ORDER BY seq`, [id]);
  const numbers = new Map(rows.map((c, i) => [c.id, i + 1]));
  for (const c of rows) {
    ctx.add(
      `${dir}/${numbers.get(c.id)}.md`,
      {
        at: iso(c.at),
        by: ctx.actor(c),
        replyToComment: c.reply_to_comment_id === null ? undefined : numbers.get(c.reply_to_comment_id),
        replyToActivity: c.reply_to_activity_id === null ? undefined : activityNumbers.get(c.reply_to_activity_id),
        anchor: c.anchor_passage === null ? undefined : { passage: c.anchor_passage, version: c.anchor_version },
      },
      c.body,
    );
  }
  return numbers;
}

/**
 * Imports the Comments in `dir` onto `target`; returns their ids by number. `activities` are the
 * Ticket's Activities by number, and an anchor names at most the Document's `documentVersion`.
 */
export async function importComments(
  ctx: ImportContext,
  dir: string,
  target: CommentTarget,
  activities = new Map<number, string>(),
  documentVersion = Infinity,
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const [n, c] of ctx.numbered(dir)) {
    const replyToCommentId =
      c.data.replyToComment === undefined ? null : (ids.get(Number(c.data.replyToComment)) ?? refuse(`${c.path} replies to a Comment that isn't before it`));
    const replyToActivityId =
      c.data.replyToActivity === undefined
        ? null
        : (activities.get(Number(c.data.replyToActivity)) ?? refuse(`${c.path} replies to an Activity that isn't on its Ticket`));
    const anchor = c.data.anchor as { passage?: unknown; version?: unknown } | undefined;
    const comment = await insertComment(
      ctx.db,
      target,
      await ctx.actor(c.data.by, `${c.path} by`),
      {
        body: c.body,
        replyToCommentId,
        replyToActivityId,
        anchor: anchor
          ? { passage: text(anchor.passage, `${c.path} anchor.passage`), version: Math.min(integer(anchor.version, `${c.path} anchor.version`), documentVersion) }
          : null,
      },
      date(c.data.at, `${c.path} at`),
    );
    ids.set(n, comment.id);
  }
  return ids;
}
