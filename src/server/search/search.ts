import type { Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { placeReadableSql, readablePlaces, type Readable } from "../identity/access.js";
import { decisionKeySql } from "../knowledge/decisions.js";
import { ticketKeySql } from "../work/tickets.js";
import { documentProtectedSql } from "../knowledge/protection.js";
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
  /** The Ticket's, Document's, Artifact's, Decision's or Transcript's title, or the Term's name; for a Comment, of what it is on. */
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
  /** A Comment's Artifact; null for every other kind. */
  artifactId: string | null;
  transcriptId: string | null;
  /** The Transcript's turn that matches best (see shared/transcript-turns.ts); null for every other kind. */
  turn: number | null;
  /**
   * Whether Agents may read but not change it: for a Document or Report, it (or, for a Document, one above it)
   * is marked Protected; for a Term or Decision, it is marked. Null for a Ticket, Comment or Transcript.
   */
  protected: boolean | null;
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

/**
 * The fields of a result that some kinds leave null, in `SearchResult`'s order, each with the SQL type its column is cast to.
 * Every kind's SELECT gives them all, so the SELECTs line up in the UNION; a kind names only those it sets.
 */
const NULLABLE_FIELDS = {
  projectKey: "text",
  ticketKey: "text",
  documentId: "uuid",
  termId: "uuid",
  decisionKey: "text",
  artifactId: "uuid",
  transcriptId: "uuid",
  turn: "integer",
  protected: "boolean",
} as const satisfies Record<Exclude<keyof SearchResult, "kind" | "title" | "excerpt">, string>;

type NullableField = keyof typeof NULLABLE_FIELDS;

/** A result with none of its nullable fields set, for a kind to set its own over. */
const EMPTY_RESULT = Object.fromEntries(Object.keys(NULLABLE_FIELDS).map((field) => [field, null])) as Record<NullableField, null>;

/**
 * The columns every kind's SELECT gives, in order: a result's fields, its rank, and when it last changed.
 * Of the nullable fields, a kind passes SQL for those it sets (`protected`: whether it is Protected); the rest are NULL.
 */
const columns = (
  c: {
    kind: SearchKind;
    title: string;
    /** Every kind found here can be in a Project, so each names its key (NULL outside any). */
    projectKey: string;
    excerptOf: [string, string];
    text: string;
    at: string;
    /** SQL added to the rank, to put some results first. */
    boost?: string;
  } & Partial<Record<NullableField, string>>,
) =>
  `SELECT '${c.kind}' AS kind, ${c.title} AS title, ${excerpt(...c.excerptOf)} AS excerpt,
     ${Object.entries(NULLABLE_FIELDS).map(([field, type]) => `${c[field as NullableField] ?? "NULL"}::${type} AS "${field}"`).join(", ")},
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
    sql: `${columns({ kind: "ticket", title: "t.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), excerptOf: ["t.title", "t.description"], text: TICKET_TEXT, at: "t.updated_at", boost: keyBoost(TICKET_KEY) })}
      FROM q, tickets t JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY(q.projects) AND (to_tsvector(${CONFIG}, ${TICKET_TEXT}) @@ q.query OR ${keyMatches(TICKET_KEY)})`,
  },
  {
    kind: "document",
    sql: `${columns({ kind: "document", title: "d.title", projectKey: "p.key", documentId: "d.id", protected: documentProtectedSql("d"), excerptOf: ["d.title", "d.body"], text: DOCUMENT_TEXT, at: "d.updated_at" })}
      FROM q, documents d LEFT JOIN projects p ON p.id = d.project_id
      WHERE d.ticket_id IS NULL AND ${placeReadableSql("d", "q.projects", "q.workspace_id")}
        AND to_tsvector(${CONFIG}, ${DOCUMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "report",
    sql: `${columns({ kind: "report", title: "d.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), documentId: "d.id", protected: documentProtectedSql("d"), excerptOf: ["d.title", "d.body"], text: DOCUMENT_TEXT, at: "d.updated_at" })}
      FROM q, documents d JOIN tickets t ON t.id = d.ticket_id JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY(q.projects) AND to_tsvector(${CONFIG}, ${DOCUMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "comment",
    sql: `${columns({ kind: "comment", title: "t.title", projectKey: "p.key", ticketKey: ticketKeySql("p", "t"), excerptOf: ["''", "c.body"], text: COMMENT_TEXT, at: "c.at" })}
      FROM q, comments c JOIN tickets t ON t.id = c.ticket_id JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = ANY(q.projects) AND to_tsvector(${CONFIG}, ${COMMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "comment",
    sql: `${columns({ kind: "comment", title: "d.title", projectKey: "p.key", documentId: "d.id", excerptOf: ["''", "c.body"], text: COMMENT_TEXT, at: "c.at" })}
      FROM q, comments c JOIN documents d ON d.id = c.document_id LEFT JOIN projects p ON p.id = d.project_id
      WHERE ${placeReadableSql("d", "q.projects", "q.workspace_id")} AND to_tsvector(${CONFIG}, ${COMMENT_TEXT}) @@ q.query`,
  },
  {
    // An Artifact lies in a Project, or in the Workspace outside any.
    kind: "comment",
    sql: `${columns({ kind: "comment", title: "a.title", projectKey: "p.key", artifactId: "a.id", excerptOf: ["''", "c.body"], text: COMMENT_TEXT, at: "c.at" })}
      FROM q, comments c JOIN artifacts a ON a.id = c.artifact_id LEFT JOIN projects p ON p.id = a.project_id
      WHERE ${placeReadableSql("a", "q.projects", "q.workspace_id")} AND to_tsvector(${CONFIG}, ${COMMENT_TEXT}) @@ q.query`,
  },
  {
    kind: "term",
    sql: `${columns({ kind: "term", title: "tm.name", projectKey: "p.key", termId: "tm.id", protected: "tm.protected", excerptOf: ["tm.name", "tm.definition"], text: TERM_TEXT, at: "tm.updated_at" })}
      FROM q, terms tm LEFT JOIN projects p ON p.id = tm.project_id
      WHERE ${placeReadableSql("tm", "q.projects", "q.workspace_id")} AND to_tsvector(${CONFIG}, ${TERM_TEXT}) @@ q.query`,
  },
  {
    kind: "decision",
    sql: `${columns({ kind: "decision", title: "dc.title", projectKey: "p.key", decisionKey: DECISION_KEY, protected: "dc.protected", excerptOf: ["dc.title", "dc.body"], text: DECISION_TEXT, at: "dc.updated_at", boost: keyBoost(DECISION_KEY) })}
      FROM q, decisions dc LEFT JOIN projects p ON p.id = dc.project_id
      WHERE ${placeReadableSql("dc", "q.projects", "q.workspace_id")} AND (to_tsvector(${CONFIG}, ${DECISION_TEXT}) @@ q.query OR ${keyMatches(DECISION_KEY)})`,
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
    const { rows } = await db.query<SearchResult & { rank: number; at: Date }>(
      `WITH q AS (SELECT websearch_to_tsquery(${CONFIG}, $1) AS query, $2::uuid[] AS projects, $3::uuid AS workspace_id, upper(trim($1)) AS key)
       SELECT * FROM (${selects.join("\n UNION ALL ")}) found
       ORDER BY rank DESC, at DESC
       LIMIT $4`,
      [input.query, places.projectIds, places.workspaceId, input.limit],
    );
    for (const { rank, at, ...result } of rows) results.push(result);
  }
  // Transcripts are a separate kind, ranked below everything else: they fill what the limit leaves.
  if (!input.kinds || input.kinds.includes("transcript")) {
    const hits = await searchTranscripts(db, actor, { query: input.query, limit: input.limit - results.length, projectIds: input.projectIds && places.projectIds });
    for (const { title, excerpt, transcriptId, turn } of hits) results.push({ ...EMPTY_RESULT, kind: "transcript", title, excerpt, transcriptId, turn });
  }
  return results;
}
