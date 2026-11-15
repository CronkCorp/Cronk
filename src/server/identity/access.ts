import { actingUser, type Actor, type AgentActor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { findProjectById, findProjectByKey, listProjects, type Project, type Visibility } from "../work/projects.js";
import type { Agent } from "./agents.js";
import { getWorkspace } from "../workspace/workspaces.js";
import type { User } from "./users.js";

/**
 * The access check every API operation goes through: what an Actor may do in a
 * Project, and what only Admins may do in the Workspace.
 */

/** What a User may do in a Project: Read, or Write (which includes Read). */
export type Access = "read" | "write";

/** The most a Project (or the Workspace) lets Agents do in it. */
export type AgentAccess = Level;

/** The part of a Project access depends on. */
export interface AccessTarget {
  id: string;
  visibility: Visibility;
  agentAccess: AgentAccess;
}

/**
 * What a User has in a Project. Admins have Write everywhere. A Member listed in a Project
 * has the access listed; otherwise an open Project gives them Write and a private one nothing.
 */
function userAccess(user: User, project: AccessTarget, listed: Access | undefined): Level {
  if (user.role === "admin") return "write";
  if (listed) return listed;
  return project.visibility === "open" ? "write" : "none";
}

/** How much an Actor may do somewhere: nothing, or some Access. */
type Level = "none" | Access;

const RANK: Record<Level, number> = { none: 0, read: 1, write: 2 };

/** One thing limiting an Actor's access, with why it stops a write when it is Read. */
interface Limit {
  access: Level;
  readOnlyBecause: string;
}

/** An Agent's token: Write unless it is read-only. */
const tokenLimit = (agent: AgentActor): Limit => ({
  access: agent.readOnly ? "read" : "write",
  readOnlyBecause: "This Agent's token is read-only",
});

/**
 * Everything limiting what `actor` may do in a Project; their access is the lowest. A User
 * is limited only by their own access. An Agent is also capped by the Project's Agent Access
 * and by its token, and never gets more than its Owner has (ADR 0004).
 */
function limitsOf(actor: Actor, project: AccessTarget, listed: Access | undefined): Limit[] {
  const own = userAccess(actingUser(actor), project, listed);
  if (actor.kind === "user") return [{ access: own, readOnlyBecause: "You have Read access in this Project" }];
  return [
    tokenLimit(actor),
    { access: project.agentAccess, readOnlyBecause: "This Project's Agent Access is Read" },
    { access: own, readOnlyBecause: "This Agent's Owner has Read access in this Project" },
  ];
}

const lowest = (limits: Limit[]): Level => limits.reduce<Level>((low, l) => (RANK[l.access] < RANK[low] ? l.access : low), "write");

/** Refuses a write when any limit is Read, saying which. */
function requireWritable(limits: Limit[], need: Access): void {
  const blocking = need === "write" && limits.find((l) => l.access === "read");
  if (blocking) throw new HttpError(403, `${blocking.readOnlyBecause}, so you can't change anything in it`);
}

/**
 * Checks that `actor` has at least `need` in `project` and returns what they have.
 * A Project they can't see answers 404 with `hiddenAs`, as if it (or the thing in it) didn't
 * exist; Read where Write is needed answers 403, saying what limits them.
 */
export async function requireProjectAccess(
  db: Queryable,
  actor: Actor,
  project: AccessTarget,
  need: Access,
  hiddenAs = "No such Project",
): Promise<Access> {
  const { rows } = await db.query<{ access: Access }>(
    "SELECT access FROM project_members WHERE project_id = $1 AND user_id = $2",
    [project.id, actingUser(actor).id],
  );
  const limits = limitsOf(actor, project, rows[0]?.access);
  const access = lowest(limits);
  if (access === "none") throw new HttpError(404, hiddenAs);
  requireWritable(limits, need);
  return access;
}

/** The Projects `actor` can see, each with the access they have in it. */
export async function visibleProjects<P extends AccessTarget>(db: Queryable, actor: Actor, projects: P[]): Promise<(P & { access: Access })[]> {
  const { rows } = await db.query<{ project_id: string; access: Access }>(
    "SELECT project_id, access FROM project_members WHERE user_id = $1",
    [actingUser(actor).id],
  );
  const listed = new Map(rows.map((r) => [r.project_id, r.access]));
  return projects.flatMap((project) => {
    const access = lowest(limitsOf(actor, project, listed.get(project.id)));
    return access === "none" ? [] : [{ ...project, access }];
  });
}

/**
 * Checks that `actor` has at least `need` in the Workspace outside any Project: reading it
 * (its name, Users) or writing to it (creating Projects). Every User has Write here, but an
 * Agent is capped by the Workspace's Agent Access and its token. Missing access answers 403.
 */
export async function requireWorkspaceAccess(db: Queryable, actor: Actor, need: Access): Promise<void> {
  if (actor.kind === "user") return;
  const workspace = await getWorkspace(db, actor.owner.workspaceId);
  const limits: Limit[] = [
    tokenLimit(actor),
    { access: workspace.agentAccess, readOnlyBecause: "The Workspace's Agent Access is Read" },
  ];
  if (lowest(limits) === "none") throw new HttpError(403, "The Workspace's Agent Access is None, so Agents can't use it");
  requireWritable(limits, need);
}

/**
 * Whether `actor` can read in the Project with this id, or in the Workspace outside any
 * Project when it is null: whether something there is theirs to see.
 */
export async function canRead(db: Queryable, actor: Actor, projectId: string | null): Promise<boolean> {
  try {
    if (projectId === null) await requireWorkspaceAccess(db, actor, "read");
    else await requireProjectAccess(db, actor, (await findProjectById(db, projectId))!, "read");
    return true;
  } catch (err) {
    if (err instanceof HttpError) return false;
    throw err;
  }
}

/** Where an Actor may read: the ids of the Projects, archived or not, and their Workspace's id if they may read it outside any Project. */
export interface Readable {
  projectIds: string[];
  workspaceId: string | null;
}

/**
 * SQL for whether the Document aliased `document` lies where a `Readable` lets its Actor read, given
 * SQL for its `projectIds` (a uuid[]) and its `workspaceId` (a uuid, NULL when the Workspace isn't readable).
 */
export const documentReadableSql = (document: string, projectIds: string, workspaceId: string) =>
  `(${document}.project_id = ANY(${projectIds}) OR (${document}.project_id IS NULL AND ${document}.workspace_id = ${workspaceId}))`;

/** Where `actor` may read, for finding things across the Workspace (see `Readable`). */
export async function readablePlaces(db: Queryable, actor: Actor): Promise<Readable> {
  const workspaceId = actingUser(actor).workspaceId;
  const projects = [...(await listProjects(db, workspaceId, false)), ...(await listProjects(db, workspaceId, true))];
  return { projectIds: (await visibleProjects(db, actor, projects)).map((p) => p.id), workspaceId: (await canRead(db, actor, null)) ? workspaceId : null };
}

/**
 * An Agent as it reads outside any Agent Session, whatever its tokens: for asking what it may
 * see on its behalf (as when deciding whom a Comment concerns), never for acting as it.
 */
export const agentReading = (agent: Agent, owner: User): AgentActor => ({ kind: "agent", session: null, tokenId: "", readOnly: true, agent, owner });

/** Refuses anyone but an Admin; an Agent never is one, even if its Owner is. `what` completes "Only an Admin can …". */
export function requireAdmin(who: User | Actor, what: string): void {
  const user = "kind" in who ? (who.kind === "user" ? who.user : undefined) : who;
  if (user?.role !== "admin") throw new HttpError(403, `Only an Admin can ${what}`);
}

/** Refuses an Agent: only Users do this. `what` completes "Only a User can …". */
export function requireUserActor(actor: Actor, what: string): void {
  if (actor.kind === "agent") throw new HttpError(403, `Only a User can ${what}, not an Agent`);
}

/** The Project with this key, if `actor` has at least `need` in it (see `requireProjectAccess`). */
export async function projectFor(db: Queryable, actor: Actor, key: string, need: Access): Promise<{ project: Project; access: Access }> {
  const project = await findProjectByKey(db, actingUser(actor).workspaceId, key);
  if (!project) throw new HttpError(404, "No such Project");
  return { project, access: await requireProjectAccess(db, actor, project, need) };
}
