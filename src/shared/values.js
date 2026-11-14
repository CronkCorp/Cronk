/**
 * Value lists the server and the web client both use. Plain data only: nothing
 * here may import server code, since it ends up in the web bundle.
 */
/** The fixed Status Categories every Status belongs to (ADR 0011), in workflow order. */
export const STATUS_CATEGORIES = ["backlog", "unstarted", "started", "in_review", "completed", "canceled"];
/** A Ticket's Priority, most urgent first. */
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"];
/**
 * How one Ticket relates to another, read from the first Ticket's side.
 * `blocks` and `blocked_by` are the two sides of one blocking relation;
 * `relates_to` reads the same from both sides.
 */
export const RELATION_KINDS = ["blocks", "blocked_by", "relates_to"];
