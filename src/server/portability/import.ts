import { HttpError } from "../context.js";
import { lockUntilCommit } from "../db/database.js";
import type { Queryable } from "../db/database.js";
import { unwrapFolder, type Folder } from "./archive.js";
import { natural, refuse } from "./fields.js";
import { FORMAT } from "./format.js";
import { importGuidance } from "./guidance.js";
import { importTree } from "./documents.js";
import { ImportContext } from "./import-context.js";
import { importPeople } from "./people.js";
import { importProject } from "./projects.js";
import { importRelations, importTickets, type PendingRelation } from "./tickets.js";
import { importWorkspaceSettings } from "./workspace.js";

/**
 * Importing an export (see `format.ts`) back: a Workspace export into a Workspace that holds
 * nothing yet, or a Project export as a new Project. Users are matched by email and Agents by
 * Owner and name; those not found are created, Users deactivated since they have no password here.
 * Each kind of record has its own module beside this one.
 */

/** What an import brought in. */
export interface Imported {
  scope: "workspace" | "project";
  /** The keys of the Projects it created. */
  projects: string[];
}

/** Imports `archived`, an export, into the Workspace `workspaceId`, all of it or nothing. Run inside a transaction. */
export async function importExport(db: Queryable, workspaceId: string, archived: Folder, now: Date): Promise<Imported> {
  const ctx = new ImportContext(db, workspaceId, unwrapFolder(archived), now);
  const scope = readScope(ctx);
  // One import at a time per Workspace, so two can't both find it empty or a key free.
  await lockUntilCommit(db, `import:${workspaceId}`);
  const projectKeys = [...ctx.folder.keys()]
    .map((p) => /^projects\/([^/]+)\/project\.md$/.exec(p)?.[1])
    .filter((k): k is string => k !== undefined)
    .sort(natural);
  await checkRoom(ctx, scope, projectKeys);

  await importPeople(ctx);
  if (scope === "workspace") {
    await importWorkspaceSettings(ctx);
    await importGuidance(ctx, "guidance", null);
    await importTree(ctx, "documents", null);
  }
  // Tickets by key across the imported Projects, for parents and relations.
  const ticketIds = new Map<string, string>();
  const relations: PendingRelation[] = [];
  const created: string[] = [];
  for (const dirKey of projectKeys) {
    const project = await importProject(ctx, dirKey);
    created.push(project.key);
    await importGuidance(ctx, `projects/${dirKey}/guidance`, project.id);
    await importTree(ctx, `projects/${dirKey}/documents`, project.id);
    await importTickets(ctx, dirKey, project, ticketIds, relations);
  }
  await importRelations(ctx, ticketIds, relations);
  return { scope, projects: created };
}

/** What the export's README says it holds; refuses anything but a Cronk export in this format. */
function readScope(ctx: ImportContext): Imported["scope"] {
  const manifest = ctx.read("README.md")?.data.cronk as { format?: unknown; scope?: unknown } | undefined;
  if (!manifest || typeof manifest !== "object") {
    refuse("This isn't a Cronk export: it has no README.md saying so. To import plain Markdown files, import them as Documents instead");
  }
  if (manifest.format !== FORMAT) refuse(`This export is in format ${String(manifest.format)}; this Cronk reads format ${FORMAT}`);
  if (manifest.scope !== "workspace" && manifest.scope !== "project") refuse("README.md's cronk.scope must be workspace or project");
  return manifest.scope;
}

/**
 * Refuses an import with no room here: a Workspace export into a Workspace with anything in it,
 * a Project export without exactly one Project, or a Project whose key the Workspace already has.
 */
async function checkRoom(ctx: ImportContext, scope: Imported["scope"], projectKeys: string[]): Promise<void> {
  if (scope === "workspace") {
    const { rows } = await ctx.db.query(
      `SELECT 1 FROM projects WHERE workspace_id = $1
       UNION ALL SELECT 1 FROM documents WHERE workspace_id = $1
       UNION ALL SELECT 1 FROM guidance_versions WHERE workspace_id = $1 LIMIT 1`,
      [ctx.workspaceId],
    );
    if (rows.length > 0) throw new HttpError(409, "A Workspace export goes into a Workspace with no Projects, Documents or Guidance yet; import Projects one at a time instead");
  } else if (projectKeys.length !== 1) {
    refuse("A Project export holds exactly one projects/<KEY>/project.md");
  }
  const { rows: taken } = await ctx.db.query<{ key: string }>("SELECT key FROM projects WHERE workspace_id = $1 AND key = ANY($2::text[])", [
    ctx.workspaceId,
    projectKeys.map((k) => k.toUpperCase()),
  ]);
  if (taken.length > 0) throw new HttpError(409, `This Workspace already has a Project with the key ${taken[0]!.key}`);
}
