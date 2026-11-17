import type { Actor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { ticketFor } from "../work/ticket-reads.js";
import { shareProject } from "../work/projects.js";
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
 * several Tickets do. A Project's `what` takes the Project's key-share lock first, as inserting `what` would after,
 * so a Ticket is never locked ahead of its Project: creating Tickets and removing Statuses lock Project, then Ticket.
 */
export function sourceClaimOf(
  db: Queryable,
  actor: Actor,
  projectId: string | null,
  key: string | undefined,
  now: Date,
  what: string,
): Promise<SourceClaim | null> {
  const fits = (claim: SessionClaim) => (projectId === null ? !claim.private : claim.projectId === projectId);
  const whole = what.replace(/^an? /, "");
  const misfit = (ticketKey: string) =>
    projectId === null
      ? `${ticketKey} is in a private Project, so a Workspace ${whole} can't name it: not everyone who reads it may read the Ticket`
      : `${ticketKey} isn't a Ticket of the ${whole}'s Project; ${what} names a source Ticket of its own Project`;
  return heldSourceClaim(db, actor, key, now, what, { fit: { fits, misfit }, projectId });
}

/**
 * The Claim an Agent files a Discovered Ticket from: that of the Ticket `key` names, which its Agent Session must
 * hold, or else the one Claim it holds, of any Project. A reader who can't read the source's Project doesn't see it
 * (see `Discovery.sourceTicket`), so unlike `sourceClaimOf` any held Claim fits. None for a User, who may not name one.
 * Run inside the caller's transaction, once it has locked the Project the Ticket is filed in: it locks the Claim's
 * Ticket as `sourceClaimOf` does, together with the Tickets `blocking` names (those the Discovered Ticket blocks), in
 * id order, so two filings each blocking the other's source queue rather than deadlock.
 */
export function discoverySourceClaimOf(db: Queryable, actor: Actor, key: string | undefined, now: Date, blocking: string[]): Promise<SourceClaim | null> {
  return heldSourceClaim(db, actor, key, now, "a Discovered Ticket", { projectId: null, alsoLock: blocking });
}

/** Which held Claims `what` may come from, and why one named that doesn't fit is refused. */
interface SourceFit {
  fits: (claim: SessionClaim) => boolean;
  misfit: (ticketKey: string) => string;
}

/**
 * The Claim an Agent makes `what` from: that of the Ticket `key` names, which its Agent Session must hold, or else the one
 * Claim it holds; with `fit`, only a Claim that fits. None for a User, who may not name one. With `projectId`, takes that
 * Project's key-share lock before locking the Claim's Ticket (see `sourceClaimOf`). The Tickets with ids `alsoLock` are
 * locked with the Claim's Ticket, in id order.
 */
async function heldSourceClaim(
  db: Queryable,
  actor: Actor,
  key: string | undefined,
  now: Date,
  what: string,
  { fit, projectId, alsoLock = [] }: { fit?: SourceFit; projectId: string | null; alsoLock?: string[] },
): Promise<SourceClaim | null> {
  if (actor.kind === "user") {
    if (key !== undefined) throw new HttpError(400, `Only an Agent names the Ticket ${what} came from, as the one it holds the Claim on`);
    return null;
  }
  if (projectId !== null) await shareProject(db, projectId);
  const sessionId = actor.session?.id;
  const loadClaimsHeld = async () => (sessionId ? await listSessionClaims(db, sessionId) : []);
  const fits = fit?.fits ?? (() => true);
  if (key === undefined) {
    const candidates = new Set((await loadClaimsHeld()).filter(fits).map((c) => c.ticketId));
    if (candidates.size === 0) return null;
    await lockTicketsByIds(db, [...candidates, ...alsoLock]);
    // Only Claims seen before locking: one this Session took meanwhile was never locked here.
    const fitting = (await loadClaimsHeld()).filter((c) => candidates.has(c.ticketId) && fits(c));
    if (fitting.length > 1) {
      throw new HttpError(400, `Your Agent Session holds the Claims on ${fitting.map((c) => c.ticketKey).join(", ")}; name the Ticket ${what} came from as \`ticket\``);
    }
    return fitting[0] ?? null;
  }
  const named = await ticketFor(db, actor, key, "read");
  const ticket = (await lockTicketsByIds(db, [named.id, ...alsoLock])).find((t) => t.id === named.id) ?? named;
  const claimId = await requireClaimHolder(db, actor, ticket, now, `naming it as the Ticket ${what} came from`);
  const claim = (await loadClaimsHeld()).find((c) => c.claimId === claimId)!;
  if (fit && !fits(claim)) throw new HttpError(400, fit.misfit(ticket.key));
  return claim;
}
