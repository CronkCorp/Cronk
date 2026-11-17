import type { Queryable } from "../db/database.js";
import type { Clock } from "../clock.js";
import { hashToken as hash, newToken } from "./tokens.js";
import { findUserById, type User } from "./users.js";

/** How long a sign-in lasts before the User must sign in again. */
export const SIGN_IN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Records a sign-in and returns the secret token for the cookie. Only its hash is stored. */
export async function createSignIn(db: Queryable, clock: Clock, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken("signIn");
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + SIGN_IN_TTL_MS);
  // Expired sign-ins can never be used again; clear them out as new ones arrive.
  await db.query("DELETE FROM sign_ins WHERE expires_at <= $1", [now]);
  await db.query("INSERT INTO sign_ins (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
    hash(token),
    userId,
    now,
    expiresAt,
  ]);
  return { token, expiresAt };
}

/** The User a sign-in token belongs to, if the sign-in exists and has not expired and the User is active. */
export async function userForSignIn(db: Queryable, clock: Clock, token: string): Promise<User | undefined> {
  const { rows } = await db.query<{ user_id: string }>(
    "SELECT user_id FROM sign_ins WHERE token_hash = $1 AND expires_at > $2",
    [hash(token), clock.now()],
  );
  const user = rows[0] && (await findUserById(db, rows[0].user_id));
  return user?.active ? user : undefined;
}

/** Ends all of a User's sign-ins, except the one with token `except` if given. */
export async function endSignIns(db: Queryable, userId: string, opts: { except?: string | undefined } = {}): Promise<void> {
  await db.query("DELETE FROM sign_ins WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2", [
    userId,
    opts.except === undefined ? null : hash(opts.except),
  ]);
}

export async function deleteSignIn(db: Queryable, token: string): Promise<void> {
  await db.query("DELETE FROM sign_ins WHERE token_hash = $1", [hash(token)]);
}
