/**
 * Value lists the server and the web client both use. Plain data only: nothing
 * here may import server code, since it ends up in the web bundle.
 */

/** The fixed Status Categories every Status belongs to (ADR 0011), in workflow order. */
export const STATUS_CATEGORIES = ["backlog", "unstarted", "started", "in_review", "completed", "canceled"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** The Status Categories of finished work: nothing is left to do on a Ticket in one, and it blocks nothing. */
export const FINISHED_CATEGORIES: readonly StatusCategory[] = ["completed", "canceled"];

/** A Ticket's Priority, most urgent first. */
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * How one Ticket relates to another, read from the first Ticket's side.
 * `blocks` and `blocked_by` are the two sides of one blocking relation;
 * `relates_to` reads the same from both sides.
 */
export const RELATION_KINDS = ["blocks", "blocked_by", "relates_to"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** The kinds of Activity an Agent Session logs on a Ticket it works on. Only a question may be blocking. */
export const ACTIVITY_KINDS = ["plan", "progress", "finding", "question", "error"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * Why a Comment waits for an Agent, in order of precedence: it answers the Agent's question,
 * @mentions it, or is on a Ticket delegated to it.
 */
export const WAITING_REASONS = ["answer", "mention", "comment"] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];
