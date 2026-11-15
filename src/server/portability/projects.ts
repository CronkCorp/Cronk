import { STATUS_CATEGORIES } from "../../shared/values.js";
import { setMembership } from "../identity/memberships.js";
import { accessSchema, agentAccessSchema } from "../schemas.js";
import { insertStatus, PROJECT_KEY_PATTERN, VISIBILITIES } from "../work/projects.js";
import { iso, type ExportContext } from "./export-context.js";
import { date, integer, list, oneOf, optionalDate, refuse, text, type File } from "./fields.js";
import type { ImportContext } from "./import-context.js";

/** `projects/<KEY>/project.md`: a Project's settings, its Statuses in workflow order, and its members. */

/** A Project's row, as exporting reads it. */
export interface ProjectRow {
  id: string;
  key: string;
  name: string;
  visibility: string;
  agent_access: string;
  archived_at: Date | null;
  created_at: Date;
  next_ticket_number: number;
}

/** Writes `${dir}/project.md` for the Project `p`; returns the names of its Statuses by id. */
export async function exportProject(ctx: ExportContext, dir: string, p: ProjectRow): Promise<Map<string, string>> {
  const { rows: statuses } = await ctx.db.query<{ id: string; name: string; category: string }>(
    `SELECT id, name, category FROM statuses WHERE project_id = $1 ORDER BY array_position($2::text[], category), position`,
    [p.id, STATUS_CATEGORIES],
  );
  const { rows: members } = await ctx.db.query<{ user_id: string; access: string }>(
    "SELECT m.user_id, m.access FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY lower(u.email)",
    [p.id],
  );
  ctx.add(`${dir}/project.md`, {
    key: p.key,
    name: p.name,
    visibility: p.visibility,
    agentAccess: p.agent_access,
    archivedAt: iso(p.archived_at),
    createdAt: iso(p.created_at),
    nextTicketNumber: p.next_ticket_number,
    statuses: statuses.map(({ name, category }) => ({ name, category })),
    members: members.map((m) => ({ user: ctx.user(m.user_id), access: m.access })),
  });
  return new Map(statuses.map((s) => [s.id, s.name]));
}

/** A Project an import created. */
export interface ImportedProject {
  id: string;
  key: string;
  /** The file it came from, for naming it in refusals. */
  path: string;
  /** Its Statuses' ids by lower-case name. */
  statusIds: Map<string, string>;
}

/** Imports the Project in `projects/<dirKey>/project.md` with its Statuses and members. */
export async function importProject(ctx: ImportContext, dirKey: string): Promise<ImportedProject> {
  const p = ctx.need(`projects/${dirKey}/project.md`);
  const key = text(p.data.key, `${p.path} key`).toUpperCase();
  if (key !== dirKey.toUpperCase()) refuse(`${p.path} says its key is ${key}, but it is in projects/${dirKey}`);
  if (!new RegExp(`^${PROJECT_KEY_PATTERN}$`).test(key)) refuse(`${p.path} key must be a letter then 1 to 9 letters or digits`);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO projects (workspace_id, name, key, visibility, agent_access, archived_at, created_at, next_ticket_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      ctx.workspaceId,
      text(p.data.name, `${p.path} name`),
      key,
      oneOf(p.data.visibility, VISIBILITIES, `${p.path} visibility`),
      oneOf(p.data.agentAccess, agentAccessSchema.enum, `${p.path} agentAccess`),
      optionalDate(p.data.archivedAt, `${p.path} archivedAt`),
      date(p.data.createdAt, `${p.path} createdAt`),
      integer(p.data.nextTicketNumber, `${p.path} nextTicketNumber`),
    ],
  );
  const id = rows[0]!.id;
  const statusIds = await importStatuses(ctx, p, id);
  const members = new Set<string>();
  for (const [i, m] of list(p, "members").entries()) {
    const userId = await ctx.userId(m.user, `${p.path} members[${i}].user`);
    if (members.has(userId)) refuse(`${p.path} lists ${String(m.user)} as a member twice`);
    members.add(userId);
    await setMembership(ctx.db, id, userId, oneOf(m.access, accessSchema.enum, `${p.path} members[${i}].access`));
  }
  return { id, key, path: p.path, statusIds };
}

/** Imports the Statuses `project.md` lists, in its order within each Status Category; returns their ids by lower-case name. */
async function importStatuses(ctx: ImportContext, p: File, projectId: string): Promise<Map<string, string>> {
  const statusIds = new Map<string, string>();
  for (const [i, s] of list(p, "statuses").entries()) {
    const name = text(s.name, `${p.path} statuses[${i}].name`);
    const category = oneOf(s.category, STATUS_CATEGORIES, `${p.path} statuses[${i}].category`);
    // Each goes last in its Status Category, so they keep the order project.md lists.
    const status = (await insertStatus(ctx.db, projectId, { name, category })) ?? refuse(`${p.path} has two Statuses named ${name}`);
    statusIds.set(name.toLowerCase(), status.id);
  }
  if (statusIds.size === 0) refuse(`${p.path} has no statuses`);
  return statusIds;
}
