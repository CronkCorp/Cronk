import type { Actor } from "../actor.js";
import { actingUser } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { findable, findTranscript } from "./transcripts.js";
import { titleOf, turnsOf } from "../../shared/transcript-turns.js";

/**
 * Full-text search over the turns of Transcripts' latest texts (kept in transcript_turns, see migration 0042), with the same
 * configuration and query syntax as the rest of search (search/search.ts). Access to a Transcript depends on everything its Sessions
 * changed, so candidates are found in SQL and then checked one by one, best first, until enough are found.
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
 * whose Sessions changed something in one of those Projects.
 */
export async function searchTranscripts(
  db: Queryable,
  actor: Actor,
  input: { query: string; limit: number; projectIds?: string[] | undefined },
): Promise<TranscriptHit[]> {
  if (input.limit <= 0) return [];
  const { rows } = await db.query<{ transcript_id: string; n: number }>(
    `WITH q AS (SELECT websearch_to_tsquery(${CONFIG}, $1) AS query)
     SELECT transcript_id, n FROM (
       SELECT DISTINCT ON (tt.transcript_id) tt.transcript_id, tt.n, ts_rank(to_tsvector(${CONFIG}, ${TURN_TEXT}), q.query) AS rank, tr.updated_at
       FROM q, transcript_turns tt JOIN transcripts tr ON tr.id = tt.transcript_id
       WHERE tr.workspace_id = $2 AND to_tsvector(${CONFIG}, ${TURN_TEXT}) @@ q.query
       ORDER BY tt.transcript_id, rank DESC, tt.n
     ) best
     ORDER BY rank DESC, updated_at DESC, transcript_id`,
    [input.query, actingUser(actor).workspaceId],
  );
  const hits: TranscriptHit[] = [];
  for (const row of rows) {
    if (hits.length >= input.limit) break;
    const stored = await findTranscript(db, actingUser(actor).workspaceId, row.transcript_id);
    if (!stored || !(await findable(db, actor, stored, input.projectIds))) continue;
    const { rows: excerpt } = await db.query<{ excerpt: string }>(
      `SELECT ts_headline(${CONFIG}, substr(tt.body, strpos(tt.body, E'\\n') + 1), websearch_to_tsquery(${CONFIG}, $3), 'StartSel="", StopSel="", MinWords=10, MaxWords=30') AS excerpt
       FROM transcript_turns tt WHERE tt.transcript_id = $1 AND tt.n = $2`,
      [row.transcript_id, row.n, input.query],
    );
    hits.push({ transcriptId: stored.id, title: titleOf(turnsOf(stored.markdown), stored.chatId), turn: row.n, excerpt: (excerpt[0]?.excerpt ?? "").trim() });
  }
  return hits;
}
