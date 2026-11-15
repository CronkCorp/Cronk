import type { Actor } from "../actor.js";
import { actingUser } from "../actor.js";
import { HttpError } from "../context.js";
import { findLiveClaim } from "../coordination/claims.js";
import type { Queryable } from "../db/database.js";
import { canRead, readablePlaces, requireProjectAccess, visibleProjects, type Access } from "../identity/access.js";
import { listLinkedDocuments } from "../knowledge/documents.js";
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

/** A Ticket with the Tickets and Documents around it and its live Claim, as its page and a Claim show it. */
export const ticketDetailSchema = {
  type: "object",
  required: ["ticket", "subTickets", "relations", "documents", "claim"],
  properties: {
    ticket: ref("Ticket"),
    subTickets: { type: "array", items: ref("TicketRef") },
    relations: ref("Relations"),
    documents: {
      type: "array",
      items: ref("LinkedDocument"),
      description:
        "Its Reports, oldest first; then the Documents the caller can read that were linked to it, in the order linked; then those whose current Version mentions its key, most recently changed first (at most 20). Each is listed once.",
    },
    claim: { anyOf: [ref("Claim"), { type: "null" }], description: "Null unless an Agent Session holds a live Claim." },
  },
} as const;

/** The Ticket with its Sub-Tickets, the relations and linked Documents `actor` can see, and its live Claim at `now`. */
export async function ticketDetail(db: Queryable, actor: Actor, ticket: Ticket, now: Date) {
  return {
    ticket,
    subTickets: await listSubTickets(db, ticket.id),
    relations: await visibleRelations(db, actor, await listRelations(db, ticket.id)),
    documents: await listLinkedDocuments(db, ticket, await readablePlaces(db, actor)),
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

/**
 * A Ticket's history, leaving out Relation changes with Tickets of Projects `actor` can't see, and
 * Document links to Documents of places they can't read.
 */
export async function visibleHistory(db: Queryable, actor: Actor, changes: RecordedChange[]): Promise<RecordedChange[]> {
  const keys = await visibleProjectKeys(db, actor);
  const workspaceReadable = await canRead(db, actor, null);
  return changes.filter((c) => {
    switch (c.change) {
      case "relation added":
      case "relation removed":
        return keys.has(projectKeyOf(c.ticket.key));
      case "document linked":
      case "document unlinked":
        return c.document.projectKey === null ? workspaceReadable : keys.has(c.document.projectKey);
      default:
        return true;
    }
  });
}
