import type { Queryable } from "../db/database.js";
import type { AgentRef } from "../work/tickets.js";
import { isLiveAt, WITH_WORKSPACE } from "./agent-sessions.js";

/**
 * An Agent Session's exclusive, temporary hold on a Ticket. A Ticket stores at most one
 * (its `claim_session_id`), and the Claim is live exactly while its Agent Session is: every
 * call in the Session refreshes both, and both lapse once the Session stays silent longer
 * than the Workspace's silence threshold. Lapsing keeps the Ticket's Delegate.
 */
export interface Claim {
  agent: AgentRef;
  session: { id: string };
  claimedAt: Date;
  /** When the Claim lapses if its Agent Session stays silent until then. */
  endsIfSilentAt: Date;
}

interface ClaimRow {
  agent_id: string;
  agent_name: string;
  session_id: string;
  claimed_at: Date;
  last_seen_at: Date;
  silence_threshold_seconds: number;
}

/** The Ticket's live Claim, if it has one at `now`. */
export async function findLiveClaim(db: Queryable, ticketId: string, now: Date): Promise<Claim | undefined> {
  const { rows } = await db.query<ClaimRow>(
    `SELECT a.id AS agent_id, a.name AS agent_name, s.id AS session_id, t.claimed_at, s.last_seen_at, w.silence_threshold_seconds
     FROM tickets t JOIN agent_sessions s ON s.id = t.claim_session_id ${WITH_WORKSPACE}
     WHERE t.id = $1 AND ${isLiveAt("$2")}`,
    [ticketId, now],
  );
  const row = rows[0];
  return (
    row && {
      agent: { id: row.agent_id, name: row.agent_name },
      session: { id: row.session_id },
      claimedAt: row.claimed_at,
      endsIfSilentAt: new Date(row.last_seen_at.getTime() + row.silence_threshold_seconds * 1000),
    }
  );
}

/**
 * Gives the Session `sessionId` the Ticket's Claim, replacing any lapsed one. Callers check
 * first, with the Ticket locked, that no other Session holds a live Claim. Claiming again
 * from the same Session keeps the original time.
 */
export async function setClaim(db: Queryable, ticketId: string, sessionId: string, now: Date): Promise<void> {
  await db.query(
    `UPDATE tickets SET claim_session_id = $2, claimed_at = $3 WHERE id = $1 AND claim_session_id IS DISTINCT FROM $2`,
    [ticketId, sessionId, now],
  );
}

/** Drops the Ticket's Claim. */
export async function clearClaim(db: Queryable, ticketId: string): Promise<void> {
  await db.query("UPDATE tickets SET claim_session_id = NULL, claimed_at = NULL WHERE id = $1", [ticketId]);
}
