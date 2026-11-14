import type { Queryable } from "../db/database.js";
import type { Access } from "./access.js";
import { findUserById, type User } from "./users.js";

/** A User listed in a Project, with the access they have there. */
export interface Membership {
  user: User;
  access: Access;
}

/** The Users listed in a Project, by name. */
export async function listMemberships(db: Queryable, projectId: string): Promise<Membership[]> {
  const { rows } = await db.query<{ id: string; access: Access }>(
    `SELECT u.id, m.access FROM project_members m JOIN users u ON u.id = m.user_id
     WHERE m.project_id = $1 ORDER BY lower(u.name), lower(u.email)`,
    [projectId],
  );
  const users = await Promise.all(rows.map((r) => findUserById(db, r.id)));
  return rows.map((r, i) => ({ user: users[i]!, access: r.access }));
}

/** Lists a User in a Project with the given access, replacing what they had. */
export async function setMembership(db: Queryable, projectId: string, userId: string, access: Access): Promise<void> {
  await db.query(
    `INSERT INTO project_members (project_id, user_id, access) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET access = EXCLUDED.access`,
    [projectId, userId, access],
  );
}

export async function removeMembership(db: Queryable, projectId: string, userId: string): Promise<void> {
  await db.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, userId]);
}
