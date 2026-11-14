import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db/database.js";
import type { Clock } from "../clock.js";
import { findUserById, type User } from "./users.js";

/** How long a sign-in lasts before the User must sign in again. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Starts a sign-in session and returns the secret token for the cookie. Only its hash is stored. */
export async function createSession(db: Queryable, clock: Clock, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.query("INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
    hash(token),
    userId,
    now,
    expiresAt,
  ]);
  return { token, expiresAt };
}

/** The User a session token belongs to, if the session exists and has not expired. */
export async function userForSession(db: Queryable, clock: Clock, token: string): Promise<User | undefined> {
  const { rows } = await db.query<{ user_id: string }>(
    "SELECT user_id FROM user_sessions WHERE token_hash = $1 AND expires_at > $2",
    [hash(token), clock.now()],
  );
  return rows[0] && findUserById(db, rows[0].user_id);
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query("DELETE FROM user_sessions WHERE token_hash = $1", [hash(token)]);
}
