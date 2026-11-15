import type { Queryable } from "../db/database.js";

/**
 * Documents linked to a Ticket from the Ticket's side, so context is one click away without
 * editing the Document. The Ticket lists them among its Documents with the reason `linked`.
 */

/** Links the Document `documentId` to the Ticket `ticketId`. Returns whether it wasn't linked already. */
export async function storeDocumentLink(db: Queryable, ticketId: string, documentId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "INSERT INTO ticket_document_links (ticket_id, document_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [ticketId, documentId],
  );
  return rowCount !== 0;
}

/** Unlinks the Document `documentId` from the Ticket `ticketId`. Returns false if it wasn't linked. */
export async function removeDocumentLink(db: Queryable, ticketId: string, documentId: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM ticket_document_links WHERE ticket_id = $1 AND document_id = $2", [ticketId, documentId]);
  return rowCount !== 0;
}
