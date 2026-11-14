import type { Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { readablePlaces, type Readable } from "../identity/access.js";
import { ticketKeySql } from "../work/tickets.js";
import type { SearchKind } from "../../shared/values.js";

/**
 * Full-text search over what an Actor may read, with Postgres's own text search (no extra
 * service). Each kind of thing is searched by the same expression its index is built on
 * (see migration 0014), so the indexes serve these queries.
 */


/** One thing a search found, with an excerpt of its text around the match. */
export interface SearchResult {
  kind: SearchKind;
  /** The Ticket's or Document's title. */
  title: string;
  /** Plain text around the match, from the body (or the title when the body is empty). */
  excerpt: string;
  /** Null for something in the Workspace outside any Project. */
  projectKey: string | null;
  ticketKey: string | null;
  documentId: string | null;
}

/** The text-search configuration everything is indexed and searched with. */
const CONFIG = "'english'";

/** Options for the excerpt: plain text (no markers), a short stretch around the match. */
const EXCERPT = `'StartSel="", StopSel="", MinWords=10, MaxWords=30'`;

/** The searchable text of each kind, as its index is built on. */
const TICKET_TEXT = "t.title || ' ' || t.description";
const DOCUMENT_TEXT = "d.title || ' ' || d.body";
const COMMENT_TEXT = "c.body";

/** The excerpt of `body` around the match, falling back to `title` when the body is empty. */
const excerpt = (title: string, body: string) => `ts_headline(${CONFIG}, CASE WHEN ${body} = '' THEN ${title} ELSE ${body} END, q.query, ${EXCERPT})`;

/** The columns every kind's SELECT gives, in order: a result's fields, its rank, and when it last changed. */
const columns = (c: { kind: SearchKind; title: string; projectKey: string; ticketKey: string; documentId: string; excerptOf: [string, string]; text: string; at: string }) =>
  `SELECT '${c.kind}' AS kind, ${c.title} AS title, ${c.projectKey} AS "projectKey", ${c.ticketKey}::text AS "ticketKey",
     ${c.documentId}::uuid AS "documentId", ${excerpt(...c.excerptOf)} AS excerpt,
     ts_rank(to_tsvector(${CONFIG}, ${c.text}), q.query) AS rank, ${c.at} AS at`;

/**
 * One SELECT per kind, with what each finds. They read the query as `q.query`, the readable
 * Project ids as $2 and whether the Workspace outside any Project is readable as $3.
 */
const SELECTS: { kind: SearchKind; sql: string }[] = [
  {
    kind: "ticket",
    sql: `${columns({ kind: "ticket", title: "t.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), documentId: "NULL", excerptOf: ["t.title", "t.description"], text: TICKET_TEXT, at: "t.updated_at" })}
      FROM q, tickets t JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY($2::uuid[]) AND to_tsvector(${CONFIG}, ${TICKET_TEXT}) @@ q.query`,
  },
  {
    kind: "document",
    sql: `${columns({ kind: "document", title: "d.title", projectKey: "p.key", ticketKey: "NULL", documentId: "d.id", excerptOf: ["d.title", "d.body"], text: DOCUMENT_TEXT, at: "d.updated_at" })}
      FROM q, documents d LEFT JOIN projects p ON p.id = d.project_id
      WHERE d.ticket_id IS NULL AND (d.project_id = ANY($2::uuid[]) OR (d.project_id IS NULL AND $3))
        AND to_tsvector(${CONFIG}, ${DOCUMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "report",
    sql: `${columns({ kind: "report", title: "d.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), documentId: "d.id", excerptOf: ["d.title", "d.body"], text: DOCUMENT_TEXT, at: "d.updated_at" })}
      FROM q, documents d JOIN tickets t ON t.id = d.ticket_id JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY($2::uuid[]) AND to_tsvector(${CONFIG}, ${DOCUMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "comment",
    sql: `${columns({ kind: "comment", title: "t.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), documentId: "NULL", excerptOf: ["''", "c.body"], text: COMMENT_TEXT, at: "c.at" })}
      FROM q, comments c JOIN tickets t ON t.id = c.ticket_id JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY($2::uuid[]) AND to_tsvector(${CONFIG}, ${COMMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "comment",
    sql: `${columns({ kind: "comment", title: "d.title", projectKey: "p.key", ticketKey: "NULL", documentId: "d.id", excerptOf: ["''", "c.body"], text: COMMENT_TEXT, at: "c.at" })}
      FROM q, comments c JOIN documents d ON d.id = c.document_id LEFT JOIN projects p ON p.id = d.project_id
      WHERE (d.project_id = ANY($2::uuid[]) OR (d.project_id IS NULL AND $3)) AND to_tsvector(${CONFIG}, ${COMMENT_TEXT}) @@ q.query`,
  },
];

/**
 * What `query` (as a person would type it into a search box: words, "quoted phrases", -excluded)
 * finds among what `actor` may read, best match first.
 */
export async function search(
  db: Queryable,
  actor: Actor,
  input: { query: string; limit: number; kinds?: readonly SearchKind[] | undefined; projectIds?: string[] | undefined },
): Promise<SearchResult[]> {
  const readable = await readablePlaces(db, actor);
  // Narrowed to Projects, the search leaves out the Workspace outside them; the caller checked it can read them.
  const places: Readable = input.projectIds
    ? { projectIds: readable.projectIds.filter((id) => input.projectIds!.includes(id)), workspace: false }
    : readable;
  const selects = SELECTS.filter((s) => !input.kinds || input.kinds.includes(s.kind)).map((s) => s.sql);
  const { rows } = await db.query<SearchResult & { rank: number }>(
    `WITH q AS (SELECT websearch_to_tsquery(${CONFIG}, $1) AS query)
     SELECT * FROM (${selects.join("\n UNION ALL ")}) found
     ORDER BY rank DESC, at DESC
     LIMIT $4`,
    [input.query, places.projectIds, places.workspace, input.limit],
  );
  return rows.map(({ kind, title, excerpt, projectKey, ticketKey, documentId }) => ({ kind, title, excerpt, projectKey, ticketKey, documentId }));
}
