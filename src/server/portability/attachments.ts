import { randomUUID } from "node:crypto";
import { attachmentKey, insertAttachment, type AttachmentTarget } from "../files/attachments.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { HttpError } from "../context.js";
import { sizeOf } from "./archive.js";
import { formatBytes } from "../files/sizes.js";
import { date, list, refuse, text } from "./fields.js";
import type { ImportContext } from "./import-context.js";

/**
 * The Attachments on a Ticket, Document or Comment: their files in `<name>.attachments/` beside its file, each named
 * `<n>-<name>` in the order they were attached, and `index.md` there, whose frontmatter lists what each file is, by
 * whom and when.
 */

interface AttachmentRow extends ActorColumns {
  id: string;
  name: string;
  content_type: string;
  size: string;
  at: Date;
}

/** A file name safe in any archive and file system: no folders, control characters or characters Windows refuses. */
const safeFileName = (name: string) => name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id an Attachment had in the export, so links to its file keep working, unless it is taken here or isn't one; then a new one. */
async function freeId(ctx: ImportContext, exported: unknown): Promise<string> {
  if (typeof exported !== "string" || !UUID.test(exported)) return randomUUID();
  const { rows } = await ctx.db.query("SELECT 1 FROM attachments WHERE id = $1", [exported]);
  return rows.length === 0 ? exported.toLowerCase() : randomUUID();
}

/** The column naming what an Attachment is on, and its id. */
const targetColumn = (target: AttachmentTarget): [column: string, id: string] =>
  "ticketId" in target ? ["ticket_id", target.ticketId] : "documentId" in target ? ["document_id", target.documentId] : ["comment_id", target.commentId];

/** Writes the Attachments on `target` (only its own, not those in its Comments) into `${base}.attachments/`. */
export async function exportAttachments(ctx: ExportContext, base: string, target: AttachmentTarget): Promise<void> {
  const [column, id] = targetColumn(target);
  const { rows } = await ctx.db.query<AttachmentRow>(`SELECT * FROM attachments WHERE ${column} = $1 ORDER BY seq`, [id]);
  if (rows.length === 0) return;
  const index = [];
  for (const [i, a] of rows.entries()) {
    // Numbered, so two files of the same name stay apart, and none is hidden as a name starting with a dot would be.
    const file = `${i + 1}-${safeFileName(a.name)}`;
    ctx.addStoredFile(`${base}.attachments/${file}`, attachmentKey(a.id), Number(a.size));
    index.push({ id: a.id, file, name: a.name, contentType: a.content_type, size: Number(a.size), at: iso(a.at), by: ctx.actor(a) });
  }
  ctx.add(`${base}.attachments/index.md`, { attachments: index });
}

/** Imports the Attachments listed in `${base}.attachments/index.md`, if there is one, onto `target`. */
export async function importAttachments(ctx: ImportContext, base: string, target: AttachmentTarget): Promise<void> {
  const index = ctx.read(`${base}.attachments/index.md`);
  if (!index) return;
  for (const [i, entry] of list(index, "attachments").entries()) {
    const where = `${index.path} attachments[${i}]`;
    const path = `${base}.attachments/${text(entry.file, `${where} file`)}`;
    const contents = ctx.folder.get(path) ?? refuse(`${where} names ${path}, which the export doesn't hold`);
    const { attachmentMaxBytes } = await ctx.fileLimits();
    if (sizeOf(contents) > attachmentMaxBytes) {
      throw new HttpError(413, `${path} is larger than ${formatBytes(attachmentMaxBytes)}, the most an Attachment may take in this Workspace`);
    }
    const id = await freeId(ctx, entry.id);
    const size = await ctx.storeFile(attachmentKey(id), contents);
    await insertAttachment(ctx.db, {
      id,
      workspaceId: ctx.workspaceId,
      target,
      name: text(entry.name, `${where} name`),
      contentType: text(entry.contentType, `${where} contentType`),
      size,
      actor: await ctx.actor(entry.by, `${where} by`),
      now: date(entry.at, `${where} at`),
    });
  }
}
