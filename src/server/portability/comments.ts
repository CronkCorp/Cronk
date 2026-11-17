import { insertComment, type CommentTarget } from "../conversation/comments.js";
import { attachmentsOfComments, importAttachments, writeAttachments } from "./attachments.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { date, integer, refuse, text } from "./fields.js";
import type { ImportContext } from "./import-context.js";

/**
 * Comments on a Ticket, Document or Artifact: a folder beside it of files numbered from 1 in the order they
 * were posted, each with its Attachments in `<n>.attachments/`. Replies name the Comment or Activity
 * they answer by its number; a Comment on an Artifact names the Version it is on.
 */

/** Writes the Comments on a Ticket, Document or Artifact into `dir`; returns their numbers by id. */
export async function exportComments(
  ctx: ExportContext,
  dir: string,
  on: "ticket_id" | "document_id" | "artifact_id",
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
      artifact_version: number | null;
      body: string;
      send_back: boolean;
      at: Date;
    }
  >(`SELECT * FROM comments WHERE ${on} = $1 ORDER BY seq`, [id]);
  const numbers = new Map(rows.map((c, i) => [c.id, i + 1]));
  const attachments = await attachmentsOfComments(ctx, rows.map((c) => c.id));
  for (const c of rows) {
    ctx.add(
      `${dir}/${numbers.get(c.id)}.md`,
      {
        at: iso(c.at),
        by: ctx.actor(c),
        replyToComment: c.reply_to_comment_id === null ? undefined : numbers.get(c.reply_to_comment_id),
        replyToActivity: c.reply_to_activity_id === null ? undefined : activityNumbers.get(c.reply_to_activity_id),
        anchor: c.anchor_passage === null ? undefined : { passage: c.anchor_passage, version: c.anchor_version },
        version: c.artifact_version ?? undefined,
        sendBack: c.send_back || undefined,
      },
      c.body,
    );
    writeAttachments(ctx, `${dir}/${numbers.get(c.id)}`, attachments.get(c.id) ?? []);
  }
  return numbers;
}

/**
 * Imports the Comments in `dir` onto `target`; returns their ids by number. `activities` are the
 * Ticket's Activities by number, and an anchor names at most the Document's `documentVersion`. On an
 * Artifact, `artifactVersions` are the numbers of the Versions imported, oldest first: a Comment on one
 * the export left out goes on the oldest imported after it.
 */
export async function importComments(
  ctx: ImportContext,
  dir: string,
  target: CommentTarget,
  activities = new Map<number, string>(),
  documentVersion = Infinity,
  artifactVersions: number[] = [],
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
    const version = anchor ? Math.min(integer(anchor.version, `${c.path} anchor.version`), documentVersion) : null;
    const passage = anchor ? text(anchor.passage, `${c.path} anchor.passage`) : null;
    const sendBack = c.data.sendBack === true;
    if (sendBack && !("ticketId" in target)) refuse(`${c.path} sendBack is only for a Comment on a Ticket`);
    const at = date(c.data.at, `${c.path} at`);
    const by = await ctx.actor(c.data.by, `${c.path} by`);
    const on = "artifactId" in target ? { artifactId: target.artifactId, version: artifactVersionOf(c.data.version, c.path, artifactVersions) } : target;
    const comment = await insertComment(
      ctx.db,
      on,
      by,
      { body: c.body, replyToCommentId, replyToActivityId, anchor: passage === null ? null : { passage, version: version! }, sendBack },
      at,
    );
    ids.set(n, comment.id);
    await importAttachments(ctx, `${dir}/${n}`, { commentId: comment.id });
  }
  return ids;
}

/** The imported Artifact Version a Comment on Version `exported` goes on: that one, or the oldest imported after it. */
function artifactVersionOf(exported: unknown, path: string, imported: number[]): number {
  const version = integer(exported, `${path} version`);
  return imported.find((n) => n >= version) ?? refuse(`${path} is on Version ${version}, after every Version the export holds`);
}
