import type { Queryable } from "../db/database.js";
import { INVITATION_TTL_MS } from "./invitations.js";
import { endSignIns } from "./sign-ins.js";
import { hashToken, newToken } from "./tokens.js";
import { findUserById, NO_PASSWORD, PASSWORD_RESET_PENDING, setPasswordHash, type User } from "./users.js";

/** How long a password reset link stays usable: as long as an invitation. */
export const PASSWORD_RESET_TTL_MS = INVITATION_TTL_MS;

/** The path of the web page a reset link opens; append it to Cronk's address. */
export const passwordResetPath = (token: string) => `/reset-password/${token}`;

/** Why a User can't be given a reset link: a deactivated User couldn't sign in with it, and an imported one joins by Invitation. */
export type ResetRefusal = "no such user" | "deactivated" | "not joined";

/**
 * Issues a one-time password reset link for a User, replacing any earlier one, and returns its secret token
 * (only the hash is stored). It secures the account until the link is used: the old password stops working and
 * all the User's sign-ins end, while their Agents' Sessions keep running. `issuedBy` is the Admin, or null for the
 * server command. Run inside a transaction.
 */
export async function issuePasswordReset(
  db: Queryable,
  input: { userId: string; issuedBy: string | null; now: Date },
): Promise<{ token: string; expiresAt: Date } | ResetRefusal> {
  // Locked so a concurrent deactivation, which forgets the User's link, waits for this one or is seen by it.
  const { rows } = await db.query<{ password_hash: string; deactivated_at: Date | null }>(
    "SELECT password_hash, deactivated_at FROM users WHERE id = $1 FOR UPDATE",
    [input.userId],
  );
  const user = rows[0];
  if (!user) return "no such user";
  if (user.password_hash === NO_PASSWORD) return "not joined";
  if (user.deactivated_at) return "deactivated";

  const token = newToken();
  const expiresAt = new Date(input.now.getTime() + PASSWORD_RESET_TTL_MS);
  await db.query(
    `INSERT INTO password_resets (user_id, token_hash, issued_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       token_hash = EXCLUDED.token_hash, issued_by = EXCLUDED.issued_by, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
    [input.userId, hashToken(token), input.issuedBy, input.now, expiresAt],
  );
  await setPasswordHash(db, input.userId, PASSWORD_RESET_PENDING);
  await endSignIns(db, input.userId);
  return { token, expiresAt };
}

/** The active User an unexpired reset token is for. With `forUpdate`, locks the reset until the transaction ends. */
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
  const user = rows[0] && (await findUserById(db, rows[0].user_id));
  return user?.active ? user : undefined;
}

/**
 * Uses a reset token: gives its User the new password, ends any sign-ins they have and forgets the link.
 * Returns the User, or undefined if the token is unknown, used or expired. Run inside a transaction.
 */
export async function usePasswordReset(db: Queryable, token: string, passwordHash: string, now: Date): Promise<User | undefined> {
  const user = await userForPasswordReset(db, token, now, { forUpdate: true });
  if (!user) return undefined;
  await db.query("DELETE FROM password_resets WHERE user_id = $1", [user.id]);
  await setPasswordHash(db, user.id, passwordHash);
  await endSignIns(db, user.id);
  return user;
}
