import type { Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import type { Document } from "../knowledge/documents.js";
import { recordChange, type Ticket } from "./tickets.js";

/**
 * Documents linked to a Ticket from the Ticket's side, so context is one click away without
 * editing the Document. The Ticket lists them among its Documents with the reason `linked`.
 */

/** A link being made or removed: `document` on `ticket`, by `actor` at `now`. */
export interface DocumentLinkChange {
  ticket: Ticket;
  document: Document;
  actor: Actor;
  now: Date;
}

/** Links a Document to a Ticket, recording it in the Ticket's history unless it was linked already. Run inside a transaction. */
export async function linkDocument(db: Queryable, input: DocumentLinkChange): Promise<void> {
  if (await storeDocumentLink(db, input.ticket.id, input.document.id)) await recordLinkChange(db, "document linked", input);
}

/** Unlinks a Document from a Ticket, recording it in the Ticket's history. Returns false if it wasn't linked. Run inside a transaction. */
export async function unlinkDocument(db: Queryable, input: DocumentLinkChange): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM ticket_document_links WHERE ticket_id = $1 AND document_id = $2", [
    input.ticket.id,
    input.document.id,
  ]);
  if (rowCount === 0) return false;
  await recordLinkChange(db, "document unlinked", input);
  return true;
}

/** Links the Document `documentId` to the Ticket `ticketId` without history, as an import does. Returns whether it wasn't linked already. */
export async function storeDocumentLink(db: Queryable, ticketId: string, documentId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "INSERT INTO ticket_document_links (ticket_id, document_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [ticketId, documentId],
  );
  return rowCount !== 0;
}

async function recordLinkChange(db: Queryable, change: "document linked" | "document unlinked", { ticket, document, actor, now }: DocumentLinkChange): Promise<void> {
  await recordChange(db, ticket.id, actor, now, { change, document: { id: document.id, title: document.title, projectKey: document.projectKey } });
}
