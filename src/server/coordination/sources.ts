import type { Actor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { ticketFor } from "../work/ticket-reads.js";
import { lockTicketsByIds } from "../work/tickets.js";
import { listSessionClaims, requireClaimHolder, type SessionClaim } from "./claims.js";

/** The Claim an Agent made something in, and its Ticket: where a proposed Decision or a Suggestion came from. */
export interface SourceClaim {
  ticketId: string;
  claimId: string;
}

/**
 * The Claim an Agent makes `what` (such as "a Decision") in a Project, or the Workspace when `projectId` is
 * null, from: that of the Ticket `key` names, which its Agent Session must hold, or else the one Claim it
 * holds whose Ticket fits. A Ticket fits when everyone who can read where `what` lives can read it: it is of
 * that Project, or, in the Workspace, of an open Project. None for a User, who may not name one.
 *
 * Run inside the caller's transaction: it locks the returned Claim's Ticket and checks the Claim again once
 * locked, so a release, Delegate change or Claim-ending move waits until the caller commits, and one committed
 * first is seen. Without a named Ticket, the fitting Claims' Tickets are locked in id order, as other lockers of
 * several Tickets do.
 */
export async function sourceClaimOf(
  db: Queryable,
  actor: Actor,
  projectId: string | null,
  key: string | undefined,
  now: Date,
  what: string,
): Promise<SourceClaim | null> {
  if (actor.kind === "user") {
    if (key !== undefined) throw new HttpError(400, `Only an Agent names the Ticket ${what} came from, as the one it holds the Claim on`);
    return null;
  }
  const sessionId = actor.session?.id;
  const claimsHeld = async () => (sessionId ? await listSessionClaims(db, sessionId) : []);
  const fits = (claim: SessionClaim) => (projectId === null ? !claim.private : claim.projectId === projectId);
  if (key === undefined) {
    const candidates = new Set((await claimsHeld()).filter(fits).map((c) => c.ticketId));
    if (candidates.size === 0) return null;
    await lockTicketsByIds(db, [...candidates]);
    // Only Claims seen before locking: one this Session took meanwhile was never locked here.
    const fitting = (await claimsHeld()).filter((c) => candidates.has(c.ticketId) && fits(c));
    if (fitting.length > 1) {
      throw new HttpError(400, `Your Agent Session holds the Claims on ${fitting.map((c) => c.ticketKey).join(", ")}; name the Ticket ${what} came from as \`ticket\``);
    }
    return fitting[0] ?? null;
  }
  const ticket = await ticketFor(db, actor, key, "read", { forUpdate: true });
  const claimId = await requireClaimHolder(db, actor, ticket, now, `naming it as the Ticket ${what} came from`);
  const claim = (await claimsHeld()).find((c) => c.claimId === claimId)!;
  if (!fits(claim)) {
    const whole = what.replace(/^an? /, "");
    throw new HttpError(
      400,
      projectId === null
        ? `${ticket.key} is in a private Project, so a Workspace ${whole} can't name it: not everyone who reads it may read the Ticket`
        : `${ticket.key} isn't a Ticket of the ${whole}'s Project; ${what} names a source Ticket of its own Project`,
    );
  }
  return claim;
}
