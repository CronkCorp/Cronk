/**
 * How Markdown refers to Tickets, shared by the web client, which links the references,
 * and the server, which records the Documents that make them. Plain data only, as it ends
 * up in the web bundle.
 */

/** A Ticket key such as `CRONK-12`, as it appears in prose. */
export const TICKET_REFERENCE = /\b([A-Z][A-Z0-9]{1,9})-([1-9][0-9]{0,8})\b/g;

/** Markdown nodes whose text must stay as written, so references in them are never links: existing links and their kin. */
export const NOT_LINKED = new Set(["link", "linkReference", "definition"]);
