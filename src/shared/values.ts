/**
 * Value lists the server and the web client both use. Plain data only: nothing
 * here may import server code, since it ends up in the web bundle.
 */

/** The fixed Status Categories every Status belongs to (ADR 0011), in workflow order. */
export const STATUS_CATEGORIES = ["backlog", "unstarted", "started", "in_review", "completed", "canceled"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** The Status Categories of finished work: nothing is left to do on a Ticket in one, and it blocks nothing. */
export const FINISHED_CATEGORIES: readonly StatusCategory[] = ["completed", "canceled"];

/** The Status Categories of work an Agent can take up: a Ticket In Review waits on a User, and finished work has nothing left to do. */
export const WORKABLE_CATEGORIES: readonly StatusCategory[] = ["backlog", "unstarted", "started"];

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

/** Why a Ticket lists a Document: it is one of the Ticket's Reports, was linked to it, or mentions its key. */
export const LINK_REASONS = ["report", "linked", "mention"] as const;
export type LinkReason = (typeof LINK_REASONS)[number];

/** How a Comment @mentions an Agent, for the API's and the MCP tools' descriptions. */
export const MENTION_SYNTAX =
  "`@name` mentions the writer's own Agent of that name (for an Agent, its Owner's), or else every other Owner's Agent " +
  'of that name; `@owner/name` picks another Owner\'s Agent; quote names with spaces, as in `@"claude laptop"` or ' +
  '`@"Ada Lovelace"/codex`. Mentions inside code and block quotes don\'t count.';

/** What a search can find: Tickets, Documents in a page tree, Reports, and Comments. */
/**
 * The media types of the files a browser shows or plays in the page, by kind: Cronk serves these inline and shows them
 * in the Ticket's Attachments. None can run script; any other file, HTML and SVG above all, is saved instead.
 */
export const SHOWN_MEDIA_TYPES = {
  image: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"],
  video: ["video/mp4", "video/webm", "video/ogg"],
  audio: ["audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/flac"],
  text: ["text/plain"],
} as const;

export const SEARCH_KINDS = ["ticket", "document", "report", "comment"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** The files a Markdown folder import reads, by name; the web client packs only these, the server imports only these. */
export const MARKDOWN_FILE = /\.(md|markdown)$/i;
