import { randomUUID } from "node:crypto";
import { insertDocumentRow, insertVersion } from "../knowledge/documents.js";
import { exportAttachments, importAttachments } from "./attachments.js";
import { exportComments, importComments } from "./comments.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { date, integer, isUuid, refuse, text } from "./fields.js";
import { slug } from "./format.js";
import { importProtection, protectionToExport } from "./protection.js";
import type { ImportContext } from "./import-context.js";

/**
 * Documents and Reports: `<name>.md` with what it says now, its Versions in `<name>.versions/`
 * when the export includes them, its Comments in `<name>.comments/` and its Attachments in `<name>.attachments/`. The page tree nests
 * the Documents under one in a folder of its name.
 */

/** A Document's row, as exporting reads it. */
export interface DocumentRow {
  id: string;
  title: string;
  body: string;
  version: number;
  protected: boolean;
  created_at: Date;
  updated_at: Date;
  claim_id?: string | null;
}

/** Writes a Document at `${base}.md`, with its Versions and Comments beside it. */
export async function exportDocument(ctx: ExportContext, base: string, d: DocumentRow): Promise<void> {
  const { rows: versions } = await ctx.db.query<ActorColumns & { number: number; title: string; body: string; at: Date; restored_from: number | null }>(
    "SELECT * FROM document_versions WHERE document_id = $1 ORDER BY number",
    [d.id],
  );
  const first = versions[0]!;
  const current = versions.find((v) => v.number === d.version)!;
  ctx.documentPaths.set(d.id, `${base}.md`);
  ctx.add(
    `${base}.md`,
    {
      title: d.title,
      claim: d.claim_id ?? undefined,
      version: d.version,
      ...(await protectionToExport(ctx, { kind: "document", id: d.id }, d.protected)),
      createdAt: iso(d.created_at),
      createdBy: ctx.actor(first),
      updatedAt: iso(d.updated_at),
      updatedBy: ctx.actor(current),
    },
    d.body,
  );
  if (ctx.scope.versions) {
    for (const v of versions) {
      ctx.add(`${base}.versions/${v.number}.md`, { title: v.title, at: iso(v.at), by: ctx.actor(v), restoredFrom: v.restored_from ?? undefined }, v.body);
    }
  }
  await exportComments(ctx, `${base}.comments`, "document_id", d.id);
  await exportAttachments(ctx, base, { documentId: d.id });
}

/** Writes the page tree of the Workspace (projectId null) or a Project into `dir`. */
export async function exportTree(ctx: ExportContext, dir: string, projectId: string | null): Promise<void> {
  const { rows } = await ctx.db.query<DocumentRow & { parent_id: string | null }>(
    `SELECT * FROM documents WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND ticket_id IS NULL ORDER BY position, created_at, id`,
    [ctx.scope.workspaceId, projectId],
  );
  const write = async (parentId: string | null, path: string) => {
    const siblings = rows.filter((d) => d.parent_id === parentId);
    for (const [i, d] of siblings.entries()) {
      const base = `${path}/${i + 1}-${slug(d.title)}`;
      await exportDocument(ctx, base, d);
      await write(d.id, base);
    }
  };
  await write(null, dir);
}

/** Where an imported Document goes: its Project (null for the Workspace's), its place in the page tree, or the Ticket a Report is on. */
export interface DocumentPlace {
  projectId: string | null;
  parentId: string | null;
  position: number;
  ticketId: string | null;
}

/**
 * Imports the Document at `${base}.md` with its Versions and Comments: one Version per file in
 * `${base}.versions/`, or without them a single Version holding what it says now. Returns its id.
 */
export async function importDocument(ctx: ImportContext, base: string, place: DocumentPlace): Promise<string> {
  const d = ctx.need(`${base}.md`);
  const title = text(d.data.title, `${d.path} title`);
  const versions = ctx.numbered(`${base}.versions`);
  const version = versions.length > 0 ? integer(d.data.version, `${d.path} version`) : 1;
  if (versions.length > 0 && !versions.some(([n]) => n === version)) refuse(`${d.path} is at Version ${version}, which ${base}.versions/ doesn't hold`);
  const claimId = place.ticketId === null ? null : isUuid(d.data.claim) ? d.data.claim : randomUUID();
  const id = await insertDocumentRow(ctx.db, {
    workspaceId: ctx.workspaceId,
    ...place,
    title,
    body: d.body,
    version,
    createdAt: date(d.data.createdAt, `${d.path} createdAt`),
    updatedAt: date(d.data.updatedAt, `${d.path} updatedAt`),
    claimId,
  });
  ctx.documentIds.set(`${base}.md`, id);
  await importProtection(ctx, { kind: "document", id }, d.data, d.path);
  if (versions.length === 0) {
    // Without its Versions, it starts at Version 1 by whoever first wrote it, so a Report keeps its Agent.
    const by = await ctx.actor(d.data.createdBy, `${d.path} createdBy`);
    await insertVersion(ctx.db, id, { number: 1, title, body: d.body, now: date(d.data.updatedAt, `${d.path} updatedAt`), actor: by, restoredFrom: null });
  }
  for (const [number, v] of versions) {
    const restoredFrom = v.data.restoredFrom === undefined || v.data.restoredFrom === null ? null : integer(v.data.restoredFrom, `${v.path} restoredFrom`);
    await insertVersion(ctx.db, id, {
      number,
      title: text(v.data.title, `${v.path} title`),
      body: v.body,
      now: date(v.data.at, `${v.path} at`),
      actor: await ctx.actor(v.data.by, `${v.path} by`),
      restoredFrom,
    });
  }
  await importComments(ctx, `${base}.comments`, { documentId: id }, undefined, version);
  await importAttachments(ctx, base, { documentId: id });
  return id;
}

/** Imports the page tree in `dir`: each `<name>.md` with the Documents under it in `<name>/`. */
export async function importTree(ctx: ImportContext, dir: string, projectId: string | null, parentId: string | null = null): Promise<void> {
  for (const [position, path] of ctx.filesIn(dir).entries()) {
    const base = path.slice(0, -".md".length);
    const id = await importDocument(ctx, base, { projectId, parentId, position, ticketId: null });
    await importTree(ctx, base, projectId, id);
  }
}
