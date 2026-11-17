import type { Actor } from "../actor.js";
import { holdsLockUntilCommit, lockUntilCommit, type Queryable } from "../db/database.js";
import type { RelationKind } from "../../shared/values.js";
import { findTicketById, listIdentifiedTicketRefs, listTicketRefs, recordChange, type AgentRef, type Ticket, type TicketRef } from "./tickets.js";

/** Whether taking the Workspace's blocking lock checks it comes before any Ticket lock, as `AppContext` says. */
export interface LockOrderCheck {
  checkLockOrder: boolean;
}

const inverse: Record<RelationKind, RelationKind> = { blocks: "blocked_by", blocked_by: "blocks", relates_to: "relates_to" };

/** Who added a block from their Discovered Ticket, and why. */
export interface DiscoveredBlock {
  agent: AgentRef;
  reason: string;
}

/** A block an Agent adds from its Discovered Ticket, as stored: the Agent's id and why. */
export interface NewDiscoveredBlock {
  agentId: string;
  reason: string;
}

/**
 * A Ticket on the other end of a block, with the block's opaque id and the Agent and reason if the block came from a
 * Discovered Ticket (else null).
 */
export interface BlockingRef extends TicketRef {
  blockId: string;
  block: DiscoveredBlock | null;
}

/** A block from a Discovered Ticket the reader can't see: the block's opaque id, the Agent and why, but nothing of the Ticket. */
export interface HiddenBlocker {
  hidden: true;
  blockId: string;
  block: DiscoveredBlock;
}

/** A Ticket's relations to other Tickets, each list in key order. */
export interface Relations {
  blocks: BlockingRef[];
  blockedBy: BlockingRef[];
  relatesTo: TicketRef[];
}

/** A Ticket's relations as a reader is shown them: `blockedBy` ends with placeholders for the blocks from Discovered Tickets they can't see. */
export interface ShownRelations extends Omit<Relations, "blockedBy"> {
  blockedBy: (BlockingRef | HiddenBlocker)[];
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
  block?: NewDiscoveredBlock | null;
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

/** Whether a Relation of this kind is a block, one way or the other. */
export const isBlocking = (kind: RelationKind): boolean => kind !== "relates_to";

/**
 * Takes the Workspace's blocking lock until the transaction commits: one blocking change per Workspace at a time, so two
 * added at once can't close a cycle between them. A transaction adding a block takes it before locking any Ticket, since
 * the block's row then takes both Tickets' key-share lock: one holding a Ticket while it waits for this lock would deadlock
 * with one holding this lock while it waits for that Ticket. Taking it again in the same transaction is a no-op.
 * With `checkLockOrder` (`AppConfig`, on outside production), taking it first after locking a Ticket throws, so a path
 * with the order wrong fails in tests.
 */
export async function lockBlocking(db: Queryable, workspaceId: string, { checkLockOrder }: LockOrderCheck): Promise<void> {
  const name = `ticket-blocking:${workspaceId}`;
  if (checkLockOrder) await requireBlockingLockFirst(db, name);
  await lockUntilCommit(db, name);
}

/**
 * Throws if the transaction locked or wrote a Ticket row but doesn't yet hold the blocking lock `name`. Postgres keeps a
 * transaction's row locks on a table as its RowShareLock on it (a foreign key's key-share lock too), and its writes as its
 * RowExclusiveLock, until the transaction or savepoint ends. Cautious: a lock or write that matched no row, or the insert
 * of a Ticket no other transaction can see yet, counts too.
 */
async function requireBlockingLockFirst(db: Queryable, name: string): Promise<void> {
  if (await holdsLockUntilCommit(db, name)) return;
  const { rowCount } = await db.query(
    `SELECT 1 FROM pg_locks
     WHERE pid = pg_backend_pid() AND granted AND locktype = 'relation' AND relation = 'tickets'::regclass
       AND mode IN ('RowShareLock', 'RowExclusiveLock')`,
  );
  if (rowCount !== 0) {
    const err = new Error("Took the Workspace's blocking lock after locking a Ticket, which can deadlock: take lockBlocking before locking any Ticket");
    // Printed too, as a request answers only "Something went wrong" and tests run without a logger.
    console.error(err);
    throw err;
  }
}

/**
 * Relates `ticket` to `other`, recording it in both Tickets' history unless they
 * were already related that way. Returns false, changing nothing, for a blocking
 * relation that would close a cycle. The Tickets must differ and share
 * `workspaceId`. `block` records the Agent and reason of a block from its Discovered Ticket. Run inside a transaction
 * that took `lockBlocking` before locking any Ticket, for a blocking relation.
 */
export async function addRelation(
  db: Queryable,
  workspaceId: string,
  input: RelationChange & { block?: NewDiscoveredBlock },
  check: LockOrderCheck,
): Promise<boolean> {
  const row: StoredRelation = { ...storedRow(input.ticket, input.kind, input.other), block: input.block ?? null };
  if (row.kind === "blocks") {
    await lockBlocking(db, workspaceId, check);
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

/** The Ticket blocking `blockedId` by the block from a Discovered Ticket with this id, if there is one. */
export async function findDiscoveredBlocker(db: Queryable, blockId: string, blockedId: string): Promise<Ticket | undefined> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT from_ticket_id AS id FROM ticket_relations WHERE id = $1 AND kind = 'blocks' AND to_ticket_id = $2 AND added_by_agent_id IS NOT NULL",
    [blockId, blockedId],
  );
  return rows[0] && findTicketById(db, rows[0].id);
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

/**
 * For each of `ticketIds`, the Tickets it blocks (`side` "from") or is blocked by ("to"), in key order, each with the block's id
 * and the Agent and reason of a block from a Discovered Ticket. Two queries, however many Tickets are asked about.
 */
export async function blockingRefsOf(db: Queryable, ticketIds: string[], side: "from" | "to"): Promise<Map<string, BlockingRef[]>> {
  const [end, other] = side === "from" ? ["from_ticket_id", "to_ticket_id"] : ["to_ticket_id", "from_ticket_id"];
  const { rows } = await db.query<{ end_id: string; id: string; block_id: string; agent_id: string | null; agent_name: string | null; reason: string | null }>(
    `SELECT r.${end} AS end_id, r.${other} AS id, r.id AS block_id, r.added_by_agent_id AS agent_id, a.name AS agent_name, r.reason
     FROM ticket_relations r LEFT JOIN agents a ON a.id = r.added_by_agent_id
     WHERE r.kind = 'blocks' AND r.${end} = ANY($1::uuid[])`,
    [ticketIds],
  );
  const blocks = new Map<string, Map<string, Pick<BlockingRef, "blockId" | "block">>>(ticketIds.map((id) => [id, new Map()]));
  for (const r of rows) {
    const block = r.agent_id === null ? null : { agent: { id: r.agent_id, name: r.agent_name! }, reason: r.reason! };
    blocks.get(r.end_id)!.set(r.id, { blockId: r.block_id, block });
  }
  const refs = rows.length === 0 ? [] : await listIdentifiedTicketRefs(db, "t.id = ANY($1::uuid[])", [[...new Set(rows.map((r) => r.id))]]);
  // Walked in key order, so each Ticket's list keeps it.
  const result = new Map<string, BlockingRef[]>(ticketIds.map((id) => [id, []]));
  for (const { id: otherId, ...ref } of refs) {
    for (const [id, others] of blocks) if (others.has(otherId)) result.get(id)!.push({ ...ref, ...others.get(otherId)! });
  }
  return result;
}

/** A Ticket's relations, each with the Tickets at its other end in key order; blocks carry who added one from a Discovered Ticket, and why. */
export async function listRelations(db: Queryable, ticketId: string): Promise<Relations> {
  const related = (sql: string) => listTicketRefs(db, `t.id IN (${sql})`, [ticketId]);
  return {
    blocks: (await blockingRefsOf(db, [ticketId], "from")).get(ticketId)!,
    blockedBy: (await blockingRefsOf(db, [ticketId], "to")).get(ticketId)!,
    relatesTo: await related(
      `SELECT to_ticket_id FROM ticket_relations WHERE kind = 'relates_to' AND from_ticket_id = $1
       UNION SELECT from_ticket_id FROM ticket_relations WHERE kind = 'relates_to' AND to_ticket_id = $1`,
    ),
  };
}
