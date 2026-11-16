import type { Actor, RecordedActor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";

/**
 * Protected (ADR 0004): a Document, Term or Decision Agents may read but never change, whatever
 * their Agent Access. Only Users with Write where the item lives mark and unmark it, and each time
 * is recorded in the item's protection history. A Document's mark covers every Document under it.
 */

/** An item that can be marked Protected. */
export type ProtectableKind = "document" | "term" | "decision";
/** One item that can be marked Protected, by its kind and id. */
export interface ProtectableItem {
  kind: ProtectableKind;
  id: string;
}

const TABLE: Record<ProtectableKind, string> = { document: "documents", term: "terms", decision: "decisions" };
/** The column of `protection_markings` naming each kind of item. */
export const PROTECTION_COLUMN: Record<ProtectableKind, string> = { document: "document_id", term: "term_id", decision: "decision_id" };

/** One marking of an item as Protected, or unmarking, with the User who did it. */
export interface ProtectionMarking {
  protected: boolean;
  at: Date;
  actor: RecordedActor & { kind: "user" };
}

/**
 * Marks the item Protected, or unmarks it, by the User `userId`, and records it in the item's
 * protection history; returns false, recording nothing, when it already was as asked.
 */
export async function setProtected(db: Queryable, item: ProtectableItem, marked: boolean, userId: string, at: Date): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE ${TABLE[item.kind]} SET protected = $2 WHERE id = $1 AND protected <> $2`, [item.id, marked]);
  if (rowCount === 0) return false;
  await insertProtectionMarking(db, item, { protected: marked, at, userId });
  return true;
}

/** Sets the item's mark as given without recording it, as an import does before writing the history it holds. */
export async function setProtectedFlag(db: Queryable, item: ProtectableItem, marked: boolean): Promise<void> {
  await db.query(`UPDATE ${TABLE[item.kind]} SET protected = $2 WHERE id = $1`, [item.id, marked]);
}

/** Records one marking or unmarking in an item's protection history, as an import writes it; changes no mark. */
export async function insertProtectionMarking(db: Queryable, item: ProtectableItem, marking: { protected: boolean; at: Date; userId: string }): Promise<void> {
  await db.query(`INSERT INTO protection_markings (${PROTECTION_COLUMN[item.kind]}, protected, at, actor_user_id) VALUES ($1, $2, $3, $4)`, [
    item.id,
    marking.protected,
    marking.at,
    marking.userId,
  ]);
}

/** An item's protection history, newest first. */
export async function listProtectionMarkings(db: Queryable, item: ProtectableItem): Promise<ProtectionMarking[]> {
  const { rows } = await db.query<{ protected: boolean; at: Date; user_id: string; user_name: string }>(
    `SELECT c.protected, c.at, u.id AS user_id, u.name AS user_name
     FROM protection_markings c JOIN users u ON u.id = c.actor_user_id
     WHERE c.${PROTECTION_COLUMN[item.kind]} = $1 ORDER BY c.id DESC`,
    [item.id],
  );
  return rows.map((r) => ({ protected: r.protected, at: r.at, actor: { kind: "user", id: r.user_id, name: r.user_name } }));
}

/**
 * Refuses an Agent's change to a Protected item (a 403) with a pointer to Suggestions, the way an
 * Agent proposes a change to one. `what` names the item, such as "Architecture" or "CRONK-D3", and
 * `change` what the Agent may not do, such as "delete it".
 */
export function requireUnprotected(actor: Actor, item: { protected: boolean }, what: string, change = "change it"): void {
  if (actor.kind !== "agent" || !item.protected) return;
  throw new HttpError(
    403,
    `${what} is Protected: Agents may read it but not ${change}. Make a Suggestion of the change instead, for a User to accept or reject`,
  );
}
