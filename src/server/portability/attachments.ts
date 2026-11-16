import { randomUUID } from "node:crypto";
import { attachmentKey, insertAttachment } from "../files/attachments.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { date, refuse, text } from "./fields.js";
import type { ImportContext } from "./import-context.js";
import { isRecord } from "./format.js";

/**
 * A Ticket's Attachments: their files in `<KEY>.attachments/`, each named `<n>-<name>` in the order they were
 * attached, and `index.md` there, whose frontmatter lists what each file is, by whom and when.
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

/** Writes the Attachments of the Ticket `ticketId` into `${base}.attachments/`. */
export async function exportAttachments(ctx: ExportContext, base: string, ticketId: string): Promise<void> {
  const { rows } = await ctx.db.query<AttachmentRow>("SELECT * FROM attachments WHERE ticket_id = $1 ORDER BY seq", [ticketId]);
  if (rows.length === 0) return;
  const index = [];
  for (const [i, a] of rows.entries()) {
    // Numbered, so two files of the same name stay apart, and none is hidden as a name starting with a dot would be.
    const file = `${i + 1}-${safeFileName(a.name)}`;
    await ctx.addStoredFile(`${base}.attachments/${file}`, attachmentKey(a.id));
    index.push({ id: a.id, file, name: a.name, contentType: a.content_type, size: Number(a.size), at: iso(a.at), by: ctx.actor(a) });
  }
  ctx.add(`${base}.attachments/index.md`, { attachments: index });
}

/** Imports the Attachments listed in `${base}.attachments/index.md`, if there is one, onto the Ticket `ticketId`. */
export async function importAttachments(ctx: ImportContext, base: string, ticketId: string): Promise<void> {
  const index = ctx.read(`${base}.attachments/index.md`);
  if (!index) return;
  const listed = index.data.attachments ?? [];
  if (!Array.isArray(listed)) refuse(`${index.path} attachments must be a list`);
  for (const [i, entry] of listed.entries()) {
    const where = `${index.path} attachments[${i}]`;
    if (!isRecord(entry)) refuse(`${where} must say what the file is`);
    const path = `${base}.attachments/${text(entry.file, `${where} file`)}`;
    const contents = ctx.folder.get(path) ?? refuse(`${where} names ${path}, which the export doesn't hold`);
    const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
    const id = await freeId(ctx, entry.id);
    await ctx.storeFile(attachmentKey(id), bytes);
    await insertAttachment(ctx.db, {
      id,
      workspaceId: ctx.workspaceId,
      ticketId,
      name: text(entry.name, `${where} name`),
      contentType: text(entry.contentType, `${where} contentType`),
      size: bytes.length,
      actor: await ctx.actor(entry.by, `${where} by`),
      now: date(entry.at, `${where} at`),
    });
  }
}
