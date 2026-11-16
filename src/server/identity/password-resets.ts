import type { Queryable } from "../db/database.js";
import { INVITATION_TTL_MS } from "./invitations.js";
import { hashToken, newToken } from "./tokens.js";
import { findUserById, type User } from "./users.js";

/** How long a password reset link stays usable: as long as an invitation. */
export const PASSWORD_RESET_TTL_MS = INVITATION_TTL_MS;

/** The path of the web page a reset link opens; append it to Cronk's address. */
export const passwordResetPath = (token: string) => `/reset-password/${token}`;

/**
 * Issues a one-time password reset link for a User, replacing any earlier one, and returns its secret
 * token (only the hash is stored). It ends all the User's sign-ins, so whoever might be using the account
 * is signed out; their Agents' Sessions keep running. `issuedBy` is the Admin, or null for the server command.
 * Returns undefined if there is no such User.
 */
export async function issuePasswordReset(
  db: Queryable,
  input: { userId: string; issuedBy: string | null; now: Date },
): Promise<{ token: string; expiresAt: Date } | undefined> {
  const token = newToken();
  const expiresAt = new Date(input.now.getTime() + PASSWORD_RESET_TTL_MS);
  const { rowCount } = await db.query(
    `INSERT INTO password_resets (user_id, token_hash, issued_by, created_at, expires_at)
     SELECT id, $2, $3, $4, $5 FROM users WHERE id = $1
     ON CONFLICT (user_id) DO UPDATE SET
       token_hash = EXCLUDED.token_hash, issued_by = EXCLUDED.issued_by, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
    [input.userId, hashToken(token), input.issuedBy, input.now, expiresAt],
  );
  if (!rowCount) return undefined;
  await db.query("DELETE FROM sign_ins WHERE user_id = $1", [input.userId]);
  return { token, expiresAt };
}

/** The User an unexpired reset token is for. With `forUpdate`, locks the reset until the transaction ends. */
export async function userForPasswordReset(
  db: Queryable,
  token: string,
  now: Date,
  opts: { forUpdate?: boolean } = {},
): Promise<User | undefined> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM password_resets WHERE token_hash = $1 AND expires_at > $2${opts.forUpdate ? " FOR UPDATE" : ""}`,
    [hashToken(token), now],
  );
  return rows[0] && findUserById(db, rows[0].user_id);
}

/**
 * Uses a reset token: gives its User the new password, ends their other sign-ins and forgets the link.
 * Returns the User, or undefined if the token is unknown, used or expired. Run inside a transaction.
 */
export async function usePasswordReset(db: Queryable, token: string, passwordHash: string, now: Date): Promise<User | undefined> {
  const user = await userForPasswordReset(db, token, now, { forUpdate: true });
  if (!user) return undefined;
  await db.query("DELETE FROM password_resets WHERE user_id = $1", [user.id]);
  await setPassword(db, user.id, passwordHash);
  return user;
}

/** Replaces a User's password hash and ends their sign-ins, except the one with token `keepSignIn`. */
export async function setPassword(db: Queryable, userId: string, passwordHash: string, keepSignIn?: string): Promise<void> {
  await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, passwordHash]);
  await db.query("DELETE FROM sign_ins WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2", [
    userId,
    keepSignIn === undefined ? null : hashToken(keepSignIn),
  ]);
}

/** The User's password hash, to check their current password against. */
export async function passwordHashOf(db: Queryable, userId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [userId]);
  return rows[0]?.password_hash;
}
