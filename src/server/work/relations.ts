import type { Actor } from "../actor.js";
import { lockUntilCommit, type Queryable } from "../db/database.js";
import { listTicketRefs, recordChange, type Ticket, type TicketRef } from "./tickets.js";

import type { RelationKind } from "../../shared/values.js";

export { RELATION_KINDS, type RelationKind } from "../../shared/values.js";

const inverse: Record<RelationKind, RelationKind> = { blocks: "blocked_by", blocked_by: "blocks", relates_to: "relates_to" };

/** A Ticket's relations to other Tickets, each list in key order. */
export interface Relations {
  blocks: TicketRef[];
  blockedBy: TicketRef[];
  relatesTo: TicketRef[];
}

/** A relation change: `ticket` relating to `other` as `kind`, made by `actor` at `now`. */
export interface RelationChange {
  ticket: Ticket;
  kind: RelationKind;
  other: Ticket;
  actor: Actor;
  now: Date;
}

/** The stored row for a relation: blocking runs from blocker to blocked; relating is stored once, lower id first. */
function storedRow(ticket: Ticket, kind: RelationKind, other: Ticket): { kind: "blocks" | "relates_to"; from: string; to: string } {
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

/**
 * Relates `ticket` to `other`, recording it in both Tickets' history unless they
 * were already related that way. Returns false, changing nothing, for a blocking
 * relation that would close a cycle. The Tickets must differ and share
 * `workspaceId`. Run inside a transaction.
 */
export async function addRelation(db: Queryable, workspaceId: string, input: RelationChange): Promise<boolean> {
  const row = storedRow(input.ticket, input.kind, input.other);
  if (row.kind === "blocks") {
    // One blocking change per Workspace at a time, so two added at once can't close a cycle between them.
    await lockUntilCommit(db, `ticket-blocking:${workspaceId}`);
    if (await wouldCycle(db, row.from, row.to)) return false;
  }
  const { rowCount } = await db.query(
    `INSERT INTO ticket_relations (kind, from_ticket_id, to_ticket_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [row.kind, row.from, row.to],
  );
  if (rowCount !== 0) await recordBothSides(db, "relation added", input);
  return true;
}

/** Removes a relation, recording it in both Tickets' history. Returns false if there was no such relation. Run inside a transaction. */
export async function removeRelation(db: Queryable, input: RelationChange): Promise<boolean> {
  const row = storedRow(input.ticket, input.kind, input.other);
  const { rowCount } = await db.query("DELETE FROM ticket_relations WHERE kind = $1 AND from_ticket_id = $2 AND to_ticket_id = $3", [
    row.kind,
    row.from,
    row.to,
  ]);
  if (rowCount === 0) return false;
  await recordBothSides(db, "relation removed", input);
  return true;
}

async function recordBothSides(db: Queryable, change: "relation added" | "relation removed", input: RelationChange): Promise<void> {
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
