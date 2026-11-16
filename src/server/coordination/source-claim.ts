import type { Actor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { ticketFor } from "../work/ticket-reads.js";
import { listSessionClaims, requireClaimHolder, type SessionClaim } from "./claims.js";

/**
 * The Claim an Agent made something from, such as a Decision it proposed or an Artifact it published, in the Project
 * `from.projectId` (null for the Workspace): that of the Ticket `from.ticketKey` names, which its Agent Session must hold, or else the
 * one Claim it holds whose Ticket fits. A Ticket fits when everyone who can read the thing can read it: it is of the
 * thing's Project, or, for a thing of the Workspace, of an open Project. None for a User, who may not name one.
 * `noun` names the thing in refusals, such as "Decision", and `refusedAction` completes "Claim CRONK-1 in your Agent
 * Session before …", such as "proposing a Decision from it".
 */
export async function sourceClaimOf(
  tx: Queryable,
  actor: Actor,
  from: { projectId: string | null; ticketKey: string | undefined; now: Date },
  what: { noun: string; refusedAction: string },
): Promise<SessionClaim | null> {
  const { noun } = what;
  const { projectId, ticketKey: key, now } = from;
  if (actor.kind === "user") {
    if (key !== undefined) throw new HttpError(400, `Only an Agent names the Ticket a ${noun} came from, as the one it holds the Claim on`);
    return null;
  }
  const held = actor.session ? await listSessionClaims(tx, actor.session.id) : [];
  const fits = (claim: SessionClaim) => (projectId === null ? !claim.private : claim.projectId === projectId);
  if (key === undefined) {
    const fitting = held.filter(fits);
    if (fitting.length > 1) {
      throw new HttpError(400, `Your Agent Session holds the Claims on ${fitting.map((c) => c.ticketKey).join(", ")}; name the Ticket the ${noun} came from as \`ticket\``);
    }
    return fitting[0] ?? null;
  }
  const ticket = await ticketFor(tx, actor, key, "read");
  const claimId = await requireClaimHolder(tx, actor, ticket, now, what.refusedAction);
  const claim = held.find((c) => c.claimId === claimId)!;
  if (!fits(claim)) {
    throw new HttpError(
      400,
      projectId === null
        ? `${ticket.key} is in a private Project, so a Workspace ${noun} can't name it: not everyone who reads the ${noun} may read it`
        : `${ticket.key} isn't a Ticket of the ${noun}'s Project; a ${noun} names a source Ticket of its own Project`,
    );
  }
  return claim;
}
