import type { Queryable } from "../db/database.js";
import type { Folder } from "./archive.js";
import { exportArtifacts } from "./artifacts.js";
import { exportDecisions } from "./decisions.js";
import type { FileStore } from "../files/store.js";
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

/** Builds the export's files. Run inside a read-only, repeatable-read transaction so they agree with each other. */
export async function exportFolder(db: Queryable, scope: ExportScope, files: FileStore): Promise<Folder> {
  const ctx = await ExportContext.start(db, scope, files);
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

  // README first, then people, so someone opening the archive reads them first.
  return new Map([...ctx.folder].sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0)));
}

const rank = (path: string) => (path === "README.md" ? 0 : path === "people.md" ? 1 : 2);

/**
 * Builds the `docs/adr/` files of one scope's Decisions alone: the Workspace's own when `project`
 * is null, else that Project's. Each file is what the full export writes for it, without Versions.
 */
export async function exportDecisionsFolder(db: Queryable, workspaceId: string, project: { id: string; key: string } | null, now: Date, files: FileStore): Promise<Folder> {
  const ctx = await ExportContext.start(db, { workspaceId, projectId: project?.id ?? null, versions: false, now }, files);
  await exportDecisions(ctx, "", project?.id ?? null, project?.key ?? null);
  return ctx.folder;
}
