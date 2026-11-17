import type { Actor, RecordedActor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";

/**
 * Protected (ADR 0004): a Document, Term, Decision or Artifact Agents may read but never change, whatever
 * their Agent Access. Only Users with Write where the item lives mark and unmark it, and each time
 * is recorded in the item's protection history. A Document's mark covers every Document under it.
 */

/** An item that can be marked Protected. */
export type ProtectableKind = "document" | "term" | "decision" | "artifact";
/** One item that can be marked Protected, by its kind and id. */
export interface ProtectableItem {
  kind: ProtectableKind;
  id: string;
}

const TABLE: Record<ProtectableKind, string> = { document: "documents", term: "terms", decision: "decisions", artifact: "artifacts" };
/** The column of `protection_markings` naming each kind of item. */
export const PROTECTION_COLUMN: Record<ProtectableKind, string> = { document: "document_id", term: "term_id", decision: "decision_id", artifact: "artifact_id" };

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

/** What an Agent refused a change to an item it may not change does instead, ending a refusal's sentence. */
export const SUGGEST_INSTEAD =
  "make a Suggestion of the change instead (POST /api/suggestions, or the `suggestions` tool), for a User to accept or reject";

/** What an Agent refused a new Document under the Document `parentId`, in a protected branch, does instead, ending a refusal's sentence. */
export const suggestNewDocumentInstead = (parentId: string) =>
  `make a Suggestion of the new Document instead (POST /api/suggestions with item { kind: "document", parentId: "${parentId}" } and baseVersion 0, ` +
  "or the `suggestions` tool), for a User to accept or reject";

/**
 * What an Agent refused a move of the Document `documentId` into, out of or within a protected branch does
 * instead, ending a refusal's sentence. A Suggestion carries content only, never a place, so a User makes the move.
 */
export const askToMoveInstead = (documentId: string) =>
  `ask a User to move it instead, in a Comment on it (POST /api/documents/${documentId}/comments, or the \`comments\` tool) ` +
  "saying where it should go and why";

/**
 * Refuses an Agent's change to a Protected item (a 403) with a pointer to Suggestions, the way an
 * Agent proposes a change to one. `what` names the item, such as "Architecture" or "CRONK-D3",
 * `change` what the Agent may not do, such as "delete it", and `instead` what it does instead.
 */
export function requireUnprotected(actor: Actor, item: { protected: boolean }, what: string, change = "change it", instead = SUGGEST_INSTEAD): void {
  if (actor.kind !== "agent" || !item.protected) return;
  throw new HttpError(403, `${what} is Protected: Agents may read it but not ${change}. ${instead.charAt(0).toUpperCase()}${instead.slice(1)}`);
}

/**
 * SQL for whether the Document `document` (a table alias) is Protected: it, or a Document above it in its
 * page tree, is marked. A Report sits outside any tree, so only its own mark counts. It reads within the
 * query it is part of, so a list can carry each row's mark without fetching each Document.
 */
export const documentProtectedSql = (document: string) =>
  `(${document}.protected OR EXISTS (
     WITH RECURSIVE above(parent_id, protected) AS (
       SELECT x.parent_id, x.protected FROM documents x WHERE x.id = ${document}.parent_id
       UNION ALL SELECT x.parent_id, x.protected FROM documents x JOIN above ON x.id = above.parent_id
     )
     SELECT 1 FROM above WHERE above.protected
   ))`;
