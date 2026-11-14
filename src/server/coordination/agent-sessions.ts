import type { Queryable } from "../db/database.js";

/**
 * One continuous connection of an Agent, from connect to disconnect. It is live until it is
 * ended or stays silent longer than the Workspace's silence threshold; every call made in it
 * refreshes it.
 */
export interface AgentSession {
  id: string;
  agentId: string;
  startedAt: Date;
  lastSeenAt: Date;
  /** When the Session ends if it stays silent until then. */
  endsIfSilentAt: Date;
}

interface AgentSessionRow {
  id: string;
  agent_id: string;
  started_at: Date;
  last_seen_at: Date;
  silence_threshold_seconds: number;
}

const toAgentSession = (row: AgentSessionRow): AgentSession => ({
  id: row.id,
  agentId: row.agent_id,
  startedAt: row.started_at,
  lastSeenAt: row.last_seen_at,
  endsIfSilentAt: new Date(row.last_seen_at.getTime() + row.silence_threshold_seconds * 1000),
});

/** The shape of an Agent Session the API returns. */
export const publicAgentSession = (session: AgentSession) => ({
  id: session.id,
  startedAt: session.startedAt,
  lastSeenAt: session.lastSeenAt,
  endsIfSilentAt: session.endsIfSilentAt,
});

/** Joins a Session to its Workspace's silence threshold; `s` is the Session. */
const WITH_THRESHOLD = `
  JOIN agents a ON a.id = s.agent_id JOIN workspaces w ON w.id = a.workspace_id`;

/** SQL condition: the Session `s` is live at `$now`. */
const isLive = (now: string) => `s.ended_at IS NULL AND s.last_seen_at > ${now}::timestamptz - make_interval(secs => w.silence_threshold_seconds)`;

export async function startAgentSession(db: Queryable, agentId: string, now: Date): Promise<AgentSession> {
  const { rows } = await db.query<AgentSessionRow>(
    `WITH s AS (INSERT INTO agent_sessions (agent_id, started_at, last_seen_at) VALUES ($1, $2, $2) RETURNING *)
     SELECT s.*, w.silence_threshold_seconds FROM s ${WITH_THRESHOLD}`,
    [agentId, now],
  );
  return toAgentSession(rows[0]!);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refreshes the Agent's live Session `id` and returns it; undefined if the Agent has no such
 * Session or it has ended, by disconnecting or by staying silent too long.
 */
export async function touchAgentSession(db: Queryable, agentId: string, id: string, now: Date): Promise<AgentSession | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await db.query<AgentSessionRow>(
    `UPDATE agent_sessions s SET last_seen_at = $3 FROM agents a JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.id = s.agent_id AND s.id = $1 AND s.agent_id = $2 AND ${isLive("$3")}
     RETURNING s.*, w.silence_threshold_seconds`,
    [id, agentId, now],
  );
  return rows[0] && toAgentSession(rows[0]);
}

/** Ends a Session now. */
export async function endAgentSession(db: Queryable, id: string, now: Date): Promise<void> {
  await db.query("UPDATE agent_sessions SET ended_at = $2 WHERE id = $1 AND ended_at IS NULL", [id, now]);
}

/** Ends every Session of an Agent, as when it is removed. */
export async function endAgentSessionsOf(db: Queryable, agentId: string, now: Date): Promise<void> {
  await db.query("UPDATE agent_sessions SET ended_at = $2 WHERE agent_id = $1 AND ended_at IS NULL", [agentId, now]);
}

/** The live Sessions of each of these Agents, oldest first. */
export async function liveAgentSessions(db: Queryable, agentIds: string[], now: Date): Promise<Map<string, AgentSession[]>> {
  const { rows } = await db.query<AgentSessionRow>(
    `SELECT s.*, w.silence_threshold_seconds FROM agent_sessions s ${WITH_THRESHOLD}
     WHERE s.agent_id = ANY($1::uuid[]) AND ${isLive("$2")} ORDER BY s.started_at, s.id`,
    [agentIds, now],
  );
  const byAgent = new Map<string, AgentSession[]>(agentIds.map((id) => [id, []]));
  for (const row of rows) byAgent.get(row.agent_id)!.push(toAgentSession(row));
  return byAgent;
}
