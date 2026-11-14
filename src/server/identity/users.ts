import type { Queryable } from "../db/database.js";

export type Role = "admin" | "member";

export interface User {
  id: string;
  workspaceId: string;
  email: string;
  name: string;
  role: Role;
}

/** The shape of a User the API returns. */
export function publicUser(user: User) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

interface UserRow {
  id: string;
  workspace_id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
}

function toUser(row: UserRow): User {
  return { id: row.id, workspaceId: row.workspace_id, email: row.email, name: row.name, role: row.role };
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

export async function findUserById(db: Queryable, id: string): Promise<User | undefined> {
  const { rows } = await db.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] && toUser(rows[0]);
}
