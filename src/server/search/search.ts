import type { Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { documentReadableSql, readablePlaces, type Readable } from "../identity/access.js";
import { ticketKeySql } from "../work/tickets.js";
import type { SearchKind } from "../../shared/values.js";

/**
 * Full-text search over what an Actor may read, with Postgres's own text search (no extra
 * service). Each kind of thing is searched by the same expression its index is built on
 * (see migrations 0014 and 0037), so the indexes serve these queries.
 */

/** One thing a search found, with an excerpt of its text around the match. */
export interface SearchResult {
  kind: SearchKind;
  /** The Ticket's or Document's title, or the Term's name. */
  title: string;
  /** The text around the match, as written (Markdown), from the body (or the title when the body is empty). */
  excerpt: string;
  /** Null for something in the Workspace outside any Project. */
  projectKey: string | null;
  ticketKey: string | null;
  documentId: string | null;
  termId: string | null;
}

/** The text-search configuration everything is indexed and searched with. */
const CONFIG = "'english'";

/** Options for the excerpt: a short stretch around the match, without markers around the matching words. */
const EXCERPT = `'StartSel="", StopSel="", MinWords=10, MaxWords=30'`;

/** The searchable text of each kind, as its index is built on. */
const TICKET_TEXT = "t.title || ' ' || t.description";
const DOCUMENT_TEXT = "d.title || ' ' || d.body";
const COMMENT_TEXT = "c.body";
const TERM_TEXT = "term_search_text(tm.name, tm.definition, tm.avoid)";

/** The excerpt of `body` around the match, falling back to `title` when the body is empty. */
const excerpt = (title: string, body: string) => `ts_headline(${CONFIG}, CASE WHEN ${body} = '' THEN ${title} ELSE ${body} END, q.query, ${EXCERPT})`;

/** The columns every kind's SELECT gives, in order: a result's fields, its rank, and when it last changed. */
const columns = (c: {
  kind: SearchKind;
  title: string;
  projectKey: string;
  ticketKey: string;
  documentId: string;
  termId?: string;
  excerptOf: [string, string];
  text: string;
  at: string;
  /** SQL added to the rank, to put some results first. */
  boost?: string;
}) =>
  `SELECT '${c.kind}' AS kind, ${c.title} AS title, ${c.projectKey} AS "projectKey", ${c.ticketKey}::text AS "ticketKey",
     ${c.documentId}::uuid AS "documentId", ${c.termId ?? "NULL"}::uuid AS "termId", ${excerpt(...c.excerptOf)} AS excerpt,
     ts_rank(to_tsvector(${CONFIG}, ${c.text}), q.query) + ${c.boost ?? "0"} AS rank, ${c.at} AS at`;

/** Whether the Ticket aliased `t` in the Project aliased `p` has the key the search is for, typed in any case. */
const KEY_MATCHES = `upper(${ticketKeySql("p", "t")}) = q.key`;

/**
 * One SELECT per kind, with what each finds. They read the query as `q.query` (and as a Ticket key, upper-cased, as `q.key`), the readable
 * Project ids as `q.projects` and the Workspace's id, when it is readable outside any Project, as `q.workspace_id`.
 */
const SELECTS: { kind: SearchKind; sql: string }[] = [
  {
    kind: "ticket",
    sql: `${columns({ kind: "ticket", title: "t.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), documentId: "NULL", excerptOf: ["t.title", "t.description"], text: TICKET_TEXT, at: "t.updated_at", boost: `CASE WHEN ${KEY_MATCHES} THEN 1000 ELSE 0 END` })}
      FROM q, tickets t JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY(q.projects) AND (to_tsvector(${CONFIG}, ${TICKET_TEXT}) @@ q.query OR ${KEY_MATCHES})`,
  },
  {
    kind: "document",
    sql: `${columns({ kind: "document", title: "d.title", projectKey: "p.key", ticketKey: "NULL", documentId: "d.id", excerptOf: ["d.title", "d.body"], text: DOCUMENT_TEXT, at: "d.updated_at" })}
      FROM q, documents d LEFT JOIN projects p ON p.id = d.project_id
      WHERE d.ticket_id IS NULL AND ${documentReadableSql("d", "q.projects", "q.workspace_id")}
        AND to_tsvector(${CONFIG}, ${DOCUMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "report",
    sql: `${columns({ kind: "report", title: "d.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), documentId: "d.id", excerptOf: ["d.title", "d.body"], text: DOCUMENT_TEXT, at: "d.updated_at" })}
      FROM q, documents d JOIN tickets t ON t.id = d.ticket_id JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY(q.projects) AND to_tsvector(${CONFIG}, ${DOCUMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "comment",
    sql: `${columns({ kind: "comment", title: "t.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), documentId: "NULL", excerptOf: ["''", "c.body"], text: COMMENT_TEXT, at: "c.at" })}
      FROM q, comments c JOIN tickets t ON t.id = c.ticket_id JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY(q.projects) AND to_tsvector(${CONFIG}, ${COMMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "comment",
    sql: `${columns({ kind: "comment", title: "d.title", projectKey: "p.key", ticketKey: "NULL", documentId: "d.id", excerptOf: ["''", "c.body"], text: COMMENT_TEXT, at: "c.at" })}
      FROM q, comments c JOIN documents d ON d.id = c.document_id LEFT JOIN projects p ON p.id = d.project_id
      WHERE ${documentReadableSql("d", "q.projects", "q.workspace_id")} AND to_tsvector(${CONFIG}, ${COMMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "term",
    sql: `${columns({ kind: "term", title: "tm.name", projectKey: "p.key", ticketKey: "NULL", documentId: "NULL", termId: "tm.id", excerptOf: ["tm.name", "tm.definition"], text: TERM_TEXT, at: "tm.updated_at" })}
      FROM q, terms tm LEFT JOIN projects p ON p.id = tm.project_id
      WHERE ${documentReadableSql("tm", "q.projects", "q.workspace_id")} AND to_tsvector(${CONFIG}, ${TERM_TEXT}) @@ q.query`,
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
    ? { projectIds: readable.projectIds.filter((id) => input.projectIds!.includes(id)), workspaceId: null }
    : readable;
  const selects = SELECTS.filter((s) => !input.kinds || input.kinds.includes(s.kind)).map((s) => s.sql);
  const { rows } = await db.query<SearchResult & { rank: number }>(
    `WITH q AS (SELECT websearch_to_tsquery(${CONFIG}, $1) AS query, $2::uuid[] AS projects, $3::uuid AS workspace_id, upper(trim($1)) AS key)
     SELECT * FROM (${selects.join("\n UNION ALL ")}) found
     ORDER BY rank DESC, at DESC
     LIMIT $4`,
    [input.query, places.projectIds, places.workspaceId, input.limit],
  );
  return rows.map(({ kind, title, excerpt, projectKey, ticketKey, documentId, termId }) => ({ kind, title, excerpt, projectKey, ticketKey, documentId, termId }));
}
