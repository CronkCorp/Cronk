import type { Actor } from "../actor.js";
import { actingUser } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { readablePlaces, type Readable } from "../identity/access.js";
import { readerParams, transcriptChangedInSql, transcriptReadableSql } from "./transcripts.js";
import { titleOf, turnsOf } from "../../shared/transcript-turns.js";

/**
 * Full-text search over the turns of Transcripts' latest texts (kept in transcript_turns, see migration 0042), with the same
 * configuration and query syntax as the rest of search (search/search.ts). Who may read each is decided in the same query
 * (transcriptReadableSql), so a search takes the same few queries however many Transcripts match.
 */

/** A Transcript a search found, at its best matching turn. */
export interface TranscriptHit {
  transcriptId: string;
  title: string;
  /** The turn that matches best; the earliest of those that match equally well. */
  turn: number;
  /** The text around the match in that turn, as written (Markdown), without the turn's heading. */
  excerpt: string;
}

/** The text-search configuration, as search/search.ts and the index (migration 0042) use. */
const CONFIG = "'english'";

/** The searchable text of a turn, as its index is built on. */
const TURN_TEXT = "left(tt.body, 100000)";

/**
 * What `query` finds among the Transcripts `actor` may read, best match first, at most `limit`; narrowed to `projectIds`, only those
 * whose Sessions changed something in one of those Projects. `readable` is where `actor` may read, when the caller already has it.
 */
export async function searchTranscripts(
  db: Queryable,
  actor: Actor,
  input: { query: string; limit: number; projectIds?: string[] | undefined; readable?: Readable },
): Promise<TranscriptHit[]> {
  if (input.limit <= 0) return [];
  const readable = input.readable ?? (await readablePlaces(db, actor));
  const narrowed = input.projectIds ? `AND ${transcriptChangedInSql("tr", "q.narrowed")}` : "";
  const { rows } = await db.query<{ transcript_id: string; n: number; chat_id: string; markdown: string; excerpt: string | null }>(
    `WITH q AS (SELECT websearch_to_tsquery(${CONFIG}, $1) AS query, $3::uuid[] AS projects, $4::uuid AS workspace_id, $5::uuid AS user_id,
                       $6::uuid[] AS narrowed)
     SELECT hit.transcript_id, hit.n, tr.chat_id, tr.markdown,
       ts_headline(${CONFIG}, substr(tt.body, strpos(tt.body, E'\\n') + 1), q.query, 'StartSel="", StopSel="", MinWords=10, MaxWords=30') AS excerpt
     FROM q, (
       SELECT transcript_id, n, rank, updated_at FROM (
         SELECT DISTINCT ON (tt.transcript_id) tt.transcript_id, tt.n, ts_rank(to_tsvector(${CONFIG}, ${TURN_TEXT}), q.query) AS rank, tr.updated_at
         FROM q, transcript_turns tt JOIN transcripts tr ON tr.id = tt.transcript_id JOIN agents a ON a.id = tr.agent_id
         WHERE tr.workspace_id = $2 AND to_tsvector(${CONFIG}, ${TURN_TEXT}) @@ q.query
           AND ${transcriptReadableSql("tr", "a.owner_id", "q.projects", "q.workspace_id", "q.user_id")} ${narrowed}
         ORDER BY tt.transcript_id, rank DESC, tt.n
       ) best
       ORDER BY rank DESC, updated_at DESC, transcript_id
       LIMIT $7
     ) hit
     JOIN transcripts tr ON tr.id = hit.transcript_id
     JOIN transcript_turns tt ON tt.transcript_id = hit.transcript_id AND tt.n = hit.n
     ORDER BY hit.rank DESC, hit.updated_at DESC, hit.transcript_id`,
    [
      input.query,
      actingUser(actor).workspaceId,
      ...readerParams(actor, readable),
      input.projectIds ?? null,
      input.limit,
    ],
  );
  return rows.map((row) => ({
    transcriptId: row.transcript_id,
    title: titleOf(turnsOf(row.markdown), row.chat_id),
    turn: row.n,
    excerpt: (row.excerpt ?? "").trim(),
  }));
}
