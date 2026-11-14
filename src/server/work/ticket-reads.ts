import type { Actor } from "../actor.js";
import { actingUser } from "../actor.js";
import { HttpError } from "../context.js";
import { findLiveClaim } from "../coordination/claims.js";
import type { Queryable } from "../db/database.js";
import { requireProjectAccess, visibleProjects, type Access } from "../identity/access.js";
import { ref } from "../schemas.js";
import { findProjectById, listAllProjects } from "./projects.js";
import { listRelations, type Relations } from "./relations.js";
import { findTicketByKey, listSubTickets, type RecordedChange, type Ticket, type TicketRef } from "./tickets.js";

/** Reading Tickets as an Actor may see them: access-checked lookup, and what a Ticket shows around it. */

/**
 * The Ticket with this key, if `actor` has at least `need` in its Project. A Ticket in
 * a Project they can't see answers 404, like one that doesn't exist.
 */
export async function ticketFor(db: Queryable, actor: Actor, key: string, need: Access, opts: { forUpdate?: boolean } = {}): Promise<Ticket> {
  const ticket = await findTicketByKey(db, actingUser(actor).workspaceId, key, opts);
  const project = ticket && (await findProjectById(db, ticket.projectId));
  if (!ticket || !project) throw new HttpError(404, "No such Ticket");
  await requireProjectAccess(db, actor, project, need, "No such Ticket");
  return ticket;
}

/** A Ticket with the Tickets around it and its live Claim, as its page and a Claim show it. */
export const ticketDetailSchema = {
  type: "object",
  required: ["ticket", "subTickets", "relations", "claim"],
  properties: {
    ticket: ref("Ticket"),
    subTickets: { type: "array", items: ref("TicketRef") },
    relations: ref("Relations"),
    claim: { anyOf: [ref("Claim"), { type: "null" }], description: "Null unless an Agent Session holds a live Claim." },
  },
} as const;

/** The Ticket with its Sub-Tickets, the relations `actor` can see, and its live Claim at `now`. */
export async function ticketDetail(db: Queryable, actor: Actor, ticket: Ticket, now: Date) {
  return {
    ticket,
    subTickets: await listSubTickets(db, ticket.id),
    relations: await visibleRelations(db, actor, await listRelations(db, ticket.id)),
    claim: (await findLiveClaim(db, ticket.id, now)) ?? null,
  };
}

/** Keys of the Projects, archived or not, that `actor` can see. */
async function visibleProjectKeys(db: Queryable, actor: Actor): Promise<Set<string>> {
  const projects = await listAllProjects(db, actingUser(actor).workspaceId);
  return new Set((await visibleProjects(db, actor, projects)).map((p) => p.key));
}

/** The Project key a Ticket key starts with. */
const projectKeyOf = (ticketKey: string) => ticketKey.slice(0, ticketKey.lastIndexOf("-"));

/** Relations, leaving out Tickets of Projects `actor` can't see. */
export async function visibleRelations(db: Queryable, actor: Actor, relations: Relations): Promise<Relations> {
  const keys = await visibleProjectKeys(db, actor);
  const visible = (refs: TicketRef[]) => refs.filter((ref) => keys.has(projectKeyOf(ref.key)));
  return { blocks: visible(relations.blocks), blockedBy: visible(relations.blockedBy), relatesTo: visible(relations.relatesTo) };
}

/** A Ticket's history, leaving out Relation changes with Tickets of Projects `actor` can't see. */
export async function visibleHistory(db: Queryable, actor: Actor, changes: RecordedChange[]): Promise<RecordedChange[]> {
  const keys = await visibleProjectKeys(db, actor);
  return changes.filter((c) => !(c.change === "relation added" || c.change === "relation removed") || keys.has(projectKeyOf(c.ticket.key)));
}
