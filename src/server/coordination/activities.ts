import type { AgentActor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import type { ActivityKind } from "../../shared/values.js";
import { ticketKeySql } from "../work/tickets.js";

/**
 * One timestamped entry an Agent Session writes on a Ticket while holding its Claim: a plan,
 * progress, finding, question or error. Only a question may be blocking. The body is Markdown.
 */
export interface Activity {
  id: string;
  ticketId: string;
  ticketKey: string;
  kind: ActivityKind;
  body: string;
  blocking: boolean;
  at: Date;
  agent: { id: string; name: string; owner: { id: string; name: string } };
  session: { id: string };
  /** For a question: the Comment that answered it, once one has. */
  answer: { commentId: string; at: Date } | null;
}

interface ActivityRow {
  id: string;
  ticket_id: string;
  ticket_key: string;
  kind: ActivityKind;
  body: string;
  blocking: boolean;
  at: Date;
  agent_id: string;
  agent_name: string;
  owner_id: string;
  owner_name: string;
  session_id: string;
  answer_comment_id: string | null;
  answer_at: Date | null;
}

/** Selects Activities, with their Ticket's key, Agent and Owner, from `source` (the table, or a CTE of new rows) as `v`. */
const selectFrom = (source: string) => `
  SELECT v.id, v.ticket_id, ${ticketKeySql("p", "t")} AS ticket_key, v.kind, v.body, v.blocking, v.at,
    a.id AS agent_id, a.name AS agent_name, u.id AS owner_id, u.name AS owner_name, v.actor_session_id AS session_id,
    v.answer_comment_id, ans.at AS answer_at
  FROM ${source} v JOIN tickets t ON t.id = v.ticket_id JOIN projects p ON p.id = t.project_id
    JOIN agents a ON a.id = v.actor_agent_id JOIN users u ON u.id = v.actor_user_id LEFT JOIN comments ans ON ans.id = v.answer_comment_id`;

const toActivity = (row: ActivityRow): Activity => ({
  id: row.id,
  ticketId: row.ticket_id,
  ticketKey: row.ticket_key,
  kind: row.kind,
  body: row.body,
  blocking: row.blocking,
  at: row.at,
  agent: { id: row.agent_id, name: row.agent_name, owner: { id: row.owner_id, name: row.owner_name } },
  session: { id: row.session_id },
  answer: row.answer_comment_id === null ? null : { commentId: row.answer_comment_id, at: row.answer_at! },
});

/** Records an Activity the Agent Session `agent.session` wrote on the Ticket. Callers check it holds the Claim. */
export async function insertActivity(
  db: Queryable,
  ticketId: string,
  agent: AgentActor & { session: { id: string } },
  input: { kind: ActivityKind; body: string; blocking: boolean },
  at: Date,
): Promise<Activity> {
  const { rows } = await db.query<ActivityRow>(
    `WITH inserted AS (
       INSERT INTO activities (ticket_id, kind, body, blocking, at, actor_user_id, actor_agent_id, actor_session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *)
     ${selectFrom("inserted")}`,
    [ticketId, input.kind, input.body, input.blocking, at, agent.owner.id, agent.agent.id, agent.session.id],
  );
  return toActivity(rows[0]!);
}

/** A Ticket's Activities, oldest first. */
export async function listActivities(db: Queryable, ticketId: string): Promise<Activity[]> {
  const { rows } = await db.query<ActivityRow>(`${selectFrom("activities")} WHERE v.ticket_id = $1 ORDER BY v.seq`, [ticketId]);
  return rows.map(toActivity);
}

/** The Activity with this id, if it is on the Ticket. */
export async function findActivity(db: Queryable, ticketId: string, id: string): Promise<Activity | undefined> {
  const { rows } = await db.query<ActivityRow>(`${selectFrom("activities")} WHERE v.id = $1 AND v.ticket_id = $2`, [id, ticketId]);
  return rows[0] && toActivity(rows[0]);
}

/**
 * Marks the question `activity` answered by `commentId`, unless it is not a question or is
 * already answered. Returns whether it did.
 */
export async function markAnswered(db: Queryable, activity: Activity, commentId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE activities SET answer_comment_id = $2 WHERE id = $1 AND kind = 'question' AND answer_comment_id IS NULL",
    [activity.id, commentId],
  );
  return rowCount === 1;
}

/** The shape of an Activity the API returns. */
export const publicActivity = ({ ticketId: _, ...activity }: Activity) => activity;
