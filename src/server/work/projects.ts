import type { Queryable } from "../db/database.js";

/** The fixed Status Categories every Status belongs to (ADR 0011), in workflow order. */
export const STATUS_CATEGORIES = ["backlog", "unstarted", "started", "in_review", "completed", "canceled"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** The Statuses a new Project starts with: one per Status Category. */
const DEFAULT_STATUSES: { name: string; category: StatusCategory }[] = [
  { name: "Backlog", category: "backlog" },
  { name: "Todo", category: "unstarted" },
  { name: "In Progress", category: "started" },
  { name: "In Review", category: "in_review" },
  { name: "Done", category: "completed" },
  { name: "Canceled", category: "canceled" },
];

/** A Project key: a letter then letters or digits, 2 to 10 characters. Stored upper case; Ticket keys are built from it. */
export const PROJECT_KEY_PATTERN = "[A-Za-z][A-Za-z0-9]{1,9}";

/** Open Projects are open to every Member; private ones only to the Members invited to them. */
export type Visibility = "open" | "private";

export interface Project {
  id: string;
  name: string;
  key: string;
  archived: boolean;
  visibility: Visibility;
}

export interface Status {
  id: string;
  name: string;
  category: StatusCategory;
}

interface ProjectRow {
  id: string;
  name: string;
  key: string;
  archived_at: Date | null;
  visibility: Visibility;
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  key: row.key,
  archived: row.archived_at !== null,
  visibility: row.visibility,
});

/** Creates a Project with the default Statuses, or returns undefined if its key is taken. Run inside a transaction. */
export async function insertProject(
  db: Queryable,
  input: { workspaceId: string; name: string; key: string; now: Date },
): Promise<Project | undefined> {
  const { rows } = await db.query<ProjectRow>(
    `INSERT INTO projects (workspace_id, name, key, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, key) DO NOTHING RETURNING *`,
    [input.workspaceId, input.name, input.key, input.now],
  );
  if (!rows[0]) return undefined;
  const project = toProject(rows[0]);
  for (const [position, status] of DEFAULT_STATUSES.entries()) {
    await db.query("INSERT INTO statuses (project_id, name, category, position) VALUES ($1, $2, $3, $4)", [
      project.id,
      status.name,
      status.category,
      position,
    ]);
  }
  return project;
}

export async function findProjectByKey(db: Queryable, workspaceId: string, key: string): Promise<Project | undefined> {
  const { rows } = await db.query<ProjectRow>("SELECT * FROM projects WHERE workspace_id = $1 AND key = $2", [
    workspaceId,
    key.toUpperCase(),
  ]);
  return rows[0] && toProject(rows[0]);
}

export async function findProjectById(db: Queryable, id: string): Promise<Project | undefined> {
  const { rows } = await db.query<ProjectRow>("SELECT * FROM projects WHERE id = $1", [id]);
  return rows[0] && toProject(rows[0]);
}

/** A Project's Statuses in workflow order. */
export async function listStatuses(db: Queryable, projectId: string): Promise<Status[]> {
  const { rows } = await db.query<Status>(
    "SELECT id, name, category FROM statuses WHERE project_id = $1 ORDER BY position",
    [projectId],
  );
  return rows;
}

/** The Workspace's Projects by name: those not archived, or with `archived`, only the archived ones. */
export async function listProjects(db: Queryable, workspaceId: string, archived: boolean): Promise<Project[]> {
  const { rows } = await db.query<ProjectRow>(
    `SELECT * FROM projects WHERE workspace_id = $1 AND (archived_at IS NOT NULL) = $2 ORDER BY lower(name), key`,
    [workspaceId, archived],
  );
  return rows.map(toProject);
}

/**
 * Renames, archives or restores a Project, or changes whether it is open or private.
 * Its key never changes, since Ticket keys are built from it.
 */
export async function updateProject(
  db: Queryable,
  id: string,
  changes: { name?: string; archived?: boolean; visibility?: Visibility },
  now: Date,
): Promise<Project> {
  const { rows } = await db.query<ProjectRow>(
    `UPDATE projects SET
       name = coalesce($2, name),
       visibility = coalesce($5, visibility),
       archived_at = CASE WHEN $3::boolean IS NULL THEN archived_at
                          WHEN $3 THEN coalesce(archived_at, $4)
                          ELSE NULL END
     WHERE id = $1 RETURNING *`,
    [id, changes.name ?? null, changes.archived ?? null, now, changes.visibility ?? null],
  );
  return toProject(rows[0]!);
}
