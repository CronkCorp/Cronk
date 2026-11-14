import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Queryable } from "../db/database.js";
import { NOT_LINKED, TICKET_REFERENCE } from "../../shared/ticket-references.js";

/**
 * The Tickets a Document mentions, recorded by key whenever its current Version changes, so a
 * Ticket finds the Documents that mention it through an index instead of reading every Document.
 * Keys are kept as written, so a mention counts once a Ticket with that key exists.
 */

/** The text Markdown `node` shows as prose, where the web client links Ticket keys: not code, and not inside links. */
function linkableText(node: Nodes): string[] {
  if (node.type === "text") return [node.value];
  if (!("children" in node) || NOT_LINKED.has(node.type)) return [];
  return node.children.flatMap(linkableText);
}

/**
 * The Ticket keys a Document's Version mentions, without repeats: those in its title, and those
 * its Markdown body shows as links to Tickets, as the web client renders it.
 */
export function ticketKeysIn(version: { title: string; body: string }): string[] {
  const texts = [version.title, ...linkableText(fromMarkdown(version.body))];
  return [...new Set(texts.flatMap((text) => [...text.matchAll(TICKET_REFERENCE)].map((m) => m[0])))];
}

/** Records the Tickets the Document now mentions, replacing what it mentioned before. Run in the transaction that changes it. */
export async function recordTicketMentions(db: Queryable, documentId: string, version: { title: string; body: string }): Promise<void> {
  await db.query("DELETE FROM document_ticket_mentions WHERE document_id = $1", [documentId]);
  await db.query("INSERT INTO document_ticket_mentions (document_id, ticket_key) SELECT $1, unnest($2::text[])", [
    documentId,
    ticketKeysIn(version),
  ]);
}

/** How many Documents the backfill reads at a time, so a large Workspace isn't held in memory at once. */
const BACKFILL_BATCH = 200;

/**
 * Records the mentions of every Document from its current Version, for a database that didn't
 * record them yet. It parses as `ticketKeysIn` does now, not as it did when its migration shipped:
 * if what counts as a mention changes, add a migration that runs it again.
 */
export async function backfillTicketMentions(db: Queryable): Promise<void> {
  for (let after = "00000000-0000-0000-0000-000000000000"; ; ) {
    const { rows } = await db.query<{ id: string; title: string; body: string }>(
      "SELECT id, title, body FROM documents WHERE id > $1 ORDER BY id LIMIT $2",
      [after, BACKFILL_BATCH],
    );
    for (const d of rows) await recordTicketMentions(db, d.id, d);
    if (rows.length < BACKFILL_BATCH) return;
    after = rows[rows.length - 1]!.id;
  }
}
