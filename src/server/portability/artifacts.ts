import { randomUUID } from "node:crypto";
import { artifactFileKey, insertArtifactRow, insertArtifactVersion, type ArtifactFile } from "../files/artifacts.js";
import { mediaTypeOf } from "../files/artifact-routes.js";
import { extraOrigins, type ExtraOrigin } from "../files/origins.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { HttpError } from "../context.js";
import { sizeOf } from "./archive.js";
import { formatBytes } from "../files/sizes.js";
import { date, integer, isUuid, list, refuse, text } from "./fields.js";
import { slug } from "./format.js";
import { importProtection, protectionToExport } from "./protection.js";
import { exportComments, importComments } from "./comments.js";
import type { ImportContext } from "./import-context.js";
import type { ImportedTickets } from "./tickets.js";

/**
 * Artifacts: `artifacts/<n>-<title>.md` for the Workspace's, and `projects/<KEY>/artifacts/` for a Project's, numbered in
 * the order they were created. Its frontmatter holds the Artifact and its Versions; each Version's files are in
 * `<n>-<title>/<version>/` as they were published, and its Comments in `<n>-<title>.comments/`. Every Version is exported when the export includes Versions, otherwise
 * only the latest, keeping its number so links to it keep working.
 */

interface ArtifactRow {
  id: string;
  title: string;
  version: number;
  protected: boolean;
  created_at: Date;
}

interface VersionRow extends ActorColumns {
  number: number;
  title: string;
  at: Date;
  source_ticket: string | null;
  extra_origins: ExtraOrigin[];
}

/** Writes the Artifacts of the Workspace (projectId null) or a Project into `${dir}artifacts/`. */
export async function exportArtifacts(ctx: ExportContext, dir: string, projectId: string | null): Promise<void> {
  const { rows } = await ctx.db.query<ArtifactRow>(
    "SELECT id, title, version, protected, created_at FROM artifacts WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY created_at, id",
    [ctx.scope.workspaceId, projectId],
  );
  for (const [i, a] of rows.entries()) {
    const base = `${dir}artifacts/${i + 1}-${slug(a.title)}`;
    const { rows: versions } = await ctx.db.query<VersionRow>(
      `SELECT v.*, sp.key || '-' || st.number AS source_ticket
       FROM artifact_versions v LEFT JOIN tickets st ON st.id = v.source_ticket_id LEFT JOIN projects sp ON sp.id = st.project_id
       WHERE v.artifact_id = $1 AND ($2::boolean OR v.number = $3) ORDER BY v.number`,
      [a.id, ctx.scope.versions, a.version],
    );
    const written = [];
    for (const v of versions) {
      const { rows: files } = await ctx.db.query<{ id: string; path: string; content_type: string; size: string }>(
        "SELECT id, path, content_type, size FROM artifact_files WHERE artifact_id = $1 AND version = $2 ORDER BY path",
        [a.id, v.number],
      );
      for (const f of files) ctx.addStoredFile(`${base}/${v.number}/${f.path}`, artifactFileKey(f.id), Number(f.size));
      written.push({
        number: v.number,
        title: v.title,
        at: iso(v.at),
        by: ctx.actor(v),
        sourceTicket: v.source_ticket ?? undefined,
        ...(v.extra_origins.length > 0 && { extraOrigins: v.extra_origins }),
        files: files.map((f) => ({ path: f.path, contentType: f.content_type })),
      });
    }
    ctx.artifactPaths.set(a.id, `${base}.md`);
    ctx.add(`${base}.md`, {
      id: a.id,
      title: a.title,
      version: a.version,
      ...(await protectionToExport(ctx, { kind: "artifact", id: a.id }, a.protected)),
      createdAt: iso(a.created_at),
      versions: written,
    });
    await exportComments(ctx, `${base}.comments`, "artifact_id", a.id);
  }
}

/** Imports the Artifacts in `${dir}artifacts/`, if any, into the Workspace (projectId null) or a Project, after its Tickets. */
export async function importArtifacts(ctx: ImportContext, dir: string, projectId: string | null, tickets: ImportedTickets): Promise<void> {
  const prefix = `${dir}artifacts/`;
  const paths = [...ctx.folder.keys()].filter((p) => p.startsWith(prefix) && /^[^/]+\.md$/.test(p.slice(prefix.length)));
  paths.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const path of paths) {
    const file = ctx.need(path);
    const base = path.slice(0, -".md".length);
    const where = (field: string) => `${path} ${field}`;
    const id = await freeId(ctx, file.data.id);
    const created = await insertArtifactRow(ctx.db, {
      id,
      workspaceId: ctx.workspaceId,
      projectId,
      title: text(file.data.title, where("title")),
      now: date(file.data.createdAt, where("createdAt")),
    });
    const versions = list(file, "versions");
    if (versions.length === 0) refuse(`${path} lists no versions`);
    let artifact = created;
    for (const [i, v] of versions.entries()) {
      const at = (field: string) => where(`versions[${i}] ${field}`);
      const number = integer(v.number, at("number"));
      if (number <= artifact.version) refuse(`${at("number")} must count up`);
      const listed = Array.isArray(v.files) ? (v.files as Record<string, unknown>[]) : refuse(`${at("files")} must be a list`);
      const contents = listed.map((f, j) => {
        const filePath = text(f.path, at(`files[${j}] path`));
        return { f, filePath, contents: ctx.folder.get(`${base}/${number}/${filePath}`) ?? refuse(`${at("files")} names ${filePath}, which the export doesn't hold in ${base}/${number}/`) };
      });
      // Within the Workspace's limits, as publishing the Version would be.
      const limits = await ctx.fileLimits();
      if (contents.length > limits.artifactMaxFiles) {
        throw new HttpError(413, `${base}/${number}/ holds ${contents.length} files, more than the ${limits.artifactMaxFiles} an Artifact Version may hold in this Workspace`);
      }
      const bytes = contents.reduce((sum, c) => sum + sizeOf(c.contents), 0);
      if (bytes > limits.artifactMaxBytes) {
        throw new HttpError(413, `${base}/${number}/'s files take ${formatBytes(bytes)}, more than the ${formatBytes(limits.artifactMaxBytes)} an Artifact Version may take in this Workspace`);
      }
      const files: ArtifactFile[] = [];
      for (const { f, filePath, contents: file } of contents) {
        const fileId = randomUUID();
        const size = await ctx.storeFile(artifactFileKey(fileId), file);
        files.push({ id: fileId, path: filePath, contentType: typeof f.contentType === "string" ? f.contentType : mediaTypeOf(filePath), size });
      }
      if (!files.some((f) => f.path === "index.html")) refuse(`${at("files")} must list index.html, the page an Artifact opens on`);
      const sourceTicket = typeof v.sourceTicket === "string" ? (tickets.ids.get(v.sourceTicket.toUpperCase()) ?? null) : null;
      const title = text(v.title, at("title"));
      const published = await insertArtifactVersion(
        ctx.db,
        artifact,
        {
          title,
          actor: await ctx.actor(v.by, at("by")),
          sourceTicketId: sourceTicket,
          files,
          // Exports from before declared extras have none.
          extraOrigins: v.extraOrigins === undefined ? [] : extraOrigins(v.extraOrigins, at("extraOrigins")),
          now: date(v.at, at("at")),
        },
        number,
      );
      artifact = { id: published.id, workspaceId: published.workspaceId, version: published.version };
    }
    await importProtection(ctx, { kind: "artifact", id }, file.data, path);
    const imported = versions.map((v, i) => integer(v.number, where(`versions[${i}] number`)));
    await importComments(ctx, `${base}.comments`, { artifactId: id }, undefined, undefined, imported);
  }
}

/** The id an Artifact had in the export, so links to it keep working, unless it is taken here or isn't one; then a new one. */
async function freeId(ctx: ImportContext, exported: unknown): Promise<string> {
  if (!isUuid(exported)) return randomUUID();
  const { rows } = await ctx.db.query("SELECT 1 FROM artifacts WHERE id = $1", [exported]);
  return rows.length === 0 ? exported.toLowerCase() : randomUUID();
}
