import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import type { Visibility } from "../work/projects.js";
import type { User } from "./users.js";

/**
 * The access check every API operation goes through: what an Actor may do in a
 * Project, and what only Admins may do in the Workspace.
 */

/** What a User may do in a Project: Read, or Write (which includes Read). */
export type Access = "read" | "write";

/** The part of a Project access depends on. */
export interface AccessTarget {
  id: string;
  visibility: Visibility;
}

/**
 * The single rule. Admins have Write everywhere. A Member listed in a Project has
 * the access listed; otherwise an open Project gives them Write and a private one nothing.
 */
function accessOf(user: User, project: AccessTarget, listed: Access | undefined): Access | undefined {
  if (user.role === "admin") return "write";
  if (listed) return listed;
  return project.visibility === "open" ? "write" : undefined;
}

const covers = (has: Access, need: Access) => has === "write" || need === "read";

/**
 * Checks that `user` has at least `need` in `project` and returns what they have.
 * A Project they can't see answers 404 with `hiddenAs`, as if it (or the thing in it) didn't
 * exist; Read where Write is needed answers 403.
 */
export async function requireProjectAccess(
  db: Queryable,
  user: User,
  project: AccessTarget,
  need: Access,
  hiddenAs = "No such Project",
): Promise<Access> {
  const { rows } = await db.query<{ access: Access }>(
    "SELECT access FROM project_members WHERE project_id = $1 AND user_id = $2",
    [project.id, user.id],
  );
  const access = accessOf(user, project, rows[0]?.access);
  if (!access) throw new HttpError(404, hiddenAs);
  if (!covers(access, need)) throw new HttpError(403, "You have Read access in this Project, so you can't change anything in it");
  return access;
}

/** The Projects `user` can see, each with the access they have in it. */
export async function visibleProjects<P extends AccessTarget>(db: Queryable, user: User, projects: P[]): Promise<(P & { access: Access })[]> {
  const { rows } = await db.query<{ project_id: string; access: Access }>(
    "SELECT project_id, access FROM project_members WHERE user_id = $1",
    [user.id],
  );
  const listed = new Map(rows.map((r) => [r.project_id, r.access]));
  return projects.flatMap((project) => {
    const access = accessOf(user, project, listed.get(project.id));
    return access ? [{ ...project, access }] : [];
  });
}

/** Refuses anyone but an Admin. `what` completes "Only an Admin can …". */
export function requireAdmin(user: User, what: string): void {
  if (user.role !== "admin") throw new HttpError(403, `Only an Admin can ${what}`);
}
