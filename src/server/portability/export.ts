import type { Queryable } from "../db/database.js";
import { isStored, type FileContents, type StoredFolder } from "./archive.js";
import { exportArtifacts } from "./artifacts.js";
import { exportDecisions } from "./decisions.js";
import { exportTree } from "./documents.js";
import { ExportContext, iso, type ExportScope } from "./export-context.js";
import { FORMAT, README } from "./format.js";
import { exportGuidance } from "./guidance.js";
import { exportPeople } from "./people.js";
import { exportProject, type ProjectRow } from "./projects.js";
import { getWorkspace } from "../workspace/workspaces.js";
import { exportTerms } from "./terms.js";
import { exportTickets } from "./tickets.js";
import { exportTranscripts } from "./transcripts.js";
import { exportWorkspaceSettings } from "./workspace.js";

/**
 * Exporting the Workspace or one Project as a folder of Markdown files with YAML frontmatter
 * (ADR 0003). `format.ts` describes the layout; `import.ts` reads it back. Each kind of record
 * has its own module beside this one.
 */

export type { ExportScope };

/**
 * Builds the export's files. Run inside a read-only, repeatable-read transaction so they agree with each other. The
 * files of Attachments and Artifacts stand in it by their keys in the file store, to be read as the archive is packed.
 */
export async function exportFolder(db: Queryable, scope: ExportScope): Promise<StoredFolder> {
  const ctx = await ExportContext.start(db, scope);
  if (scope.projectId === null) {
    await exportWorkspaceSettings(ctx);
    await exportGuidance(ctx, "guidance", null);
    await exportTree(ctx, "documents", null);
    await exportDecisions(ctx, "", null, null);
    await exportTerms(ctx, "", { projectId: null, workspaceName: (await getWorkspace(db, scope.workspaceId)).name });
    await exportArtifacts(ctx, "", null);
  }
  const { rows: projects } = await db.query<ProjectRow>("SELECT * FROM projects WHERE workspace_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY key", [
    scope.workspaceId,
    scope.projectId,
  ]);
  for (const p of projects) {
    const dir = `projects/${p.key}`;
    const statusNow = await exportProject(ctx, dir, p);
    await exportGuidance(ctx, `${dir}/guidance`, p.id);
    await exportTree(ctx, `${dir}/documents`, p.id);
    await exportDecisions(ctx, dir, p.id, p.key);
    await exportTerms(ctx, `${dir}/`, { projectId: p.id, projectKey: p.key });
    await exportTickets(ctx, dir, p, statusNow);
    await exportArtifacts(ctx, `${dir}/`, p.id);
  }
  ctx.writePending();
  // Transcripts are kept only in the full export.
  if (scope.projectId === null) await exportTranscripts(ctx);
  // Last, so a Project export lists only who the other files name.
  await exportPeople(ctx);
  const whole = scope.projectId === null;
  ctx.add("README.md", { cronk: { format: FORMAT, scope: whole ? "workspace" : "project", exportedAt: iso(scope.now), versions: scope.versions } }, README);

  // README first, then people, so someone opening the archive reads them first; then the other Markdown files, and the stored
  // files last, so an import has every Markdown file, workspace.md's limits among them, before the first large file arrives.
  const rank = ([path, contents]: [string, FileContents]) => (path === "README.md" ? 0 : path === "people.md" ? 1 : isStored(contents) ? 3 : 2);
  return new Map([...ctx.folder].sort((a, b) => rank(a) - rank(b) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}
