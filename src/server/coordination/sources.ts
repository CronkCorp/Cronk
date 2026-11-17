import type { Actor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { ticketFor } from "../work/ticket-reads.js";
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
  return heldSourceClaim(db, actor, key, now, what, fits, misfit);
}

/**
 * The Claim an Agent files a Discovered Ticket from: that of the Ticket `key` names, which its Agent Session must
 * hold, or else the one Claim it holds, of any Project. A reader who can't read the source's Project doesn't see it
 * (see `Discovery.sourceTicket`), so unlike `sourceClaimOf` any held Claim fits. None for a User, who may not name one.
 */
export function discoverySourceClaimOf(db: Queryable, actor: Actor, key: string | undefined, now: Date): Promise<SourceClaim | null> {
  return heldSourceClaim(db, actor, key, now, "a Discovered Ticket", () => true, () => "");
}

async function heldSourceClaim(
  db: Queryable,
  actor: Actor,
  key: string | undefined,
  now: Date,
  what: string,
  fits: (claim: SessionClaim) => boolean,
  misfit: (ticketKey: string) => string,
): Promise<SourceClaim | null> {
  if (actor.kind === "user") {
    if (key !== undefined) throw new HttpError(400, `Only an Agent names the Ticket ${what} came from, as the one it holds the Claim on`);
    return null;
  }
  const held = actor.session ? await listSessionClaims(db, actor.session.id) : [];
  if (key === undefined) {
    const fitting = held.filter(fits);
    if (fitting.length > 1) {
      throw new HttpError(400, `Your Agent Session holds the Claims on ${fitting.map((c) => c.ticketKey).join(", ")}; name the Ticket ${what} came from as \`ticket\``);
    }
    return fitting[0] ?? null;
  }
  const ticket = await ticketFor(db, actor, key, "read");
  const claimId = await requireClaimHolder(db, actor, ticket, now, `naming it as the Ticket ${what} came from`);
  const claim = held.find((c) => c.claimId === claimId)!;
  if (!fits(claim)) throw new HttpError(400, misfit(ticket.key));
  return claim;
}
