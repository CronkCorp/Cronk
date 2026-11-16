import { endAgentSessionsOfOwner, type ClaimHolders } from "../coordination/agent-sessions.js";
import type { Queryable } from "../db/database.js";

export type Role = "admin" | "member";

export interface User {
  id: string;
  workspaceId: string;
  email: string;
  name: string;
  role: Role;
  /** False once an Admin has deactivated the User. */
  active: boolean;
  /** False for a User an import brought in who hasn't accepted an invitation, so has no password yet. */
  joined: boolean;
}

/** The shape of a User the API returns. */
export function publicUser(user: User) {
  return { id: user.id, email: user.email, name: user.name, role: user.role, active: user.active, joined: user.joined };
}

export interface UserRow {
  id: string;
  workspace_id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  deactivated_at: Date | null;
}

/**
 * The password hash of a User who has none yet, as an import creates them. No password matches it,
 * so they can't sign in until they accept an invitation.
 */
export const NO_PASSWORD = "!";

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.deactivated_at === null,
    joined: row.password_hash !== NO_PASSWORD,
  };
}

export async function countUsers(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ count: string }>("SELECT count(*) FROM users");
  return Number(rows[0]!.count);
}

export async function insertUser(
  db: Queryable,
  input: { workspaceId: string; email: string; name: string; passwordHash: string; role: Role; now: Date },
): Promise<User> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (workspace_id, email, name, password_hash, role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.workspaceId, input.email, input.name, input.passwordHash, input.role, input.now],
  );
  return toUser(rows[0]!);
}

/** Looks a User up by email, ignoring case, together with their password hash. */
export async function findUserByEmail(db: Queryable, email: string): Promise<{ user: User; passwordHash: string } | undefined> {
  const { rows } = await db.query<UserRow>("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
  const row = rows[0];
  return row && { user: toUser(row), passwordHash: row.password_hash };
}

/** Adds a User who has no password yet, deactivated, as an import brings them in. */
export async function insertUserWithoutPassword(
  db: Queryable,
  input: { workspaceId: string; email: string; name: string; role: Role; now: Date },
): Promise<User> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (workspace_id, email, name, password_hash, role, created_at, deactivated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
    [input.workspaceId, input.email, input.name, NO_PASSWORD, input.role, input.now],
  );
  return toUser(rows[0]!);
}

/**
 * Gives a User who has no password yet (one an import brought in) the name, password and role
 * from an accepted invitation, and reactivates them, keeping their id. As in `updateUser`, an
 * Admin's Project listings are dropped. Returns undefined if the email has no User without a password.
 */
export async function claimUserWithoutPassword(
  db: Queryable,
  input: { workspaceId: string; email: string; name: string; passwordHash: string; role: Role },
): Promise<User | undefined> {
  const { rows } = await db.query<UserRow>(
    `UPDATE users SET name = $3, password_hash = $4, role = $5, deactivated_at = NULL
     WHERE workspace_id = $1 AND lower(email) = lower($2) AND password_hash = $6 RETURNING *`,
    [input.workspaceId, input.email, input.name, input.passwordHash, input.role, NO_PASSWORD],
  );
  if (!rows[0]) return undefined;
  if (input.role === "admin") await db.query("DELETE FROM project_members WHERE user_id = $1", [rows[0].id]);
  return toUser(rows[0]);
}

export async function findUserById(db: Queryable, id: string): Promise<User | undefined> {
  const { rows } = await db.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] && toUser(rows[0]);
}

/** The Workspace's Users by name. */
export async function listUsers(db: Queryable, workspaceId: string): Promise<User[]> {
  const { rows } = await db.query<UserRow>("SELECT * FROM users WHERE workspace_id = $1 ORDER BY lower(name), lower(email)", [
    workspaceId,
  ]);
  return rows.map(toUser);
}

/**
 * Changes a User's role and/or deactivates or reactivates them, refusing to leave
 * the Workspace without an active Admin. Deactivating ends all their sign-ins and their
 * Agents' Sessions, so the Claims those held lapse at once.
 * Making them an Admin drops their Project listings, since Admins have Write everywhere;
 * demoting them later starts them with only the open Projects.
 * Returns the changed User with the Claims deactivating them ended (none otherwise), or undefined
 * if there is no such User. Run inside a transaction.
 */
export async function updateUser(
  db: Queryable,
  workspaceId: string,
  id: string,
  changes: { role?: Role; active?: boolean },
  now: Date,
): Promise<{ user: User; ended: ClaimHolders } | undefined | "last admin"> {
  // Locking the active Admins makes concurrent demotions queue, so they can't each leave the other as the last.
  const { rows: admins } = await db.query<{ id: string }>(
    "SELECT id FROM users WHERE workspace_id = $1 AND role = 'admin' AND deactivated_at IS NULL FOR UPDATE",
    [workspaceId],
  );
  const losesAdmin = changes.role === "member" || changes.active === false;
  if (losesAdmin && admins.length === 1 && admins[0]!.id === id) return "last admin";

  const { rows } = await db.query<UserRow>(
    `UPDATE users SET
       role = coalesce($3, role),
       deactivated_at = CASE WHEN $4::boolean IS NULL THEN deactivated_at
                             WHEN $4 THEN NULL
                             ELSE coalesce(deactivated_at, $5) END
     WHERE workspace_id = $1 AND id = $2 RETURNING *`,
    [workspaceId, id, changes.role ?? null, changes.active ?? null, now],
  );
  if (!rows[0]) return undefined;
  let ended: ClaimHolders = { ticketIds: [] };
  if (changes.active === false) {
    await db.query("DELETE FROM sign_ins WHERE user_id = $1", [id]);
    ended = await endAgentSessionsOfOwner(db, id, now);
  }
  if (changes.role === "admin") await db.query("DELETE FROM project_members WHERE user_id = $1", [id]);
  return { user: toUser(rows[0]), ended };
}
