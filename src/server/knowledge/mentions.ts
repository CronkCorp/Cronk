import { fromMarkdown } from "mdast-util-from-markdown";
import type { Queryable } from "../db/database.js";
import { documentReadableSql, type Readable } from "../identity/access.js";
import { replaceReferenceText } from "../../shared/ticket-references.js";
import { DECISION_REFERENCE, normalName, termPattern } from "../../shared/knowledge-references.js";
import type { MentionKind } from "../../shared/values.js";
import { ticketKeySql } from "../work/tickets.js";
import { decisionKeySql } from "./decisions.js";

/**
 * What mentions each Decision and Term: the Tickets, Documents, Comments, Terms and Decisions whose
 * text names a Decision's key or a Term's name, as the web client links them. Recorded whenever that
 * text changes, so a Decision or Term finds what mentions it through an index instead of reading
 * everything. Decision keys are kept as written, so a mention counts once a Decision with that key exists.
 */

/** Something whose text may mention Decisions and Terms. */
export interface MentionSource {
  kind: MentionKind;
  id: string;
}

/** The column of the `mentions` table naming a source of each kind. */
const SOURCE_COLUMN: Record<MentionKind, string> = {
  ticket: "ticket_id",
  document: "document_id",
  comment: "comment_id",
  term: "term_id",
  decision: "decision_id",
};

/**
 * Every source's text with where it lies, as `s`: its kind, id, Workspace, Project (null for the
 * Workspace), a title read as plain text (empty for none) and a Markdown body.
 */
const SOURCES = `(
  SELECT 'ticket' AS kind, t.id, p.workspace_id, t.project_id, t.title, t.description AS body
  FROM tickets t JOIN projects p ON p.id = t.project_id
  UNION ALL
  SELECT 'document', d.id, d.workspace_id, d.project_id, d.title, d.body FROM documents d
  UNION ALL
  SELECT 'comment', c.id, coalesce(tp.workspace_id, d.workspace_id), coalesce(t.project_id, d.project_id), '', c.body
  FROM comments c LEFT JOIN tickets t ON t.id = c.ticket_id LEFT JOIN projects tp ON tp.id = t.project_id
    LEFT JOIN documents d ON d.id = c.document_id
  UNION ALL
  SELECT 'term', id, workspace_id, project_id, '', definition FROM terms
  UNION ALL
  SELECT 'decision', id, workspace_id, project_id, title, body FROM decisions
) s`;

interface SourceRow {
  kind: MentionKind;
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  body: string;
}

/** The runs of text Markdown `body` shows outside code and links, where references count. */
function proseTexts(body: string): string[] {
  const texts: string[] = [];
  replaceReferenceText(fromMarkdown(body), (text) => {
    texts.push(text);
    return [{ type: "text", value: text }];
  });
  return texts;
}

/** The Decision keys `texts` name, without repeats. */
const decisionKeysIn = (texts: string[]) => [...new Set(texts.flatMap((text) => [...text.matchAll(DECISION_REFERENCE)].map((m) => m[0])))];

/** The key of the Decision with this id, for leaving out its mentions of itself. */
async function ownDecisionKey(db: Queryable, id: string): Promise<string | undefined> {
  const { rows } = await db.query<{ key: string }>(
    `SELECT ${decisionKeySql("p", "d")} AS key FROM decisions d LEFT JOIN projects p ON p.id = d.project_id WHERE d.id = $1`,
    [id],
  );
  return rows[0]?.key;
}

/**
 * The Terms that apply where a source lies, by name as `normalName` gives it: in a Project its own,
 * and the Workspace's it has no Term of the same name for (ignoring case); in the Workspace, its own.
 */
async function applicableTerms(db: Queryable, workspaceId: string, projectId: string | null): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT t.id, t.name FROM terms t
     WHERE t.workspace_id = $1 AND (t.project_id = $2 OR (t.project_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM terms o WHERE o.workspace_id = $1 AND o.project_id = $2 AND lower(o.name) = lower(t.name))))`,
    [workspaceId, projectId],
  );
  return new Map(rows.map((r) => [normalName(r.name), r.id]));
}

/** The ids of the Terms of `terms` (by name) that `texts` name with their capitalisation as whole words, without repeats. */
function termIdsIn(texts: string[], terms: Map<string, string>): string[] {
  const pattern = termPattern([...terms.keys()]);
  if (!pattern) return [];
  return [...new Set(texts.flatMap((text) => [...text.matchAll(pattern)].map((m) => terms.get(normalName(m[0]))!)))];
}

/** Records what one source mentions now, from its text as stored, replacing what it mentioned before. A source never mentions itself. */
async function record(db: Queryable, source: SourceRow): Promise<void> {
  const column = SOURCE_COLUMN[source.kind];
  await db.query(`DELETE FROM mentions WHERE ${column} = $1`, [source.id]);
  const texts = [source.title, ...proseTexts(source.body)];
  const own = source.kind === "decision" ? await ownDecisionKey(db, source.id) : undefined;
  const keys = decisionKeysIn(texts).filter((k) => k !== own);
  await db.query(`INSERT INTO mentions (${column}, decision_key) SELECT $1, unnest($2::text[])`, [source.id, keys]);
  const termIds = termIdsIn(texts, await applicableTerms(db, source.workspace_id, source.project_id)).filter((id) => id !== source.id);
  await db.query(`INSERT INTO mentions (${column}, mentioned_term_id) SELECT $1, unnest($2::uuid[])`, [source.id, termIds]);
}

/**
 * Records what `source` mentions now, from its current text, replacing what it mentioned before.
 * Run in the transaction that creates or changes it.
 */
export async function recordMentions(db: Queryable, source: MentionSource): Promise<void> {
  const { rows } = await db.query<SourceRow>(`SELECT * FROM ${SOURCES} WHERE s.kind = $1 AND s.id = $2`, [source.kind, source.id]);
  if (rows[0]) await record(db, rows[0]);
}

/**
 * Records again what each source mentions whose text may name one of `names`, among those lying
 * where a Term of `place` applies (all the Workspace for a Workspace Term), as after a Term there
 * takes or gives up one of those names. Run in the transaction that changes the Term.
 */
export async function recordMentionsOfNames(db: Queryable, place: { workspaceId: string; projectId: string | null }, names: string[]): Promise<void> {
  // Any text naming one of them holds the longest run of letters and digits in its name, whatever the case, even
  // where Markdown escapes the punctuation around it.
  const words = names.map((name) => (name.match(/[\p{L}\p{N}]+/gu) ?? [name]).reduce((a, b) => (b.length > a.length ? b : a)).toLowerCase());
  const { rows } = await db.query<SourceRow>(
    `SELECT * FROM ${SOURCES}
     WHERE s.workspace_id = $1 AND ($2::uuid IS NULL OR s.project_id = $2)
       AND EXISTS (SELECT 1 FROM unnest($3::text[]) w WHERE strpos(lower(s.title || ' ' || s.body), w) > 0)
     ORDER BY s.kind, s.id`,
    [place.workspaceId, place.projectId, words],
  );
  for (const row of rows) await record(db, row);
}

/** How many sources a full recording reads at a time, so a large Workspace isn't held in memory at once. */
const BATCH = 200;

/**
 * Records what every source mentions, in the Workspace `workspaceId` (all Workspaces when null), as
 * for a database or an import that didn't record them yet. It parses as `recordMentions` does now: if
 * what counts as a mention changes, add a migration that runs it again.
 */
export async function recordAllMentions(db: Queryable, workspaceId: string | null = null): Promise<void> {
  for (let after = { kind: "", id: "00000000-0000-0000-0000-000000000000" }; ; ) {
    const { rows } = await db.query<SourceRow>(
      `SELECT * FROM ${SOURCES} WHERE ($1::uuid IS NULL OR s.workspace_id = $1) AND (s.kind, s.id) > ($2, $3::uuid)
       ORDER BY s.kind, s.id LIMIT $4`,
      [workspaceId, after.kind, after.id, BATCH],
    );
    for (const row of rows) await record(db, row);
    if (rows.length < BATCH) return;
    after = rows[rows.length - 1]!;
  }
}

/** Something that mentions a Decision or Term, as its page lists it. */
export interface Mention {
  kind: MentionKind;
  id: string;
  /** A Ticket's or Decision's key; null for the others. */
  key: string | null;
  /** Its title; a Term's name; for a Comment, the title of the Ticket or Document it is on. */
  title: string;
  /** Null when it lies in the Workspace outside any Project. */
  projectKey: string | null;
  /** For a Comment on a Ticket, or a Report: the Ticket's key. */
  ticketKey: string | null;
  /** For a Comment on a Document: the Document's id. */
  documentId: string | null;
  /** When it last changed; for a Comment, when it was posted. */
  at: Date;
}

/** How many mentions a Decision or Term lists. */
const MENTIONS_LIMIT = 50;

/**
 * What mentions a Decision (`decisionKey`) or a Term (`termId`), most recently changed first (at most
 * 50), leaving out what lies where `readable` doesn't let its reader read.
 */
export async function listMentions(db: Queryable, target: { decisionKey: string } | { termId: string }, readable: Readable): Promise<Mention[]> {
  const [condition, value] = "decisionKey" in target ? ["m.decision_key = $1", target.decisionKey] : ["m.mentioned_term_id = $1", target.termId];
  const { rows } = await db.query<Mention>(
    `WITH m AS (SELECT * FROM mentions m WHERE ${condition}),
     found AS (
       SELECT 'ticket' AS kind, t.id, ${ticketKeySql("p", "t")} AS key, t.title, p.key AS project_key, NULL AS ticket_key, NULL::uuid AS document_id,
              t.updated_at AS at, t.project_id, p.workspace_id
       FROM m JOIN tickets t ON t.id = m.ticket_id JOIN projects p ON p.id = t.project_id
       UNION ALL
       SELECT 'document', d.id, NULL, d.title, p.key, ${ticketKeySql("tp", "tt")}, NULL, d.updated_at, d.project_id, d.workspace_id
       FROM m JOIN documents d ON d.id = m.document_id LEFT JOIN projects p ON p.id = d.project_id
         LEFT JOIN tickets tt ON tt.id = d.ticket_id LEFT JOIN projects tp ON tp.id = tt.project_id
       UNION ALL
       SELECT 'comment', c.id, NULL, coalesce(t.title, d.title), coalesce(tp.key, dp.key), ${ticketKeySql("tp", "t")}, c.document_id, c.at,
              coalesce(t.project_id, d.project_id), coalesce(tp.workspace_id, d.workspace_id)
       FROM m JOIN comments c ON c.id = m.comment_id LEFT JOIN tickets t ON t.id = c.ticket_id LEFT JOIN projects tp ON tp.id = t.project_id
         LEFT JOIN documents d ON d.id = c.document_id LEFT JOIN projects dp ON dp.id = d.project_id
       UNION ALL
       SELECT 'term', tm.id, NULL, tm.name, p.key, NULL, NULL, tm.updated_at, tm.project_id, tm.workspace_id
       FROM m JOIN terms tm ON tm.id = m.term_id LEFT JOIN projects p ON p.id = tm.project_id
       UNION ALL
       SELECT 'decision', dc.id, ${decisionKeySql("p", "dc")}, dc.title, p.key, NULL, NULL,
              dc.updated_at, dc.project_id, dc.workspace_id
       FROM m JOIN decisions dc ON dc.id = m.decision_id LEFT JOIN projects p ON p.id = dc.project_id
     )
     SELECT kind, id, key, title, project_key AS "projectKey", ticket_key AS "ticketKey", document_id AS "documentId", at
     FROM found f WHERE ${documentReadableSql("f", "$2::uuid[]", "$3::uuid")}
     ORDER BY at DESC, id LIMIT ${MENTIONS_LIMIT}`,
    [value, readable.projectIds, readable.workspaceId],
  );
  return rows;
}
