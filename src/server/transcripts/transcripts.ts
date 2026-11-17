import { actingUser, type Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { readablePlaces, type Readable } from "../identity/access.js";
import { ticketKeySql } from "../work/tickets.js";
import { decisionKeySql } from "../knowledge/decisions.js";
import { applyRedaction, applyRedactions, type Redaction } from "./redact.js";
import { scrubSecrets } from "./scrub.js";
import { firstTurnNaming, titleOf, turnsOf } from "../../shared/transcript-turns.js";
import type { LinkedKind } from "../../shared/from-transcript.js";

/**
 * Transcripts (ADR 0013): the verbatim chats behind an Agent's changes, uploaded from the client side as
 * Markdown and linked by the uploading Agent's own Agent Session ids found in them, and so to everything those
 * Sessions changed. One Transcript per (Agent, client chat id); re-uploads replace its text when they continue it,
 * keep the old text as well when they don't, and only ever add Sessions.
 */

/** A Transcript as the API returns it to someone who may read it. */
export interface Transcript {
  id: string;
  /** What it is called: the first line of its first User turn, or its chat id (see shared/transcript-turns.ts). */
  title: string;
  chatId: string;
  agent: { id: string; name: string; owner: { id: string; name: string } };
  /** The text of the latest upload. */
  markdown: string;
  /** Texts earlier uploads left that a later one didn't continue, oldest first. */
  earlier: string[];
  /** The Agent Sessions it names, in the order they started. */
  sessions: { id: string }[];
  /**
   * The Tickets its Sessions changed, Activities and Comments included, that the reader can read. Each item here and below has
   * the turn of the latest text where its key or id first appears (see shared/transcript-turns.ts), or null when none names it.
   */
  tickets: { key: string; title: string; turn: number | null }[];
  /** The Documents and Reports its Sessions saved or commented on, that the reader can read. */
  documents: { id: string; title: string; turn: number | null }[];
  /** The Terms its Sessions saved, that the reader can read. */
  terms: { id: string; name: string; turn: number | null }[];
  /** The Decisions its Sessions proposed or refined, that the reader can read. */
  decisions: { key: string; title: string; turn: number | null }[];
  /** The Artifacts its Sessions published a Version of, commented on or attached files to Comments on, that the reader can read. */
  artifacts: { id: string; title: string; turn: number | null }[];
  createdAt: Date;
  updatedAt: Date;
}

/** The stored part of a Transcript, without what its Sessions changed. */
export interface StoredTranscript {
  id: string;
  workspaceId: string;
  chatId: string;
  agentId: string;
  ownerId: string;
  markdown: string;
  earlier: string[];
  sessionIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface TranscriptRow {
  id: string;
  workspace_id: string;
  chat_id: string;
  agent_id: string;
  owner_id: string;
  markdown: string;
  earlier: string[];
  session_ids: string[];
  created_at: Date;
  updated_at: Date;
}

const SELECT_TRANSCRIPTS = `
  SELECT tr.*, a.owner_id,
    coalesce((SELECT array_agg(s.id ORDER BY s.started_at, s.id) FROM transcript_sessions ts JOIN agent_sessions s ON s.id = ts.session_id
              WHERE ts.transcript_id = tr.id), '{}') AS session_ids
  FROM transcripts tr JOIN agents a ON a.id = tr.agent_id`;

const toStored = (row: TranscriptRow): StoredTranscript => ({
  id: row.id,
  workspaceId: row.workspace_id,
  chatId: row.chat_id,
  agentId: row.agent_id,
  ownerId: row.owner_id,
  markdown: row.markdown,
  earlier: row.earlier,
  sessionIds: row.session_ids,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The Transcript with this id in the Workspace, if there is one, whoever may read it. */
export async function findTranscript(db: Queryable, workspaceId: string, id: string): Promise<StoredTranscript | undefined> {
  const { rows } = await db.query<TranscriptRow>(`${SELECT_TRANSCRIPTS} WHERE tr.id = $1 AND tr.workspace_id = $2`, [id, workspaceId]);
  return rows[0] && toStored(rows[0]);
}

/** The Agent's Transcript of the client chat `chatId`, if it has one. Locks it until the transaction ends. */
export async function findForUpdate(db: Queryable, agentId: string, chatId: string): Promise<StoredTranscript | undefined> {
  const { rows } = await db.query<TranscriptRow>(`${SELECT_TRANSCRIPTS} WHERE tr.agent_id = $1 AND tr.chat_id = $2 FOR UPDATE OF tr`, [agentId, chatId]);
  return rows[0] && toStored(rows[0]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The ids of the Agent's own Agent Sessions that `markdown` names, in any case. An id an import gave a Session a new id for
 * (see `portability/renamed-ids.ts`) names every Session it became; one that isn't a UUID, as in an export edited by hand,
 * counts only as a whole word.
 */
export async function sessionsNamedIn(db: Queryable, agent: { id: string; workspaceId: string }, markdown: string): Promise<string[]> {
  const uuids = new Set([...markdown.matchAll(UUIDS)].map((m) => m[0].toLowerCase()));
  const named = new Set(uuids);
  const { rows: renamed } = await db.query<{ from_id: string; to_id: string }>(
    "SELECT from_id, to_id FROM renamed_ids WHERE workspace_id = $1 AND kind = 'agent_session'",
    [agent.workspaceId],
  );
  for (const r of renamed) {
    if (UUID.test(r.from_id) ? uuids.has(r.from_id.toLowerCase()) : hasWord(markdown, r.from_id)) named.add(r.to_id);
  }
  if (named.size === 0) return [];
  const { rows } = await db.query<{ id: string }>("SELECT id FROM agent_sessions WHERE agent_id = $1 AND id = ANY($2::uuid[])", [agent.id, [...named]]);
  return rows.map((r) => r.id);
}

/** Characters an id may run on with, so a match next to one is part of a longer word. */
const WORD_CHAR = /[A-Za-z0-9_-]/;

/** Whether `text` holds `word` with no word character right before or after it. */
function hasWord(text: string, word: string): boolean {
  if (word === "") return false;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const before = text[at - 1];
    const after = text[at + word.length];
    if ((before === undefined || !WORD_CHAR.test(before)) && (after === undefined || !WORD_CHAR.test(after))) return true;
  }
  return false;
}

/**
 * Everything Agent Sessions did, by the Session that did it and the Ticket, Document, Term, Decision or Artifact each record is on:
 * the Ticket changes they made, the Activities, Comments and Attachments they added and the Document, Term, Decision and Artifact
 * Versions they saved or published.
 */
const RECORDS = `
  SELECT actor_session_id, ticket_id, NULL::uuid AS document_id, NULL::uuid AS term_id, NULL::uuid AS decision_id, NULL::uuid AS artifact_id FROM ticket_changes
  UNION ALL SELECT actor_session_id, ticket_id, NULL, NULL, NULL, NULL FROM activities
  UNION ALL SELECT actor_session_id, ticket_id, document_id, NULL, NULL, artifact_id FROM comments
  UNION ALL SELECT actor_session_id, NULL, document_id, NULL, NULL, NULL FROM document_versions
  UNION ALL SELECT x.actor_session_id, coalesce(x.ticket_id, c.ticket_id), coalesce(x.document_id, c.document_id), NULL, NULL, c.artifact_id FROM attachments x
    LEFT JOIN comments c ON c.id = x.comment_id
  UNION ALL SELECT actor_session_id, NULL, NULL, term_id, NULL, NULL FROM term_versions
  UNION ALL SELECT actor_session_id, NULL, NULL, NULL, decision_id, NULL FROM decision_versions
  UNION ALL SELECT actor_session_id, NULL, NULL, NULL, NULL, artifact_id FROM artifact_versions`;

/**
 * Where the Sessions of the Transcript aliased `tr` changed things, one row per record of a change to an item that is still there:
 * the item's `project_id`, NULL for the Workspace outside any Project, a Report's being its Ticket's. Derived from the current rows,
 * so an item that changes place counts where it lies now. The places `changedItems` gives, for many Transcripts at once.
 */
const transcriptPlacesSql = (tr: string) => `
  SELECT place.project_id
  FROM transcript_sessions ts JOIN (${RECORDS}) r ON r.actor_session_id = ts.session_id
  LEFT JOIN tickets t ON t.id = r.ticket_id
  LEFT JOIN documents d ON d.id = r.document_id LEFT JOIN tickets rt ON rt.id = d.ticket_id
  LEFT JOIN terms tm ON tm.id = r.term_id
  LEFT JOIN decisions dc ON dc.id = r.decision_id
  LEFT JOIN artifacts a ON a.id = r.artifact_id
  CROSS JOIN LATERAL (VALUES
    (t.id IS NOT NULL, t.project_id),
    (d.id IS NOT NULL, coalesce(rt.project_id, d.project_id)),
    (tm.id IS NOT NULL, tm.project_id),
    (dc.id IS NOT NULL, dc.project_id),
    (a.id IS NOT NULL, a.project_id)
  ) AS place(changed, project_id)
  WHERE ts.transcript_id = ${tr}.id AND place.changed`;

/**
 * SQL for whether the Transcript aliased `tr`, whose Owner's id is the SQL `ownerId`, may be read (see readTranscript) by an Actor
 * reading where SQL for a `Readable`'s `projectIds` (a uuid[]) and `workspaceId` (a uuid, NULL when the Workspace isn't readable)
 * says, and who is the User with the id `userId` (NULL for an Agent): when they are its Owner, or when its Sessions changed something
 * and every place they changed something is readable. What `accessTo` decides for one Transcript, for many in one query.
 */
export const transcriptReadableSql = (tr: string, ownerId: string, projectIds: string, workspaceId: string, userId: string) =>
  `(${ownerId} = ${userId} OR coalesce((
     SELECT bool_and(coalesce(p.project_id = ANY(${projectIds}), ${workspaceId} IS NOT NULL)) FROM (${transcriptPlacesSql(tr)}) p
   ), false))`;

/** The parameters `transcriptReadableSql` takes for `actor` reading where `readable` says: its Projects, its Workspace, its User. */
export const readerParams = (actor: Actor, readable: Readable): [string[], string | null, string | null] => [
  readable.projectIds,
  readable.workspaceId,
  actor.kind === "user" ? actor.user.id : null,
];

/** SQL for whether the Sessions of the Transcript aliased `tr` changed something in one of the Projects `projectIds` (a uuid[]). */
export const transcriptChangedInSql = (tr: string, projectIds: string) =>
  `EXISTS (SELECT 1 FROM (${transcriptPlacesSql(tr)}) p WHERE p.project_id = ANY(${projectIds}))`;

/** Everything the Agent Sessions `$1` did (see RECORDS). */
const SESSION_RECORDS = `SELECT * FROM (${RECORDS}) all_records WHERE actor_session_id = ANY($1::uuid[])`;

/**
 * Whether any of these Agent Sessions changed something: a Ticket, an Activity, a Comment, an Attachment, or a Document, Term,
 * Decision or Artifact Version.
 */
export async function changedAnything(db: Queryable, sessionIds: string[]): Promise<boolean> {
  if (sessionIds.length === 0) return false;
  const { rows } = await db.query(`SELECT 1 FROM (${SESSION_RECORDS}) r LIMIT 1`, [sessionIds]);
  return rows.length > 0;
}

/** What an upload would make of a Transcript: its texts, current last, and every Session it names. */
export interface Upload {
  markdown: string;
  earlier: string[];
  sessionIds: string[];
}

/**
 * What uploading `markdown`, naming `named` Sessions, makes of `existing`: the new text replaces the current one when it
 * continues it (starts with it), is dropped when a text it keeps already continues it (a late retry of an older upload),
 * and otherwise goes beside it, keeping the current one as an earlier text. Sessions only add up.
 */
export function afterUpload(existing: Upload | undefined, markdown: string, named: string[]): Upload {
  if (!existing) return { markdown, earlier: [], sessionIds: named };
  const sessionIds = [...new Set([...existing.sessionIds, ...named])];
  if (markdown.startsWith(existing.markdown)) return { markdown, earlier: existing.earlier, sessionIds };
  // A late retry of what it already keeps, current or earlier, changes no text.
  if ([existing.markdown, ...existing.earlier].some((kept) => kept.startsWith(markdown))) {
    return { markdown: existing.markdown, earlier: existing.earlier, sessionIds };
  }
  return { markdown, earlier: [...existing.earlier, existing.markdown], sessionIds };
}

/**
 * What a Transcript keeps of an uploaded text: the Owner's `redactions` applied, known secrets scrubbed, and the redactions applied
 * again, as they were applied to its earlier texts, so a re-upload continuing one still starts with it. The first pass finds
 * passages redacted over raw text, as on a Transcript stored before scrubbing, which scrubbing would otherwise change so they no
 * longer match; the last finds passages redacted over scrubbed text, which may hold a scrub note. Where a redaction covered only
 * part of a raw secret, the rest may no longer look like a secret and stays as it is, as the stored text already holds it.
 * Keeping what it returns again returns the same text.
 */
export const textToKeep = (markdown: string, redactions: Redaction[]): string =>
  applyRedactions(scrubSecrets(applyRedactions(markdown, redactions)), redactions);

/** The Transcript's hand redactions, in the order they were made. */
export async function redactionsOf(db: Queryable, transcriptId: string): Promise<Redaction[]> {
  const { rows } = await db.query<{ length: number; fingerprint: string; digest: string }>(
    "SELECT length, fingerprint, digest FROM transcript_redactions WHERE transcript_id = $1 ORDER BY seq",
    [transcriptId],
  );
  return rows.map((r) => ({ length: r.length, fingerprint: Number(r.fingerprint), digest: r.digest }));
}

/** Keeps `redactions` as the Transcript's next ones, after any it has. */
export async function storeRedactions(db: Queryable, transcriptId: string, redactions: Redaction[], at: Date): Promise<void> {
  for (const r of redactions) {
    await db.query(
      `INSERT INTO transcript_redactions (transcript_id, seq, length, fingerprint, digest, created_at)
       SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 FROM transcript_redactions WHERE transcript_id = $1`,
      [transcriptId, r.length, r.fingerprint, r.digest, at],
    );
  }
}

/**
 * Redacts the passage `r` finds in every text of `stored`, for good, and keeps `r` to redact later uploads too. False, changing
 * nothing, when no text holds it.
 */
export async function redactTranscript(db: Queryable, stored: StoredTranscript, r: Redaction, at: Date): Promise<boolean> {
  const markdown = applyRedaction(stored.markdown, r);
  const earlier = stored.earlier.map((t) => applyRedaction(t, r));
  if (!markdown.found && !earlier.some((e) => e.found)) return false;
  await db.query("UPDATE transcripts SET markdown = $2, earlier = $3 WHERE id = $1", [stored.id, markdown.text, earlier.map((e) => e.text)]);
  await storeTurns(db, stored.id, markdown.text);
  await storeRedactions(db, stored.id, [r], at);
  return true;
}

/** Keeps the turns of the Transcript's latest text, `markdown`, for search, replacing those it had. */
export async function storeTurns(db: Queryable, transcriptId: string, markdown: string): Promise<void> {
  await db.query("DELETE FROM transcript_turns WHERE transcript_id = $1", [transcriptId]);
  const turns = turnsOf(markdown);
  if (turns.length === 0) return;
  await db.query("INSERT INTO transcript_turns (transcript_id, n, body) SELECT $1, unnest($2::int[]), unnest($3::text[])", [
    transcriptId,
    turns.map((t) => t.n),
    turns.map((t) => t.text),
  ]);
}

/** Keeps the turns of every Transcript, as an upgrade fills them in: one text at a time, as each may hold megabytes. */
export async function storeAllTurns(db: Queryable): Promise<void> {
  const { rows: ids } = await db.query<{ id: string }>("SELECT id FROM transcripts");
  for (const { id } of ids) {
    const { rows } = await db.query<{ markdown: string }>("SELECT markdown FROM transcripts WHERE id = $1", [id]);
    await storeTurns(db, id, rows[0]!.markdown);
  }
}

/**
 * Rewrites every Transcript's texts to what an upload keeps of them now (`textToKeep`), as an upgrade does for those stored before
 * scrubbing: one Transcript at a time, as each may hold megabytes. Only texts that change are written, and nothing else is: not
 * when it was updated, its Sessions or its redactions. The Workspace's size limit isn't applied, as a scrub note may be longer than
 * what it replaces. Running it again changes nothing, as scrubbing and redacting leave their own output alone.
 */
export async function scrubAllStored(db: Queryable): Promise<void> {
  const { rows: ids } = await db.query<{ id: string }>("SELECT id FROM transcripts");
  for (const { id } of ids) {
    const { rows } = await db.query<{ markdown: string; earlier: string[] }>("SELECT markdown, earlier FROM transcripts WHERE id = $1", [id]);
    const stored = rows[0]!;
    const redactions = await redactionsOf(db, id);
    const markdown = textToKeep(stored.markdown, redactions);
    const earlier = stored.earlier.map((t) => textToKeep(t, redactions));
    if (markdown === stored.markdown && earlier.every((t, i) => t === stored.earlier[i])) continue;
    await db.query("UPDATE transcripts SET markdown = $2, earlier = $3 WHERE id = $1", [id, markdown, earlier]);
    if (markdown !== stored.markdown) await storeTurns(db, id, markdown);
  }
}

/** The bytes a Transcript's texts take, as the Workspace's limit counts them. */
export const sizeOf = (upload: Upload): number => [upload.markdown, ...upload.earlier].reduce((n, t) => n + Buffer.byteLength(t, "utf8"), 0);

/** Stores the upload of the Agent's chat `chatId`, creating its Transcript or changing `existing`. Returns the Transcript's id. */
export async function storeTranscript(
  db: Queryable,
  input: { workspaceId: string; agentId: string; chatId: string; existing: StoredTranscript | undefined; upload: Upload; at: Date; createdAt?: Date },
): Promise<string> {
  const { upload } = input;
  let id: string;
  if (input.existing) {
    id = input.existing.id;
    await db.query("UPDATE transcripts SET markdown = $2, earlier = $3, updated_at = $4 WHERE id = $1", [id, upload.markdown, upload.earlier, input.at]);
  } else {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO transcripts (workspace_id, agent_id, chat_id, markdown, earlier, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.workspaceId, input.agentId, input.chatId, upload.markdown, upload.earlier, input.createdAt ?? input.at, input.at],
    );
    id = rows[0]!.id;
  }
  await db.query(
    "INSERT INTO transcript_sessions (transcript_id, session_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
    [id, upload.sessionIds],
  );
  if (input.existing?.markdown !== upload.markdown) await storeTurns(db, id, upload.markdown);
  return id;
}

/** Where a Transcript's Sessions changed things: the Projects, and whether the Workspace outside any Project. */
interface Places {
  projectIds: string[];
  workspace: boolean;
}

/**
 * The records of changes (see RECORDS) a grouping of Sessions made, each with `grp`, the group it counts for: `SESSION_GROUP` keeps
 * the Sessions `$1` as one group, `TRANSCRIPT_GROUPS` groups the Sessions of each Transcript `$1` by the Transcript's id.
 */
type Grouping = string;
const SESSION_GROUP: Grouping = `SELECT NULL::uuid AS grp, r.* FROM (${SESSION_RECORDS}) r`;
const TRANSCRIPT_GROUPS: Grouping = `
  SELECT ts.transcript_id AS grp, r.* FROM transcript_sessions ts JOIN (${RECORDS}) r ON r.actor_session_id = ts.session_id
  WHERE ts.transcript_id = ANY($1::uuid[])`;

/** Each group's changed items in `column` (ticket_id, ...): one row per group and item, joined to the item aliased `alias`. */
const changedIn = (grouping: Grouping, column: string, alias: string) =>
  `JOIN (SELECT DISTINCT grp, ${column} FROM (${grouping}) g WHERE ${column} IS NOT NULL) c ON c.${column} = ${alias}.id`;

/** The Tickets each group changed, with the Project each lies in, by Project key and number. */
const changedTickets = (g: Grouping) => `
  SELECT c.grp, t.id, ${ticketKeySql("p", "t")} AS key, t.title, t.project_id FROM tickets t JOIN projects p ON p.id = t.project_id
  ${changedIn(g, "ticket_id", "t")} ORDER BY p.key, t.number`;

/** The Documents and Reports each group changed, with the Project each lies in: a Report's Ticket's; null for the Workspace. */
const changedDocuments = (g: Grouping) => `
  SELECT c.grp, d.id, d.title, coalesce(rt.project_id, d.project_id) AS project_id FROM documents d LEFT JOIN tickets rt ON rt.id = d.ticket_id
  ${changedIn(g, "document_id", "d")} ORDER BY d.created_at, d.id`;

/** The Terms each group changed, with the Project each lies in; null for the Workspace. The Workspace's first. */
const changedTerms = (g: Grouping) => `
  SELECT c.grp, tm.id, tm.name, tm.project_id, p.key AS project_key FROM terms tm LEFT JOIN projects p ON p.id = tm.project_id
  ${changedIn(g, "term_id", "tm")} ORDER BY p.key NULLS FIRST, lower(tm.name), tm.id`;

/** The Decisions each group changed, with the Project each lies in; null for the Workspace. The Workspace's first. */
const changedDecisions = (g: Grouping) => `
  SELECT c.grp, dc.id, ${decisionKeySql("p", "dc")} AS key, dc.title, dc.project_id FROM decisions dc LEFT JOIN projects p ON p.id = dc.project_id
  ${changedIn(g, "decision_id", "dc")} ORDER BY p.key NULLS FIRST, dc.number`;

/** The Artifacts each group changed, with the Project each lies in; null for the Workspace. */
const changedArtifacts = (g: Grouping) => `
  SELECT c.grp, a.id, a.title, a.project_id FROM artifacts a ${changedIn(g, "artifact_id", "a")} ORDER BY a.created_at, a.id`;

/** What some Sessions changed, each with the Project it lies in (see changedItems). */
export interface ChangedItems {
  tickets: { id: string; key: string; title: string; project_id: string }[];
  documents: { id: string; title: string; project_id: string | null }[];
  terms: { id: string; name: string; project_id: string | null; project_key: string | null }[];
  decisions: { id: string; key: string; title: string; project_id: string | null }[];
  artifacts: { id: string; title: string; project_id: string | null }[];
}

/** The query for what each group changed, of each kind. */
const CHANGED: Record<keyof ChangedItems, (g: Grouping) => string> = {
  tickets: changedTickets,
  documents: changedDocuments,
  terms: changedTerms,
  decisions: changedDecisions,
  artifacts: changedArtifacts,
};

const noChanges = (): ChangedItems => ({ tickets: [], documents: [], terms: [], decisions: [], artifacts: [] });

/**
 * What each group of a grouping (see Grouping) of `ids` changed, by the group's id, in the order `changedItems` gives; a group that
 * changed nothing is left out. Five queries, however many groups there are.
 */
async function changedItemsPerGroup(db: Queryable, grouping: Grouping, ids: string[]): Promise<Map<string | null, ChangedItems>> {
  const byGroup = new Map<string | null, ChangedItems>();
  for (const [kind, changed] of Object.entries(CHANGED) as [keyof ChangedItems, (g: Grouping) => string][]) {
    const { rows } = await db.query<{ grp: string | null }>(changed(grouping), [ids]);
    for (const { grp, ...item } of rows) {
      if (!byGroup.has(grp)) byGroup.set(grp, noChanges());
      (byGroup.get(grp)![kind] as object[]).push(item);
    }
  }
  return byGroup;
}

/**
 * What the Sessions changed, each with the Project it lies in: Tickets by Project key and number, Documents and Artifacts in the
 * order they were created, Terms and Decisions the Workspace's first.
 */
export async function changedItems(db: Queryable, sessionIds: string[]): Promise<ChangedItems> {
  return (await changedItemsPerGroup(db, SESSION_GROUP, sessionIds)).get(null) ?? noChanges();
}

/** Where these changed items lie: their Projects, and whether any lies in the Workspace outside every Project. */
function placesOf(items: ChangedItems): Places {
  const projectIds = new Set<string>(items.tickets.map((t) => t.project_id));
  let workspace = false;
  for (const item of [...items.documents, ...items.terms, ...items.decisions, ...items.artifacts]) {
    if (item.project_id === null) workspace = true;
    else projectIds.add(item.project_id);
  }
  return { projectIds: [...projectIds], workspace };
}

/**
 * What the Transcript's Sessions changed, where, and which of those places `actor` can read; undefined if `actor` may not read the
 * Transcript (see readTranscript). transcriptReadableSql decides the same for many Transcripts at once; keep the two alike.
 */
async function accessTo(db: Queryable, actor: Actor, stored: StoredTranscript, opts: { uploader?: boolean } = {}) {
  if (actingUser(actor).workspaceId !== stored.workspaceId) return undefined;
  const items = await changedItems(db, stored.sessionIds);
  const places = placesOf(items);
  const canReadIn = readsIn(await readablePlaces(db, actor));
  const readsAnyway = (actor.kind === "user" && actor.user.id === stored.ownerId) || opts.uploader === true;
  const somewhere = places.projectIds.length > 0 || places.workspace;
  const everywhere = places.projectIds.every((p) => canReadIn(p)) && (!places.workspace || canReadIn(null));
  // With nothing left that its Sessions changed, nobody but its Owner is shown to have Read there.
  if (!readsAnyway && !(somewhere && everywhere)) return undefined;
  return { items, canReadIn };
}

/**
 * The Transcript as `actor` may read it, or undefined if they may not: its Owner may, and so may anyone (Agents capped as usual)
 * with Read in every Project its Sessions changed things in, and in the Workspace for what they changed outside any Project.
 * What it lists of those changes leaves out what the reader can't read.
 */
export async function readTranscript(
  db: Queryable,
  actor: Actor,
  stored: StoredTranscript,
  /** Set when answering the Agent that uploaded it, who may always read back what it sent. */
  opts: { uploader?: boolean } = {},
): Promise<Transcript | undefined> {
  const access = await accessTo(db, actor, stored, opts);
  if (!access) return undefined;
  const { rows } = await db.query<{ agent_name: string; owner_name: string }>(
    "SELECT a.name AS agent_name, u.name AS owner_name FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.id = $1",
    [stored.agentId],
  );
  return transcriptAsRead(stored, { agent: rows[0]!.agent_name, owner: rows[0]!.owner_name }, access.items, access.canReadIn);
}

/** The Transcript `stored`, whose Agent and Owner have the `names`, as a reader who `canReadIn` a place reads it, with what its Sessions changed. */
function transcriptAsRead(
  stored: StoredTranscript,
  names: { agent: string; owner: string },
  items: ChangedItems,
  canReadIn: (projectId: string | null) => boolean,
): Transcript {
  const turns = turnsOf(stored.markdown);
  const turn = (...keyOrId: string[]) => firstTurnNaming(turns, keyOrId);
  return {
    id: stored.id,
    title: titleOf(turns, stored.chatId),
    chatId: stored.chatId,
    agent: { id: stored.agentId, name: names.agent, owner: { id: stored.ownerId, name: names.owner } },
    markdown: stored.markdown,
    earlier: stored.earlier,
    sessions: stored.sessionIds.map((id) => ({ id })),
    tickets: items.tickets.filter((t) => canReadIn(t.project_id)).map((t) => ({ key: t.key, title: t.title, turn: turn(t.key, t.id) })),
    documents: items.documents.filter((d) => canReadIn(d.project_id)).map((d) => ({ id: d.id, title: d.title, turn: turn(d.id) })),
    terms: items.terms.filter((t) => canReadIn(t.project_id)).map((t) => ({ id: t.id, name: t.name, turn: turn(t.id) })),
    decisions: items.decisions.filter((d) => canReadIn(d.project_id)).map((d) => ({ key: d.key, title: d.title, turn: turn(d.key, d.id) })),
    artifacts: items.artifacts.filter((a) => canReadIn(a.project_id)).map((a) => ({ id: a.id, title: a.title, turn: turn(a.id) })),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

/** Where `readable` lets its reader read: in one of its Projects, or (null) in the Workspace outside any Project. */
const readsIn = (readable: Readable) => (projectId: string | null) =>
  projectId === null ? readable.workspaceId !== null : readable.projectIds.includes(projectId);

/** How `listTranscripts` orders them: most recently uploaded first, or in the order they were first uploaded. */
const ORDERS = { newest: "tr.updated_at DESC, tr.created_at DESC, tr.id", oldest: "tr.created_at, tr.id" } as const;

/** Every Transcript of the Workspace, in `order`, whoever may read them. */
export async function listTranscripts(db: Queryable, workspaceId: string, order: keyof typeof ORDERS): Promise<StoredTranscript[]> {
  const { rows } = await db.query<TranscriptRow>(`${SELECT_TRANSCRIPTS} WHERE tr.workspace_id = $1 ORDER BY ${ORDERS[order]}`, [workspaceId]);
  return rows.map(toStored);
}

/**
 * The Transcripts of the Workspace `actor` may read (see readTranscript), most recently uploaded first, each as readTranscript gives
 * it. Who may read each is decided in the listing query (transcriptReadableSql), and what their Sessions changed is fetched for all
 * of them at once, so this takes the same few queries however many there are.
 */
export async function readableTranscripts(db: Queryable, actor: Actor): Promise<Transcript[]> {
  const readable = await readablePlaces(db, actor);
  const { rows } = await db.query<TranscriptRow & { agent_name: string; owner_name: string }>(
    `SELECT tr.*, a.name AS agent_name, u.name AS owner_name
     FROM (${SELECT_TRANSCRIPTS}) tr JOIN agents a ON a.id = tr.agent_id JOIN users u ON u.id = tr.owner_id
     WHERE tr.workspace_id = $1 AND ${transcriptReadableSql("tr", "tr.owner_id", "$2::uuid[]", "$3::uuid", "$4::uuid")}
     ORDER BY ${ORDERS.newest}`,
    [actingUser(actor).workspaceId, ...readerParams(actor, readable)],
  );
  const items = await changedItemsPerGroup(db, TRANSCRIPT_GROUPS, rows.map((r) => r.id));
  const canReadIn = readsIn(readable);
  return rows.map((row) => transcriptAsRead(toStored(row), { agent: row.agent_name, owner: row.owner_name }, items.get(row.id) ?? noChanges(), canReadIn));
}

/** An item a Transcript may have led to: a Ticket, Document (or Report), Term, Decision or Artifact, by its id, and its key if it has one. */
export type LinkedItem = { kind: LinkedKind; id: string; key?: string };

/**
 * A Transcript as an item it led to links to it ("From Transcript"): without its text, not even its title, so context on claim
 * never holds any of the chat; with the turn where the item first appears.
 */
export interface TranscriptLink {
  id: string;
  agent: { id: string; name: string };
  /** The turn where the item's key or id first appears; null for the top. */
  turn: number | null;
  updatedAt: Date;
}

/**
 * The Transcripts `item` came from (linked to an Agent Session that changed it) that `actor` may read, most recently uploaded first.
 * Who may read each is decided in the same query (transcriptReadableSql), so this takes the same few queries however many there are.
 */
export async function transcriptLinks(db: Queryable, actor: Actor, item: LinkedItem): Promise<TranscriptLink[]> {
  const readable = await readablePlaces(db, actor);
  const { rows } = await db.query<{ id: string; agent_id: string; agent_name: string; markdown: string; updated_at: Date }>(
    `SELECT tr.id, tr.agent_id, a.name AS agent_name, tr.markdown, tr.updated_at
     FROM transcripts tr JOIN agents a ON a.id = tr.agent_id
     WHERE tr.workspace_id = $1 AND tr.id IN (
       SELECT ts.transcript_id FROM transcript_sessions ts JOIN (${RECORDS}) r ON r.actor_session_id = ts.session_id WHERE r.${item.kind}_id = $2)
       AND ${transcriptReadableSql("tr", "a.owner_id", "$3::uuid[]", "$4::uuid", "$5::uuid")}
     ORDER BY ${ORDERS.newest}`,
    [actingUser(actor).workspaceId, item.id, ...readerParams(actor, readable)],
  );
  // Found as readTranscript finds each item's turn.
  const named = item.key ? [item.key, item.id] : [item.id];
  return rows.map((row) => ({
    id: row.id,
    agent: { id: row.agent_id, name: row.agent_name },
    turn: firstTurnNaming(turnsOf(row.markdown), named),
    updatedAt: row.updated_at,
  }));
}

/** A Transcript without its text, as listings show it: its title, the first line of a turn, is text too. */
export const transcriptSummary = ({ markdown: _m, earlier: _e, title: _t, ...summary }: Transcript) => summary;

/** Deletes a Transcript and its links. */
export async function deleteTranscript(db: Queryable, id: string): Promise<void> {
  await db.query("DELETE FROM transcripts WHERE id = $1", [id]);
}
