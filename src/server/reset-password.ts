import { parseArgs } from "node:util";
import { systemClock } from "./clock.js";
import { createDatabase, transaction } from "./db/database.js";
import { issuePasswordReset, passwordResetPath } from "./identity/password-resets.js";
import { findUserByEmail } from "./identity/users.js";

/**
 * Issues a password reset link for any User and prints it, for when no Admin can sign in to do it,
 * such as when the last Admin forgot their password. Run on the server, with the same `DATABASE_URL` as Cronk:
 *
 *     node dist/server/reset-password.js <email> [--url <Cronk's address>]
 *
 * As from the Users page, issuing it ends the User's sign-ins but not their Agents' Sessions.
 */
const usage = "Usage: reset-password <email> [--url <Cronk's address, such as https://cronk.example.com>]";

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { url: { type: "string" } } });
  } catch (err) {
    console.error(`${(err as Error).message}\n${usage}`);
    return 2;
  }
  const [email, ...extra] = parsed.positionals;
  if (!email || extra.length > 0) {
    console.error(usage);
    return 2;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required, as for the server itself");
    return 2;
  }
  const base = (parsed.values.url ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, "");

  const db = createDatabase(databaseUrl, () => {});
  try {
    const found = await findUserByEmail(db, email.trim());
    if (!found) {
      console.error(`No User has the email ${email}`);
      return 1;
    }
    if (!found.user.active) {
      console.error(`${found.user.email} is deactivated; reactivate them first, or invite them if they were imported`);
      return 1;
    }
    const issued = await transaction(db, (tx) => issuePasswordReset(tx, { userId: found.user.id, issuedBy: null, now: systemClock.now() }));
    if (!issued) {
      console.error(`No User has the email ${email}`);
      return 1;
    }
    console.log(`Password reset link for ${found.user.name} <${found.user.email}>, valid until ${issued.expiresAt.toISOString()}:`);
    console.log(`${base}${passwordResetPath(issued.token)}`);
    console.log("Their sign-ins have ended. The link works once.");
    return 0;
  } finally {
    await db.end();
  }
}

process.exitCode = await main();
