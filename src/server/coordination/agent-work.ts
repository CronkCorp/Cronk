import type { Actor, RecordedActor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { documentReadableSql, readablePlaces } from "../identity/access.js";
import { ticketKeySql, type RecordedChange } from "../work/tickets.js";
import type { ActivityKind } from "../../shared/values.js";

/**
 * Everything an Agent did, across the Workspace, as one feed: the changes it made to Tickets,
 * the Activities and Comments it wrote, and the Document Versions it saved. It answers
 * "what did my Agents do this week?" without opening every Ticket's history.
 */

/** One thing an Agent did. `kind` says which; the field named after it holds what, and the others are null. */
export interface AgentWorkEntry {
  kind: "change" | "activity" | "comment" | "version";
  at: Date;
  /** The Agent Session it was done in; null for history imported from an export that didn't name one. */
  session: { id: string } | null;
  /** Null for a Document in the Workspace outside any Project. */
  projectKey: string | null;
  /** The Ticket it was on: a change's, Activity's or Comment's Ticket, or a Report's. */
  ticket: { key: string; title: string } | null;
  /** The Document it was on: a Comment's or a saved Version's. */
  document: { id: string; title: string } | null;
  change: RecordedChange | null;
  activity: { id: string; kind: ActivityKind; body: string; blocking: boolean } | null;
  comment: { id: string; body: string } | null;
  version: { number: number } | null;
}

interface WorkRow {
  kind: AgentWorkEntry["kind"];
  at: Date;
  session_id: string | null;
  project_key: string | null;
  ticket_key: string | null;
  ticket_title: string | null;
  document_id: string | null;
  document_title: string | null;
  /** What the kind's field holds, built as JSON by each SELECT. */
  data: Record<string, unknown>;
}

/**
 * One SELECT per kind of record, each giving the same columns. They read the Agent as `$1`, the
 * readable Project ids as `$2` and the Workspace's id, when it is readable outside any Project, as `$3`.
 */
const SELECTS = [
  `SELECT 'change' AS kind, c.at, c.actor_session_id AS session_id, p.key AS project_key, ${ticketKeySql("p", "t")} AS ticket_key,
     t.title AS ticket_title, NULL::uuid AS document_id, NULL AS document_title,
     jsonb_build_object('change', c.change) || c.data AS data, c.id AS seq
   FROM ticket_changes c JOIN tickets t ON t.id = c.ticket_id JOIN projects p ON p.id = t.project_id
   WHERE c.actor_agent_id = $1 AND t.project_id = ANY($2)
     -- A relation names another Ticket, which may lie in a Project the reader can't see.
     AND (c.change NOT IN ('relation added', 'relation removed') OR EXISTS (
       SELECT 1 FROM projects rp WHERE rp.id = ANY($2) AND rp.key = regexp_replace(c.data->'ticket'->>'key', '-[0-9]+$', '')))
     -- So may a linked Document; null projectKey means a Workspace Document.
     AND (c.change NOT IN ('document linked', 'document unlinked') OR
       CASE WHEN c.data->'document'->>'projectKey' IS NULL THEN $3::uuid IS NOT NULL
            ELSE EXISTS (SELECT 1 FROM projects dp WHERE dp.id = ANY($2) AND dp.key = c.data->'document'->>'projectKey') END)`,
  `SELECT 'activity', a.at, a.actor_session_id, p.key, ${ticketKeySql("p", "t")}, t.title, NULL::uuid, NULL,
     jsonb_build_object('id', a.id, 'kind', a.kind, 'body', a.body, 'blocking', a.blocking), a.seq
   FROM activities a JOIN tickets t ON t.id = a.ticket_id JOIN projects p ON p.id = t.project_id
   WHERE a.actor_agent_id = $1 AND t.project_id = ANY($2)`,
  `SELECT 'comment', c.at, c.actor_session_id, p.key, ${ticketKeySql("p", "t")}, t.title, NULL::uuid, NULL,
     jsonb_build_object('id', c.id, 'body', c.body), c.seq
   FROM comments c JOIN tickets t ON t.id = c.ticket_id JOIN projects p ON p.id = t.project_id
   WHERE c.actor_agent_id = $1 AND t.project_id = ANY($2)`,
  `SELECT 'comment', c.at, c.actor_session_id, p.key, NULL, NULL, d.id, d.title,
     jsonb_build_object('id', c.id, 'body', c.body), c.seq
   FROM comments c JOIN documents d ON d.id = c.document_id LEFT JOIN projects p ON p.id = d.project_id
   WHERE c.actor_agent_id = $1 AND ${documentReadableSql("d", "$2", "$3")}`,
  // A Report lies with its Ticket, so whoever can read the Ticket can read it.
  `SELECT 'version', v.at, v.actor_session_id, p.key,
     CASE WHEN t.id IS NULL THEN NULL ELSE ${ticketKeySql("p", "t")} END, t.title, d.id, d.title,
     jsonb_build_object('number', v.number), v.number::bigint
   FROM document_versions v JOIN documents d ON d.id = v.document_id LEFT JOIN tickets t ON t.id = d.ticket_id
     LEFT JOIN projects p ON p.id = coalesce(t.project_id, d.project_id)
   WHERE v.actor_agent_id = $1 AND (CASE WHEN t.id IS NULL THEN ${documentReadableSql("d", "$2", "$3")} ELSE t.project_id = ANY($2) END)`,
];

/**
 * What `agent` did, as far as `actor` may read, newest first: at most `limit` entries,
 * from `since` on when given.
 */
export async function listAgentWork(
  db: Queryable,
  actor: Actor,
  agent: { id: string; name: string; owner: { id: string; name: string } },
  input: { since?: Date | undefined; limit: number },
): Promise<AgentWorkEntry[]> {
  const readable = await readablePlaces(db, actor);
  const { rows } = await db.query<WorkRow>(
    `SELECT * FROM (${SELECTS.join("\n UNION ALL ")}) work
     WHERE $4::timestamptz IS NULL OR work.at >= $4
     ORDER BY work.at DESC, work.kind, work.seq DESC
     LIMIT $5`,
    [agent.id, readable.projectIds, readable.workspaceId, input.since ?? null, input.limit],
  );
  return rows.map((row) => {
    const session = row.session_id === null ? null : { id: row.session_id };
    const by: RecordedActor = { kind: "agent", id: agent.id, name: agent.name, owner: agent.owner, session };
    return {
      kind: row.kind,
      at: row.at,
      session,
      projectKey: row.project_key,
      ticket: row.ticket_key === null ? null : { key: row.ticket_key, title: row.ticket_title! },
      document: row.document_id === null ? null : { id: row.document_id, title: row.document_title! },
      change: row.kind === "change" ? toChange(row, by) : null,
      activity: row.kind === "activity" ? (row.data as AgentWorkEntry["activity"]) : null,
      comment: row.kind === "comment" ? (row.data as AgentWorkEntry["comment"]) : null,
      version: row.kind === "version" ? (row.data as AgentWorkEntry["version"]) : null,
    };
  });
}

/** A change row as a Ticket's history shows it: a status change always says whether it was a Send back. */
function toChange(row: WorkRow, actor: RecordedActor): RecordedChange {
  const { change, ...data } = row.data as { change: string };
  return { at: row.at, actor, change, ...data, ...(change === "status" && { sentBack: (data as { sentBack?: boolean }).sentBack === true }) } as RecordedChange;
}
