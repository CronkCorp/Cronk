import type { Queryable } from "../db/database.js";

/**
 * Which Suggestion each Version of an item came from (ADR 0014): one a User accepted, unchanged (the
 * Version is then the Agent's) or with edits (the User's). Kept apart from `suggestions.ts`, which reads
 * and saves Versions itself, so the item modules can name it without depending on it.
 */

/** The accepted Suggestion a Version came from, and the User who accepted it. */
export interface VersionSuggestion {
  id: string;
  acceptedWithEdits: boolean;
  acceptedBy: { id: string; name: string };
}

/** An item whose Versions a Suggestion can make: a Document, Term or Decision by id, or the Guidance of a Project (null for the Workspace's). */
export type VersionedItem =
  | { kind: "document" | "term" | "decision"; id: string }
  | { kind: "guidance"; workspaceId: string; projectId: string | null };

const COLUMN = { document: "document_id", term: "term_id", decision: "decision_id" } as const;

/** SQL picking the Suggestions on `item` from `suggestions s`, with its parameters, numbered from $1. */
export function suggestionsOnSql(item: VersionedItem): [where: string, params: unknown[]] {
  return item.kind === "guidance"
    ? ["s.kind = 'guidance' AND s.workspace_id = $1 AND s.project_id IS NOT DISTINCT FROM $2", [item.workspaceId, item.projectId]]
    : [`s.${COLUMN[item.kind]} = $1`, [item.id]];
}

/** The accepted Suggestion each of the item's Versions came from, by Version number; Versions made otherwise are left out. */
export async function versionSuggestions(db: Queryable, item: VersionedItem): Promise<Map<number, VersionSuggestion>> {
  const [where, params] = suggestionsOnSql(item);
  const { rows } = await db.query<{ id: string; result_version: number; with_edits: boolean; user_id: string; user_name: string }>(
    `SELECT s.id, s.result_version, s.with_edits, u.id AS user_id, u.name AS user_name
     FROM suggestions s JOIN users u ON u.id = s.decided_by_user_id
     WHERE ${where} AND s.state = 'accepted'`,
    params,
  );
  return new Map(rows.map((r) => [r.result_version, { id: r.id, acceptedWithEdits: r.with_edits, acceptedBy: { id: r.user_id, name: r.user_name } }]));
}

/** `versions`, each with the accepted Suggestion it came from, or null. */
export async function withSuggestions<V extends { number: number }>(db: Queryable, item: VersionedItem, versions: V[]): Promise<(V & { suggestion: VersionSuggestion | null })[]> {
  const found = versions.length === 0 ? new Map() : await versionSuggestions(db, item);
  return versions.map((v) => ({ ...v, suggestion: found.get(v.number) ?? null }));
}
