import type { Queryable } from "../db/database.js";
import { hashToken, newToken } from "./tokens.js";
import type { Role } from "./users.js";

/** How long an invitation stays usable. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Invitation {
  id: string;
  workspaceId: string;
  email: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
}

interface InvitationRow {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  created_at: Date;
  expires_at: Date;
}

const toInvitation = (row: InvitationRow): Invitation => ({
  id: row.id,
  workspaceId: row.workspace_id,
  email: row.email,
  role: row.role,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

/** The shape of an invitation the API returns. */
export const publicInvitation = (i: Invitation) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt });

/**
 * Invites `email` to the Workspace, replacing any earlier invitation for it, and
 * returns the secret token the invitee accepts it with. Only its hash is stored.
 */
export async function createInvitation(
  db: Queryable,
  input: { workspaceId: string; email: string; role: Role; invitedBy: string; now: Date },
): Promise<{ invitation: Invitation; token: string }> {
  const token = newToken("invitation");
  const expiresAt = new Date(input.now.getTime() + INVITATION_TTL_MS);
  const { rows } = await db.query<InvitationRow>(
    `INSERT INTO invitations (workspace_id, email, role, token_hash, invited_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (lower(email)) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id, email = EXCLUDED.email, role = EXCLUDED.role, token_hash = EXCLUDED.token_hash,
       invited_by = EXCLUDED.invited_by, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
     RETURNING *`,
    [input.workspaceId, input.email, input.role, hashToken(token), input.invitedBy, input.now, expiresAt],
  );
  return { invitation: toInvitation(rows[0]!), token };
}

/** The unexpired invitation a token belongs to. With `forUpdate`, locks it until the transaction ends. */
export async function findInvitationByToken(
  db: Queryable,
  token: string,
  now: Date,
  opts: { forUpdate?: boolean } = {},
): Promise<Invitation | undefined> {
  const { rows } = await db.query<InvitationRow>(
    `SELECT * FROM invitations WHERE token_hash = $1 AND expires_at > $2${opts.forUpdate ? " FOR UPDATE" : ""}`,
    [hashToken(token), now],
  );
  return rows[0] && toInvitation(rows[0]);
}

/** The Workspace's unexpired invitations, newest first. */
export async function listInvitations(db: Queryable, workspaceId: string, now: Date): Promise<Invitation[]> {
  const { rows } = await db.query<InvitationRow>(
    "SELECT * FROM invitations WHERE workspace_id = $1 AND expires_at > $2 ORDER BY created_at DESC, lower(email)",
    [workspaceId, now],
  );
  return rows.map(toInvitation);
}

/** Withdraws an invitation; returns whether there was one. */
export async function deleteInvitation(db: Queryable, workspaceId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM invitations WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
  return (rowCount ?? 0) > 0;
}
