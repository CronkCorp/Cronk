import type { Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { documentReadableSql, readablePlaces, type Readable } from "../identity/access.js";
import { decisionKeySql } from "../knowledge/decisions.js";
import { ticketKeySql } from "../work/tickets.js";
import type { SearchKind } from "../../shared/values.js";
import { searchTranscripts } from "../transcripts/search.js";

/**
 * Full-text search over what an Actor may read, with Postgres's own text search (no extra
 * service). Each kind of thing is searched by the same expression its index is built on
 * (see migrations 0014, 0037 and 0040), so the indexes serve these queries.
 */

/** One thing a search found, with an excerpt of its text around the match. */
export interface SearchResult {
  kind: SearchKind;
  /** The Ticket's, Document's, Decision's or Transcript's title, or the Term's name. */
  title: string;
  /** The text around the match, as written (Markdown), from the body (or the title when the body is empty). */
  excerpt: string;
  /** Null for something in the Workspace outside any Project. */
  projectKey: string | null;
  ticketKey: string | null;
  documentId: string | null;
  termId: string | null;
  /** The Decision, by its key: `CRONK-D7`, or `D7` in the Workspace. */
  decisionKey: string | null;
  transcriptId: string | null;
  /** The Transcript's turn that matches best (see transcripts/turns.ts); null for every other kind. */
  turn: number | null;
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
const DECISION_TEXT = "dc.title || ' ' || dc.body";

/** The excerpt of `body` around the match, falling back to `title` when the body is empty. */
const excerpt = (title: string, body: string) => `ts_headline(${CONFIG}, CASE WHEN ${body} = '' THEN ${title} ELSE ${body} END, q.query, ${EXCERPT})`;

/** The columns every kind's SELECT gives, in order: a result's fields, its rank, and when it last changed. */
const columns = (c: {
  kind: SearchKind;
  title: string;
  projectKey: string;
  ticketKey: string;
  documentId: string;
  termId: string;
  decisionKey: string;
  excerptOf: [string, string];
  text: string;
  at: string;
  /** SQL added to the rank, to put some results first. */
  boost?: string;
}) =>
  `SELECT '${c.kind}' AS kind, ${c.title} AS title, ${c.projectKey} AS "projectKey", ${c.ticketKey}::text AS "ticketKey",
     ${c.documentId}::uuid AS "documentId", ${c.termId}::uuid AS "termId", ${c.decisionKey}::text AS "decisionKey",
     ${excerpt(...c.excerptOf)} AS excerpt,
     ts_rank(to_tsvector(${CONFIG}, ${c.text}), q.query) + ${c.boost ?? "0"} AS rank, ${c.at} AS at`;

/** Whether the key `keySql` gives is the one the search is for, typed in any case. */
const keyMatches = (keySql: string) => `upper(${keySql}) = q.key`;

/** What puts a result whose key the search typed first, above any match on its text. */
const keyBoost = (keySql: string) => `CASE WHEN ${keyMatches(keySql)} THEN 1000 ELSE 0 END`;

/** The keys of the Ticket aliased `t` and of the Decision aliased `dc`, each with its Project (if any) aliased `p`. */
const TICKET_KEY = ticketKeySql("p", "t");
const DECISION_KEY = decisionKeySql("p", "dc");

/**
 * One SELECT per kind, with what each finds. They read the query as `q.query` (and as a Ticket or Decision key, upper-cased, as `q.key`), the readable
 * Project ids as `q.projects` and the Workspace's id, when it is readable outside any Project, as `q.workspace_id`.
 */
const SELECTS: { kind: SearchKind; sql: string }[] = [
  {
    kind: "ticket",
    sql: `${columns({ kind: "ticket", title: "t.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), documentId: "NULL", termId: "NULL", decisionKey: "NULL", excerptOf: ["t.title", "t.description"], text: TICKET_TEXT, at: "t.updated_at", boost: keyBoost(TICKET_KEY) })}
      FROM q, tickets t JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY(q.projects) AND (to_tsvector(${CONFIG}, ${TICKET_TEXT}) @@ q.query OR ${keyMatches(TICKET_KEY)})`,
  },
  {
    kind: "document",
    sql: `${columns({ kind: "document", title: "d.title", projectKey: "p.key", ticketKey: "NULL", documentId: "d.id", termId: "NULL", decisionKey: "NULL", excerptOf: ["d.title", "d.body"], text: DOCUMENT_TEXT, at: "d.updated_at" })}
      FROM q, documents d LEFT JOIN projects p ON p.id = d.project_id
      WHERE d.ticket_id IS NULL AND ${documentReadableSql("d", "q.projects", "q.workspace_id")}
        AND to_tsvector(${CONFIG}, ${DOCUMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "report",
    sql: `${columns({ kind: "report", title: "d.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), documentId: "d.id", termId: "NULL", decisionKey: "NULL", excerptOf: ["d.title", "d.body"], text: DOCUMENT_TEXT, at: "d.updated_at" })}
      FROM q, documents d JOIN tickets t ON t.id = d.ticket_id JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY(q.projects) AND to_tsvector(${CONFIG}, ${DOCUMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "comment",
    sql: `${columns({ kind: "comment", title: "t.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), documentId: "NULL", termId: "NULL", decisionKey: "NULL", excerptOf: ["''", "c.body"], text: COMMENT_TEXT, at: "c.at" })}
      FROM q, comments c JOIN tickets t ON t.id = c.ticket_id JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY(q.projects) AND to_tsvector(${CONFIG}, ${COMMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "comment",
    sql: `${columns({ kind: "comment", title: "d.title", projectKey: "p.key", ticketKey: "NULL", documentId: "d.id", termId: "NULL", decisionKey: "NULL", excerptOf: ["''", "c.body"], text: COMMENT_TEXT, at: "c.at" })}
      FROM q, comments c JOIN documents d ON d.id = c.document_id LEFT JOIN projects p ON p.id = d.project_id
      WHERE ${documentReadableSql("d", "q.projects", "q.workspace_id")} AND to_tsvector(${CONFIG}, ${COMMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "term",
    sql: `${columns({ kind: "term", title: "tm.name", projectKey: "p.key", ticketKey: "NULL", documentId: "NULL", termId: "tm.id", decisionKey: "NULL", excerptOf: ["tm.name", "tm.definition"], text: TERM_TEXT, at: "tm.updated_at" })}
      FROM q, terms tm LEFT JOIN projects p ON p.id = tm.project_id
      WHERE ${documentReadableSql("tm", "q.projects", "q.workspace_id")} AND to_tsvector(${CONFIG}, ${TERM_TEXT}) @@ q.query`,
  },
  {
    kind: "decision",
    sql: `${columns({ kind: "decision", title: "dc.title", projectKey: "p.key", ticketKey: "NULL", documentId: "NULL", termId: "NULL", decisionKey: DECISION_KEY, excerptOf: ["dc.title", "dc.body"], text: DECISION_TEXT, at: "dc.updated_at", boost: keyBoost(DECISION_KEY) })}
      FROM q, decisions dc LEFT JOIN projects p ON p.id = dc.project_id
      WHERE ${documentReadableSql("dc", "q.projects", "q.workspace_id")} AND (to_tsvector(${CONFIG}, ${DECISION_TEXT}) @@ q.query OR ${keyMatches(DECISION_KEY)})`,
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
  const results: SearchResult[] = [];
  if (selects.length > 0) {
    const { rows } = await db.query<SearchResult & { rank: number }>(
      `WITH q AS (SELECT websearch_to_tsquery(${CONFIG}, $1) AS query, $2::uuid[] AS projects, $3::uuid AS workspace_id, upper(trim($1)) AS key)
       SELECT * FROM (${selects.join("\n UNION ALL ")}) found
       ORDER BY rank DESC, at DESC
       LIMIT $4`,
      [input.query, places.projectIds, places.workspaceId, input.limit],
    );
    for (const { kind, title, excerpt, projectKey, ticketKey, documentId, termId, decisionKey } of rows) {
      results.push({ kind, title, excerpt, projectKey, ticketKey, documentId, termId, decisionKey, transcriptId: null, turn: null });
    }
  }
  // Transcripts are a separate kind, ranked below everything else: they fill what the limit leaves.
  if (!input.kinds || input.kinds.includes("transcript")) {
    const hits = await searchTranscripts(db, actor, { query: input.query, limit: input.limit - results.length, projectIds: input.projectIds && places.projectIds });
    for (const hit of hits) {
      results.push({
        kind: "transcript",
        title: hit.title,
        excerpt: hit.excerpt,
        projectKey: null,
        ticketKey: null,
        documentId: null,
        termId: null,
        decisionKey: null,
        transcriptId: hit.transcriptId,
        turn: hit.turn,
      });
    }
  }
  return results;
}
