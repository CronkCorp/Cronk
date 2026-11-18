import { fromMarkdown } from "mdast-util-from-markdown";
import { queryParams, type QueryParams, type Queryable } from "../db/database.js";
import { readableClause, type Readable } from "../identity/access.js";
import { replaceReferenceText, TICKET_REFERENCE } from "../../shared/ticket-references.js";
import { DECISION_REFERENCE, normalName, termPattern } from "../../shared/knowledge-references.js";
import type { MentionKind } from "../../shared/values.js";
import { ticketKeySql } from "../work/tickets.js";
import { decisionKeySql } from "./decisions.js";
import { documentProtectedSql } from "./protection.js";

/**
 * What mentions each Ticket, Decision and Term: the Tickets, Documents, Comments, Terms, Decisions and
 * Activities whose text names a Ticket's or Decision's key or a Term's name, as the web client links them.
 * Recorded whenever that text changes, so a Ticket, Decision or Term finds what mentions it through an
 * index instead of reading everything. Keys are kept as written, so a mention counts once a Ticket or
 * Decision with that key exists.
 */

/** Something whose text may mention Tickets, Decisions and Terms. */
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
  activity: "activity_id",
};

/**
 * Every source's text with where it lies, as `s`: its kind, id, Workspace, Project (null for the
 * Workspace), a title read as plain text (empty for none) and a Markdown body. An Activity lies where its Ticket does.
 */
const SOURCES = `(
  SELECT 'ticket' AS kind, t.id, p.workspace_id, t.project_id, t.title, t.description AS body
  FROM tickets t JOIN projects p ON p.id = t.project_id
  UNION ALL
  SELECT 'document', d.id, d.workspace_id, d.project_id, d.title, d.body FROM documents d
  UNION ALL
  SELECT 'comment', c.id, coalesce(tp.workspace_id, d.workspace_id, x.workspace_id), coalesce(t.project_id, d.project_id, x.project_id), '', c.body
  FROM comments c LEFT JOIN tickets t ON t.id = c.ticket_id LEFT JOIN projects tp ON tp.id = t.project_id
    LEFT JOIN documents d ON d.id = c.document_id LEFT JOIN artifacts x ON x.id = c.artifact_id
  UNION ALL
  SELECT 'term', id, workspace_id, project_id, '', definition FROM terms
  UNION ALL
  SELECT 'decision', id, workspace_id, project_id, title, body FROM decisions
  UNION ALL
  SELECT 'activity', a.id, p.workspace_id, t.project_id, '', a.body
  FROM activities a JOIN tickets t ON t.id = a.ticket_id JOIN projects p ON p.id = t.project_id
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

/** The keys `pattern` finds in `texts`, without repeats. */
const keysIn = (texts: string[], pattern: RegExp) => [...new Set(texts.flatMap((text) => [...text.matchAll(pattern)].map((m) => m[0])))];

/** The key of the Ticket with this id, for leaving out its mentions of itself. */
async function ownTicketKey(db: Queryable, id: string): Promise<string | undefined> {
  const { rows } = await db.query<{ key: string }>(`SELECT ${ticketKeySql("p", "t")} AS key FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [id]);
  return rows[0]?.key;
}

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
  const ownTicket = source.kind === "ticket" ? await ownTicketKey(db, source.id) : undefined;
  const ownDecision = source.kind === "decision" ? await ownDecisionKey(db, source.id) : undefined;
  const terms = await applicableTerms(db, source.workspace_id, source.project_id);
  const targets: [target: string, type: string, values: string[]][] = [
    ["ticket_key", "text", keysIn(texts, TICKET_REFERENCE).filter((k) => k !== ownTicket)],
    ["decision_key", "text", keysIn(texts, DECISION_REFERENCE).filter((k) => k !== ownDecision)],
    ["mentioned_term_id", "uuid", termIdsIn(texts, terms).filter((id) => id !== source.id)],
  ];
  for (const [target, type, values] of targets) {
    await db.query(`INSERT INTO mentions (${column}, ${target}) SELECT $1, unnest($2::${type}[])`, [source.id, values]);
  }
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
 * for a database or an import that didn't record them yet. It parses as `recordMentions` does now, and
 * reads the schema as it is now: if what counts as a mention changes, add a migration that runs it again.
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

/** Something that mentions a Ticket, Decision or Term, as its page lists it. */
export interface Mention {
  kind: MentionKind;
  id: string;
  /** A Ticket's or Decision's key; null for the others. */
  key: string | null;
  /** Its title; a Term's name; for a Comment, the title of the Ticket, Document or Artifact it is on; for an Activity, its Ticket's. */
  title: string;
  /** Null when it lies in the Workspace outside any Project. */
  projectKey: string | null;
  /** For a Comment on a Ticket, an Activity, or a Report: the Ticket's key. */
  ticketKey: string | null;
  /** For a Comment on a Document: the Document's id. */
  documentId: string | null;
  /** For a Comment on an Artifact: the Artifact's id. */
  artifactId: string | null;
  /** When it last changed; for a Comment or Activity, when it was posted. */
  at: Date;
  /**
   * Whether Agents may read but not change it: for a Document, it (or one above it in its page tree) is
   * marked Protected; for a Term or Decision, it is marked. Null for a Ticket, Comment or Activity.
   */
  protected: boolean | null;
}

/** How many mentions a Ticket, Decision or Term lists. */
const MENTIONS_LIMIT = 50;

/** What a mentions list is for: a Decision by key, a Term by id, or a Ticket by key along with its id. */
export type MentionTarget = { decisionKey: string } | { termId: string } | { ticketKey: string; ticketId: string };

/**
 * The condition picking `target`'s rows of `mentions m`, its values bound to `params`. A Ticket's
 * own Comments, Activities and Reports and the Documents linked to it are left out, as the Ticket shows them already.
 */
function mentionsOf(target: MentionTarget, params: QueryParams): string {
  if ("decisionKey" in target) return `m.decision_key = ${params.bind(target.decisionKey, "text")}`;
  if ("termId" in target) return `m.mentioned_term_id = ${params.bind(target.termId, "uuid")}`;
  const ticketId = params.bind(target.ticketId, "uuid");
  return `m.ticket_key = ${params.bind(target.ticketKey, "text")}
     AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.id = m.comment_id AND c.ticket_id = ${ticketId})
     AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.id = m.activity_id AND a.ticket_id = ${ticketId})
     AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = m.document_id AND d.ticket_id = ${ticketId})
     AND NOT EXISTS (SELECT 1 FROM ticket_document_links l WHERE l.document_id = m.document_id AND l.ticket_id = ${ticketId})`;
}

/**
 * Each source of the mentions in the CTE `m`, with its kind, id, key, title, Project key, Ticket key, Document id,
 * Artifact id, when it last changed, whether it is Protected, its Project and Workspace, and the Term it mentions (if any).
 */
const FOUND_SQL = `
       SELECT 'ticket' AS kind, t.id, ${ticketKeySql("p", "t")} AS key, t.title, p.key AS project_key, NULL AS ticket_key, NULL::uuid AS document_id,
              NULL::uuid AS artifact_id, t.updated_at AS at, NULL::boolean AS protected, t.project_id, p.workspace_id, m.mentioned_term_id
       FROM m JOIN tickets t ON t.id = m.ticket_id JOIN projects p ON p.id = t.project_id
       UNION ALL
       SELECT 'document', d.id, NULL, d.title, p.key, ${ticketKeySql("tp", "tt")}, NULL, NULL, d.updated_at, ${documentProtectedSql("d")}, d.project_id, d.workspace_id, m.mentioned_term_id
       FROM m JOIN documents d ON d.id = m.document_id LEFT JOIN projects p ON p.id = d.project_id
         LEFT JOIN tickets tt ON tt.id = d.ticket_id LEFT JOIN projects tp ON tp.id = tt.project_id
       UNION ALL
       SELECT 'comment', c.id, NULL, coalesce(t.title, d.title, x.title), coalesce(tp.key, dp.key, xp.key), ${ticketKeySql("tp", "t")}, c.document_id,
              c.artifact_id, c.at, NULL, coalesce(t.project_id, d.project_id, x.project_id), coalesce(tp.workspace_id, d.workspace_id, x.workspace_id), m.mentioned_term_id
       FROM m JOIN comments c ON c.id = m.comment_id LEFT JOIN tickets t ON t.id = c.ticket_id LEFT JOIN projects tp ON tp.id = t.project_id
         LEFT JOIN documents d ON d.id = c.document_id LEFT JOIN projects dp ON dp.id = d.project_id
         LEFT JOIN artifacts x ON x.id = c.artifact_id LEFT JOIN projects xp ON xp.id = x.project_id
       UNION ALL
       SELECT 'term', tm.id, NULL, tm.name, p.key, NULL, NULL, NULL, tm.updated_at, tm.protected, tm.project_id, tm.workspace_id, m.mentioned_term_id
       FROM m JOIN terms tm ON tm.id = m.term_id LEFT JOIN projects p ON p.id = tm.project_id
       UNION ALL
       SELECT 'decision', dc.id, ${decisionKeySql("p", "dc")}, dc.title, p.key, NULL, NULL, NULL,
              dc.updated_at, dc.protected, dc.project_id, dc.workspace_id, m.mentioned_term_id
       FROM m JOIN decisions dc ON dc.id = m.decision_id LEFT JOIN projects p ON p.id = dc.project_id
       UNION ALL
       SELECT 'activity', a.id, NULL, t.title, p.key, ${ticketKeySql("p", "t")}, NULL, NULL, a.at, NULL, t.project_id, p.workspace_id, m.mentioned_term_id
       FROM m JOIN activities a ON a.id = m.activity_id JOIN tickets t ON t.id = a.ticket_id JOIN projects p ON p.id = t.project_id`;

/**
 * What mentions a Ticket, a Decision or a Term, most recently changed first (at most 50), leaving out what
 * lies where `readable` doesn't let its reader read.
 */
export async function listMentions(db: Queryable, target: MentionTarget, readable: Readable): Promise<Mention[]> {
  const params = queryParams();
  const { rows } = await db.query<Mention>(
    `WITH m AS (SELECT * FROM mentions m WHERE ${mentionsOf(target, params)}),
     found AS (
${FOUND_SQL}
     )
     SELECT kind, id, key, title, project_key AS "projectKey", ticket_key AS "ticketKey", document_id AS "documentId", artifact_id AS "artifactId", at, protected
     FROM found f WHERE ${readableClause("f", readable, params)}
     ORDER BY at DESC, id LIMIT ${MENTIONS_LIMIT}`,
    params.values,
  );
  return rows;
}

/**
 * How many things mention each of these Terms, by id, leaving out what lies where `readable` doesn't let its reader read;
 * unlike `listMentions`, every one is counted. Terms nothing readable mentions are left out.
 */
export async function countTermMentions(db: Queryable, termIds: string[], readable: Readable): Promise<Map<string, number>> {
  const params = queryParams();
  const { rows } = await db.query<{ term_id: string; n: number }>(
    `WITH m AS (SELECT * FROM mentions m WHERE m.mentioned_term_id = ANY(${params.bind(termIds, "uuid[]")})),
     found AS (${FOUND_SQL})
     SELECT mentioned_term_id AS term_id, count(*)::int AS n
     FROM found f WHERE ${readableClause("f", readable, params)}
     GROUP BY mentioned_term_id`,
    params.values,
  );
  return new Map(rows.map((r) => [r.term_id, r.n]));
}
