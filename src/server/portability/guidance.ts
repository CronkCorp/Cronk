import { writeGuidance } from "../knowledge/guidance.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { date, refuse, type File } from "./fields.js";
import type { ImportContext } from "./import-context.js";
import { importSuggestions, suggestionsToExport } from "./suggestions.js";

/** Guidance: the Workspace's in `guidance.md`, a Project's beside its `project.md`, with its Versions in `guidance.versions/`. */

/**
 * Writes Guidance at `${base}.md`, with its Versions beside it and its Suggestions in its frontmatter, if anyone has
 * written it or suggested it: Guidance nobody wrote is written at Version 0, empty, to hold its Suggestions.
 */
export async function exportGuidance(ctx: ExportContext, base: string, projectId: string | null): Promise<void> {
  const { rows } = await ctx.db.query<ActorColumns & { version: number; markdown: string; at: Date }>(
    "SELECT version, markdown, at, actor_user_id, actor_agent_id, actor_session_id FROM guidance_versions WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY version",
    [ctx.scope.workspaceId, projectId],
  );
  const current = rows.at(-1);
  const suggestions = await suggestionsToExport(ctx, { kind: "guidance", projectId });
  if (!current) {
    if (suggestions.suggestions) ctx.add(`${base}.md`, { version: 0, ...suggestions }, "");
    return;
  }
  ctx.add(`${base}.md`, { version: current.version, at: iso(current.at), by: ctx.actor(current), ...suggestions }, current.markdown);
  if (ctx.scope.versions) for (const v of rows) ctx.add(`${base}.versions/${v.version}.md`, { at: iso(v.at), by: ctx.actor(v) }, v.markdown);
}

/** Imports Guidance from `${base}.md`, with its Versions from `${base}.versions/` if the export has them, each saved on the one before. */
export async function importGuidance(ctx: ImportContext, base: string, projectId: string | null): Promise<void> {
  const current = ctx.read(`${base}.md`);
  if (!current) return;
  const versions = ctx.numbered(`${base}.versions`);
  // Version 0 is Guidance nobody wrote, there only for its Suggestions.
  const saved: [number, File][] = versions.length > 0 ? versions : current.data.version === 0 ? [] : [[1, current]];
  for (const [n, v] of saved) {
    // A User, or an Agent whose Suggestion a User accepted unchanged.
    const by = await ctx.actor(v.data.by, `${v.path} by`);
    const written = await writeGuidance(
      ctx.db,
      { workspaceId: ctx.workspaceId, projectId },
      { markdown: v.body, baseVersion: n - 1, actor: by, now: date(v.data.at, `${v.path} at`) },
    );
    if (!written) refuse(`${v.path} must follow Version ${n - 1}: Guidance Versions are numbered 1, 2, 3 and so on, with none missing`);
  }
  await importSuggestions(ctx, { kind: "guidance", projectId }, projectId, current.data, current.path);
}
