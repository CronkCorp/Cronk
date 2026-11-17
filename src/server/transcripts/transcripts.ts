import { actingUser, type Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { readablePlaces } from "../identity/access.js";
import { ticketKeySql } from "../work/tickets.js";
import { decisionKeySql } from "../knowledge/decisions.js";
import { applyRedaction, applyRedactions, type Redaction } from "./redact.js";
import { scrubSecrets } from "./scrub.js";
import { firstTurnNaming, turnsOf } from "./turns.js";

/**
 * Transcripts (ADR 0013): the verbatim chats behind an Agent's changes, uploaded from the client side as
 * Markdown and linked by the uploading Agent's own Agent Session ids found in them, and so to everything those
 * Sessions changed. One Transcript per (Agent, client chat id); re-uploads replace its text when they continue it,
 * keep the old text as well when they don't, and only ever add Sessions.
 */

/** A Transcript as the API returns it to someone who may read it. */
export interface Transcript {
  id: string;
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
   * the turn of the latest text where its key or id first appears (see turns.ts), or null when none names it.
   */
  tickets: { key: string; title: string; turn: number | null }[];
  /** The Documents and Reports its Sessions saved or commented on, that the reader can read. */
  documents: { id: string; title: string; turn: number | null }[];
  /** The Terms its Sessions saved, that the reader can read. */
  terms: { id: string; name: string; turn: number | null }[];
  /** The Decisions its Sessions proposed or refined, that the reader can read. */
  decisions: { key: string; title: string; turn: number | null }[];
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
 * Everything the Agent Sessions `$1` did, as the Ticket, Document, Term or Decision each record is on: the Ticket changes they
 * made, the Activities, Comments and Attachments they added and the Document, Term and Decision Versions they saved.
 */
const SESSION_RECORDS = `
  SELECT ticket_id, NULL::uuid AS document_id, NULL::uuid AS term_id, NULL::uuid AS decision_id FROM ticket_changes WHERE actor_session_id = ANY($1::uuid[])
  UNION ALL SELECT ticket_id, NULL, NULL, NULL FROM activities WHERE actor_session_id = ANY($1::uuid[])
  UNION ALL SELECT ticket_id, document_id, NULL, NULL FROM comments WHERE actor_session_id = ANY($1::uuid[])
  UNION ALL SELECT NULL, document_id, NULL, NULL FROM document_versions WHERE actor_session_id = ANY($1::uuid[])
  UNION ALL SELECT coalesce(x.ticket_id, c.ticket_id), coalesce(x.document_id, c.document_id), NULL, NULL FROM attachments x
    LEFT JOIN comments c ON c.id = x.comment_id WHERE x.actor_session_id = ANY($1::uuid[])
  UNION ALL SELECT NULL, NULL, term_id, NULL FROM term_versions WHERE actor_session_id = ANY($1::uuid[])
  UNION ALL SELECT NULL, NULL, NULL, decision_id FROM decision_versions WHERE actor_session_id = ANY($1::uuid[])`;

/**
 * Whether any of these Agent Sessions changed something: a Ticket, an Activity, a Comment, an Attachment, or a Document, Term or
 * Decision Version.
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
 * What a Transcript keeps of an uploaded text: the text with known secrets scrubbed and then the Owner's `redactions` applied,
 * as they were applied to its earlier texts, so a re-upload continuing one still starts with it.
 */
export const textToKeep = (markdown: string, redactions: Redaction[]): string => applyRedactions(scrubSecrets(markdown), redactions);

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
  await storeRedactions(db, stored.id, [r], at);
  return true;
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
  return id;
}

/** Where a Transcript's Sessions changed things: the Projects, and whether the Workspace outside any Project. */
interface Places {
  projectIds: string[];
  workspace: boolean;
}

/** The Tickets changed by these Sessions (`$1`), with the Project each lies in. */
const CHANGED_TICKETS = `
  SELECT t.id, ${ticketKeySql("p", "t")} AS key, t.title, t.project_id, t.number FROM tickets t JOIN projects p ON p.id = t.project_id
  WHERE t.id IN (SELECT ticket_id FROM (${SESSION_RECORDS}) r)`;

/** The Documents and Reports changed by these Sessions (`$1`), with the Project each lies in: a Report's Ticket's; null for the Workspace. */
const CHANGED_DOCUMENTS = `
  SELECT d.id, d.title, coalesce(rt.project_id, d.project_id) AS project_id, d.created_at FROM documents d LEFT JOIN tickets rt ON rt.id = d.ticket_id
  WHERE d.id IN (SELECT document_id FROM (${SESSION_RECORDS}) r)`;

/** The Terms changed by these Sessions (`$1`), with the Project each lies in; null for the Workspace. */
const CHANGED_TERMS = `
  SELECT tm.id, tm.name, tm.project_id, p.key AS project_key FROM terms tm LEFT JOIN projects p ON p.id = tm.project_id
  WHERE tm.id IN (SELECT term_id FROM (${SESSION_RECORDS}) r)`;

/** The Decisions changed by these Sessions (`$1`), with the Project each lies in; null for the Workspace. */
const CHANGED_DECISIONS = `
  SELECT dc.id, ${decisionKeySql("p", "dc")} AS key, dc.title, dc.project_id FROM decisions dc LEFT JOIN projects p ON p.id = dc.project_id
  WHERE dc.id IN (SELECT decision_id FROM (${SESSION_RECORDS}) r)`;

/**
 * What the Sessions changed, each with the Project it lies in: Tickets by Project key and number, Documents in the order they
 * were created, Terms and Decisions the Workspace's first.
 */
export async function changedItems(db: Queryable, sessionIds: string[]) {
  const { rows: tickets } = await db.query<{ id: string; key: string; title: string; project_id: string }>(
    `${CHANGED_TICKETS} ORDER BY p.key, t.number`,
    [sessionIds],
  );
  const { rows: documents } = await db.query<{ id: string; title: string; project_id: string | null }>(
    `${CHANGED_DOCUMENTS} ORDER BY d.created_at, d.id`,
    [sessionIds],
  );
  const { rows: terms } = await db.query<{ id: string; name: string; project_id: string | null; project_key: string | null }>(
    `${CHANGED_TERMS} ORDER BY p.key NULLS FIRST, lower(tm.name), tm.id`,
    [sessionIds],
  );
  const { rows: decisions } = await db.query<{ id: string; key: string; title: string; project_id: string | null }>(
    `${CHANGED_DECISIONS} ORDER BY p.key NULLS FIRST, dc.number`,
    [sessionIds],
  );
  return { tickets, documents, terms, decisions };
}

/** Where these changed items lie: their Projects, and whether any lies in the Workspace outside every Project. */
function placesOf(items: Awaited<ReturnType<typeof changedItems>>): Places {
  const projectIds = new Set<string>(items.tickets.map((t) => t.project_id));
  let workspace = false;
  for (const item of [...items.documents, ...items.terms, ...items.decisions]) {
    if (item.project_id === null) workspace = true;
    else projectIds.add(item.project_id);
  }
  return { projectIds: [...projectIds], workspace };
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
  const items = await changedItems(db, stored.sessionIds);
  const places = placesOf(items);
  const readable = await readablePlaces(db, actor);
  const canReadIn = (projectId: string | null) => (projectId === null ? readable.workspaceId !== null : readable.projectIds.includes(projectId));
  const readsAnyway = (actor.kind === "user" && actor.user.id === stored.ownerId) || opts.uploader === true;
  const somewhere = places.projectIds.length > 0 || places.workspace;
  const everywhere = places.projectIds.every((p) => canReadIn(p)) && (!places.workspace || canReadIn(null));
  if (actingUser(actor).workspaceId !== stored.workspaceId) return undefined;
  // With nothing left that its Sessions changed, nobody but its Owner is shown to have Read there.
  if (!readsAnyway && !(somewhere && everywhere)) return undefined;
  const { rows } = await db.query<{ agent_name: string; owner_name: string }>(
    "SELECT a.name AS agent_name, u.name AS owner_name FROM agents a JOIN users u ON u.id = a.owner_id WHERE a.id = $1",
    [stored.agentId],
  );
  const turns = turnsOf(stored.markdown);
  const turn = (...keyOrId: string[]) => firstTurnNaming(turns, keyOrId);
  return {
    id: stored.id,
    chatId: stored.chatId,
    agent: { id: stored.agentId, name: rows[0]!.agent_name, owner: { id: stored.ownerId, name: rows[0]!.owner_name } },
    markdown: stored.markdown,
    earlier: stored.earlier,
    sessions: stored.sessionIds.map((id) => ({ id })),
    tickets: items.tickets.filter((t) => canReadIn(t.project_id)).map((t) => ({ key: t.key, title: t.title, turn: turn(t.key, t.id) })),
    documents: items.documents.filter((d) => canReadIn(d.project_id)).map((d) => ({ id: d.id, title: d.title, turn: turn(d.id) })),
    terms: items.terms.filter((t) => canReadIn(t.project_id)).map((t) => ({ id: t.id, name: t.name, turn: turn(t.id) })),
    decisions: items.decisions.filter((d) => canReadIn(d.project_id)).map((d) => ({ key: d.key, title: d.title, turn: turn(d.key, d.id) })),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

/** How `listTranscripts` orders them: most recently uploaded first, or in the order they were first uploaded. */
const ORDERS = { newest: "tr.updated_at DESC, tr.created_at DESC, tr.id", oldest: "tr.created_at, tr.id" } as const;

/** Every Transcript of the Workspace, in `order`, whoever may read them. */
export async function listTranscripts(db: Queryable, workspaceId: string, order: keyof typeof ORDERS): Promise<StoredTranscript[]> {
  const { rows } = await db.query<TranscriptRow>(`${SELECT_TRANSCRIPTS} WHERE tr.workspace_id = $1 ORDER BY ${ORDERS[order]}`, [workspaceId]);
  return rows.map(toStored);
}

/** A Transcript without its text, as listings show it. */
export const transcriptSummary = ({ markdown: _m, earlier: _e, ...summary }: Transcript) => summary;

/** Deletes a Transcript and its links. */
export async function deleteTranscript(db: Queryable, id: string): Promise<void> {
  await db.query("DELETE FROM transcripts WHERE id = $1", [id]);
}
