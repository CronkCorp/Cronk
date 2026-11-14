import { writeGuidance } from "../knowledge/guidance.js";
import { iso, type ExportContext } from "./export-context.js";
import { date, refuse, type File } from "./fields.js";
import type { ImportContext } from "./import-context.js";

/** Guidance: the Workspace's in `guidance.md`, a Project's beside its `project.md`, with its Versions in `guidance.versions/`. */

/** Writes Guidance at `${base}.md`, with its Versions beside it, if anyone has written it. */
export async function exportGuidance(ctx: ExportContext, base: string, projectId: string | null): Promise<void> {
  const { rows } = await ctx.db.query<{ version: number; markdown: string; at: Date; actor_user_id: string }>(
    "SELECT version, markdown, at, actor_user_id FROM guidance_versions WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY version",
    [ctx.scope.workspaceId, projectId],
  );
  const current = rows.at(-1);
  if (!current) return;
  ctx.add(`${base}.md`, { version: current.version, at: iso(current.at), by: ctx.user(current.actor_user_id) }, current.markdown);
  if (ctx.scope.versions) for (const v of rows) ctx.add(`${base}.versions/${v.version}.md`, { at: iso(v.at), by: ctx.user(v.actor_user_id) }, v.markdown);
}

/** Imports Guidance from `${base}.md`, with its Versions from `${base}.versions/` if the export has them, each saved on the one before. */
export async function importGuidance(ctx: ImportContext, base: string, projectId: string | null): Promise<void> {
  const current = ctx.read(`${base}.md`);
  if (!current) return;
  const versions = ctx.numbered(`${base}.versions`);
  const saved: [number, File][] = versions.length > 0 ? versions : [[1, current]];
  for (const [n, v] of saved) {
    const by = await ctx.actor(v.data.by, `${v.path} by`);
    if (by.kind !== "user") refuse(`${v.path} by must name a User: only Users write Guidance`);
    const written = await writeGuidance(
      ctx.db,
      { workspaceId: ctx.workspaceId, projectId },
      { markdown: v.body, baseVersion: n - 1, userId: by.userId, now: date(v.data.at, `${v.path} at`) },
    );
    if (!written) refuse(`${v.path} must follow Version ${n - 1}: Guidance Versions are numbered 1, 2, 3 and so on, with none missing`);
  }
}
