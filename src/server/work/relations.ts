import type { Actor } from "../actor.js";
import { lockUntilCommit, type Queryable } from "../db/database.js";
import type { RelationKind } from "../../shared/values.js";
import { listIdentifiedTicketRefs, listTicketRefs, recordChange, type AgentRef, type Ticket, type TicketRef } from "./tickets.js";


const inverse: Record<RelationKind, RelationKind> = { blocks: "blocked_by", blocked_by: "blocks", relates_to: "relates_to" };

/** Who added a block from their Discovered Ticket, and why. */
export interface DiscoveredBlock {
  agent: AgentRef;
  reason: string;
}

/** A Ticket on the other end of a block, with the Agent and reason if the block came from a Discovered Ticket (else null). */
export interface BlockingRef extends TicketRef {
  block: DiscoveredBlock | null;
}

/** A Ticket's relations to other Tickets, each list in key order. */
export interface Relations {
  blocks: BlockingRef[];
  blockedBy: BlockingRef[];
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

/** A row of `ticket_relations`, with the Agent and reason of a block from a Discovered Ticket. */
export interface StoredRelation {
  kind: "blocks" | "relates_to";
  from: string;
  to: string;
  block?: { agentId: string; reason: string } | null;
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
 * `workspaceId`. `block` records the Agent and reason of a block from its Discovered Ticket. Run inside a transaction.
 */
export async function addRelation(
  db: Queryable,
  workspaceId: string,
  input: RelationChange & { block?: { agentId: string; reason: string } },
): Promise<boolean> {
  const row: StoredRelation = { ...storedRow(input.ticket, input.kind, input.other), block: input.block ?? null };
  if (row.kind === "blocks") {
    // One blocking change per Workspace at a time, so two added at once can't close a cycle between them.
    await lockUntilCommit(db, `ticket-blocking:${workspaceId}`);
    if (await wouldCycle(db, row.from, row.to)) return false;
  }
  if (await storeRelation(db, row)) await recordBothSides(db, "relation added", input);
  return true;
}

/**
 * Stores a relation between two Tickets by id, without checks or history, as an import does;
 * relating is stored once, lower id first. Returns whether it wasn't stored already.
 */
export async function storeRelation(db: Queryable, row: StoredRelation): Promise<boolean> {
  const [from, to] = row.kind === "relates_to" && row.to < row.from ? [row.to, row.from] : [row.from, row.to];
  const { rowCount } = await db.query(
    `INSERT INTO ticket_relations (kind, from_ticket_id, to_ticket_id, added_by_agent_id, reason) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [row.kind, from, to, row.block?.agentId ?? null, row.block?.reason ?? null],
  );
  return rowCount !== 0;
}

/** Whether `blocker` blocks `blocked` by a block an Agent added from its Discovered Ticket. */
export async function isDiscoveredBlock(db: Queryable, blocker: string, blocked: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "SELECT 1 FROM ticket_relations WHERE kind = 'blocks' AND from_ticket_id = $1 AND to_ticket_id = $2 AND added_by_agent_id IS NOT NULL",
    [blocker, blocked],
  );
  return rowCount !== 0;
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

/** The Tickets at the `other` end of the blocks whose `end` is `ticketId`, each with the Agent and reason of a block from a Discovered Ticket. */
async function blockingRefs(db: Queryable, ticketId: string, end: "from_ticket_id" | "to_ticket_id", other: "from_ticket_id" | "to_ticket_id"): Promise<BlockingRef[]> {
  const { rows } = await db.query<{ id: string; agent_id: string | null; agent_name: string | null; reason: string | null }>(
    `SELECT r.${other} AS id, r.added_by_agent_id AS agent_id, a.name AS agent_name, r.reason
     FROM ticket_relations r LEFT JOIN agents a ON a.id = r.added_by_agent_id
     WHERE r.kind = 'blocks' AND r.${end} = $1`,
    [ticketId],
  );
  const blocks = new Map(rows.map((r) => [r.id, r.agent_id === null ? null : { agent: { id: r.agent_id, name: r.agent_name! }, reason: r.reason! }]));
  const refs = await listIdentifiedTicketRefs(db, "t.id = ANY($1::uuid[])", [[...blocks.keys()]]);
  return refs.map(({ id, ...ref }) => ({ ...ref, block: blocks.get(id)! }));
}

export async function listRelations(db: Queryable, ticketId: string): Promise<Relations> {
  const related = (sql: string) => listTicketRefs(db, `t.id IN (${sql})`, [ticketId]);
  return {
    blocks: await blockingRefs(db, ticketId, "from_ticket_id", "to_ticket_id"),
    blockedBy: await blockingRefs(db, ticketId, "to_ticket_id", "from_ticket_id"),
    relatesTo: await related(
      `SELECT to_ticket_id FROM ticket_relations WHERE kind = 'relates_to' AND from_ticket_id = $1
       UNION SELECT from_ticket_id FROM ticket_relations WHERE kind = 'relates_to' AND to_ticket_id = $1`,
    ),
  };
}
