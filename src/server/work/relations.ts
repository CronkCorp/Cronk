import type { Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { listTicketRefs, recordChange, type Ticket, type TicketRef } from "./tickets.js";

/**
 * How one Ticket relates to another, read from the first Ticket's side.
 * `blocks` and `blocked_by` are the two sides of one blocking relation;
 * `relates_to` reads the same from both sides.
 */
export const RELATION_KINDS = ["blocks", "blocked_by", "relates_to"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

const inverse: Record<RelationKind, RelationKind> = { blocks: "blocked_by", blocked_by: "blocks", relates_to: "relates_to" };

/** A Ticket's relations to other Tickets, each list in key order. */
export interface Relations {
  blocks: TicketRef[];
  blockedBy: TicketRef[];
  relatesTo: TicketRef[];
}

/** The stored row for a relation: blocking runs from blocker to blocked; relating is stored once, lower id first. */
function stored(ticket: Ticket, kind: RelationKind, other: Ticket): { kind: "blocks" | "relates_to"; from: string; to: string } {
  switch (kind) {
    case "blocks":
      return { kind: "blocks", from: ticket.id, to: other.id };
    case "blocked_by":
      return { kind: "blocks", from: other.id, to: ticket.id };
    case "relates_to":
      return ticket.id < other.id
        ? { kind: "relates_to", from: ticket.id, to: other.id }
        : { kind: "relates_to", from: other.id, to: ticket.id };
  }
}

/**
 * Takes the Workspace's lock on blocking relations until the transaction ends,
 * so two relations added at once can't close a cycle between them.
 */
async function lockBlocking(db: Queryable, workspaceId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-blocking:${workspaceId}`]);
}

/** Whether `blocker` blocking `blocked` would close a cycle: `blocked` already blocks `blocker`, directly or through others. */
async function wouldCycle(db: Queryable, blocker: string, blocked: string): Promise<boolean> {
  const { rows } = await db.query(
    `WITH RECURSIVE downstream(id) AS (
       SELECT $1::uuid
       UNION SELECT r.to_ticket_id FROM ticket_relations r JOIN downstream d ON r.from_ticket_id = d.id WHERE r.kind = 'blocks'
     )
     SELECT 1 FROM downstream WHERE id = $2`,
    [blocked, blocker],
  );
  return rows.length > 0;
}

export type AddResult = "added" | "already there" | "cycle";

/**
 * Relates `ticket` to `other`, recording it in both Tickets' history. Refuses a
 * blocking relation that would close a cycle. The Tickets must differ and share
 * a Workspace. Run inside a transaction.
 */
export async function addRelation(
  db: Queryable,
  input: { workspaceId: string; ticket: Ticket; kind: RelationKind; other: Ticket; actor: Actor; now: Date },
): Promise<AddResult> {
  const row = stored(input.ticket, input.kind, input.other);
  if (row.kind === "blocks") {
    await lockBlocking(db, input.workspaceId);
    if (await wouldCycle(db, row.from, row.to)) return "cycle";
  }
  const { rowCount } = await db.query(
    `INSERT INTO ticket_relations (kind, from_ticket_id, to_ticket_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [row.kind, row.from, row.to],
  );
  if (rowCount === 0) return "already there";
  await recordBothSides(db, "relation added", input);
  return "added";
}

/** Removes a relation, recording it in both Tickets' history. Returns false if there was no such relation. Run inside a transaction. */
export async function removeRelation(
  db: Queryable,
  input: { ticket: Ticket; kind: RelationKind; other: Ticket; actor: Actor; now: Date },
): Promise<boolean> {
  const row = stored(input.ticket, input.kind, input.other);
  const { rowCount } = await db.query("DELETE FROM ticket_relations WHERE kind = $1 AND from_ticket_id = $2 AND to_ticket_id = $3", [
    row.kind,
    row.from,
    row.to,
  ]);
  if (rowCount === 0) return false;
  await recordBothSides(db, "relation removed", input);
  return true;
}

async function recordBothSides(
  db: Queryable,
  change: "relation added" | "relation removed",
  input: { ticket: Ticket; kind: RelationKind; other: Ticket; actor: Actor; now: Date },
): Promise<void> {
  const { ticket, kind, other, actor, now } = input;
  await recordChange(db, ticket.id, actor, now, { change, kind, ticket: { key: other.key, title: other.title } });
  await recordChange(db, other.id, actor, now, { change, kind: inverse[kind], ticket: { key: ticket.key, title: ticket.title } });
}

export async function listRelations(db: Queryable, ticketId: string): Promise<Relations> {
  const related = (sql: string) => listTicketRefs(db, `t.id IN (${sql})`, [ticketId]);
  return {
    blocks: await related("SELECT to_ticket_id FROM ticket_relations WHERE kind = 'blocks' AND from_ticket_id = $1"),
    blockedBy: await related("SELECT from_ticket_id FROM ticket_relations WHERE kind = 'blocks' AND to_ticket_id = $1"),
    relatesTo: await related(
      `SELECT to_ticket_id FROM ticket_relations WHERE kind = 'relates_to' AND from_ticket_id = $1
       UNION SELECT from_ticket_id FROM ticket_relations WHERE kind = 'relates_to' AND to_ticket_id = $1`,
    ),
  };
}
