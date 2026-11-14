import type { Queryable } from "../db/database.js";
import type { AgentAccess } from "../identity/access.js";

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
  agentAccess: AgentAccess;
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
  agent_access: AgentAccess;
}

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  key: row.key,
  archived: row.archived_at !== null,
  visibility: row.visibility,
  agentAccess: row.agent_access,
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

/** Orders Statuses by Status Category, then by their place within it. */
const STATUS_ORDER = `array_position(ARRAY['${STATUS_CATEGORIES.join("','")}'], category), position`;

/**
 * A Project's Statuses in workflow order: grouped by Status Category in its
 * fixed order, then in the order the Project chose within each Category.
 */
export async function listStatuses(db: Queryable, projectId: string): Promise<Status[]> {
  const { rows } = await db.query<Status>(
    `SELECT id, name, category FROM statuses WHERE project_id = $1 ORDER BY ${STATUS_ORDER}`,
    [projectId],
  );
  return rows;
}

/**
 * Locks the Project row until the transaction ends, so changes to its Statuses
 * (and Ticket creation, which takes the first Status) happen one at a time.
 */
export async function lockProject(db: Queryable, projectId: string): Promise<void> {
  await db.query("SELECT 1 FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
}

/**
 * Adds a Status last in its Status Category, or returns undefined if the
 * Project already has a Status with that name. Lock the Project first.
 */
export async function insertStatus(
  db: Queryable,
  projectId: string,
  input: { name: string; category: StatusCategory },
): Promise<Status | undefined> {
  const { rows } = await db.query<Status>(
    `INSERT INTO statuses (project_id, name, category, position)
     SELECT $1, $2, $3, coalesce(max(position) + 1, 0) FROM statuses WHERE project_id = $1 AND category = $3
     ON CONFLICT (project_id, lower(name)) DO NOTHING
     RETURNING id, name, category`,
    [projectId, input.name, input.category],
  );
  return rows[0];
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
 * Renames a Status, or returns undefined if another Status of its Project
 * already has that name. Lock the Project first.
 */
export async function renameStatus(db: Queryable, projectId: string, statusId: string, name: string): Promise<Status | undefined> {
  const { rows: clashes } = await db.query(
    "SELECT 1 FROM statuses WHERE project_id = $1 AND lower(name) = lower($2) AND id <> $3",
    [projectId, name, statusId],
  );
  if (clashes.length > 0) return undefined;
  const { rows } = await db.query<Status>("UPDATE statuses SET name = $2 WHERE id = $1 RETURNING id, name, category", [
    statusId,
    name,
  ]);
  return rows[0]!;
}

/**
 * Moves a Status to `position` (counted from 0) among the Statuses of its
 * Status Category. Returns false, changing nothing, if there is no such
 * position. Lock the Project first.
 */
export async function moveStatus(db: Queryable, projectId: string, status: Status, position: number): Promise<boolean> {
  const order = (await listStatuses(db, projectId)).filter((s) => s.category === status.category).map((s) => s.id);
  if (position >= order.length) return false;
  order.splice(order.indexOf(status.id), 1);
  order.splice(position, 0, status.id);
  await db.query(
    `UPDATE statuses SET position = ordered.position - 1
     FROM unnest($1::uuid[]) WITH ORDINALITY AS ordered(id, position) WHERE statuses.id = ordered.id`,
    [order],
  );
  return true;
}

/**
 * One of a Project's Statuses, locked against removal until the transaction
 * ends so a Ticket can move into it. Waits out a removal in progress, then
 * returns undefined if the Status is gone.
 */
export async function findStatusToMoveInto(db: Queryable, projectId: string, statusId: string): Promise<Status | undefined> {
  const { rows } = await db.query<Status>(
    "SELECT id, name, category FROM statuses WHERE project_id = $1 AND id = $2 FOR KEY SHARE",
    [projectId, statusId],
  );
  return rows[0];
}

/**
 * Locks a Status so no Ticket can move into it until the transaction ends.
 * Take it before checking which Tickets are in a Status you are removing.
 */
export async function lockStatus(db: Queryable, statusId: string): Promise<void> {
  await db.query("SELECT 1 FROM statuses WHERE id = $1 FOR UPDATE", [statusId]);
}

/** How many Tickets are in a Status. */
export async function countTicketsInStatus(db: Queryable, statusId: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM tickets WHERE status_id = $1", [statusId]);
  return rows[0]!.count;
}

/** Removes a Status no Ticket is in. Lock the Project first. */
export async function deleteStatus(db: Queryable, statusId: string): Promise<void> {
  await db.query("DELETE FROM statuses WHERE id = $1", [statusId]);
}

/**
 * Renames, archives or restores a Project, or changes whether it is open or private
 * or its Agent Access. Its key never changes, since Ticket keys are built from it.
 */
export async function updateProject(
  db: Queryable,
  id: string,
  changes: { name?: string; archived?: boolean; visibility?: Visibility; agentAccess?: AgentAccess },
  now: Date,
): Promise<Project> {
  const { rows } = await db.query<ProjectRow>(
    `UPDATE projects SET
       name = coalesce($2, name),
       visibility = coalesce($5, visibility),
       agent_access = coalesce($6, agent_access),
       archived_at = CASE WHEN $3::boolean IS NULL THEN archived_at
                          WHEN $3 THEN coalesce(archived_at, $4)
                          ELSE NULL END
     WHERE id = $1 RETURNING *`,
    [id, changes.name ?? null, changes.archived ?? null, now, changes.visibility ?? null, changes.agentAccess ?? null],
  );
  return toProject(rows[0]!);
}
