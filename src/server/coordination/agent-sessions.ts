import type { Queryable } from "../db/database.js";

/**
 * One continuous connection of an Agent, from connect to disconnect. It is live until it is
 * ended or stays silent longer than the Workspace's silence threshold; every call made in it
 * refreshes it, as does its open stream of waiting work, on each heartbeat.
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

/** Joins a Session `s` to its Agent `a` and Workspace `w`, whose silence threshold decides whether it is live. */
export const WITH_WORKSPACE = `
  JOIN agents a ON a.id = s.agent_id JOIN workspaces w ON w.id = a.workspace_id`;

/**
 * SQL condition: the Session `s`, joined by WITH_WORKSPACE to its Workspace `w`, is live at the time in the
 * parameter `nowParam`, such as `$2`. Pass other aliases for the Session and Workspace if they differ.
 */
export const isLiveAt = (nowParam: string, alias: { session: string; workspace: string } = { session: "s", workspace: "w" }) =>
  `${alias.session}.ended_at IS NULL AND ${alias.session}.last_seen_at > ${nowParam}::timestamptz - make_interval(secs => ${alias.workspace}.silence_threshold_seconds)`;

/** Starts a live Session for the Agent whose token `tokenId` is. */
export async function startAgentSession(db: Queryable, input: { agentId: string; tokenId: string; now: Date }): Promise<AgentSession> {
  const { rows } = await db.query<AgentSessionRow>(
    `WITH s AS (INSERT INTO agent_sessions (agent_id, token_id, started_at, last_seen_at) VALUES ($1, $2, $3, $3) RETURNING *)
     SELECT s.*, w.silence_threshold_seconds FROM s ${WITH_WORKSPACE}`,
    [input.agentId, input.tokenId, input.now],
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
     WHERE a.id = s.agent_id AND s.id = $1 AND s.agent_id = $2 AND ${isLiveAt("$3")}
     RETURNING s.*, w.silence_threshold_seconds`,
    [id, agentId, now],
  );
  return rows[0] && toAgentSession(rows[0]);
}

/** The Agent's live Session `id`, without refreshing it; undefined if it has none such or it has ended. */
export async function findLiveAgentSession(db: Queryable, agentId: string, id: string, now: Date): Promise<AgentSession | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await db.query<AgentSessionRow>(
    `SELECT s.*, w.silence_threshold_seconds FROM agent_sessions s ${WITH_WORKSPACE} WHERE s.id = $1 AND s.agent_id = $2 AND ${isLiveAt("$3")}`,
    [id, agentId, now],
  );
  return rows[0] && toAgentSession(rows[0]);
}

/** Ends the Sessions `column` picks, and returns the Tickets whose live Claims they held. */
async function endSessions(db: Queryable, column: "id" | "token_id" | "agent_id", value: string, now: Date): Promise<ClaimHolders> {
  const { rows } = await db.query<{ id: string }>(
    `WITH ended AS (
       UPDATE agent_sessions s SET ended_at = $2 FROM agents a JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.id = s.agent_id AND s.${column} = $1 AND s.ended_at IS NULL
       RETURNING s.id, s.last_seen_at > $2::timestamptz - make_interval(secs => w.silence_threshold_seconds) AS was_live)
     SELECT t.id FROM tickets t JOIN ended ON ended.id = t.claim_session_id WHERE ended.was_live`,
    [value, now],
  );
  return { ticketIds: rows.map((r) => r.id) };
}

/** What ending Agent Sessions changed: the Tickets whose live Claims they held, which no longer have one. */
export interface ClaimHolders {
  ticketIds: string[];
}

/** Ends a Session now. */
export async function endAgentSession(db: Queryable, id: string, now: Date): Promise<ClaimHolders> {
  return endSessions(db, "id", id, now);
}

/** Ends every Session a token started, as when it is revoked. */
export async function endAgentSessionsOfToken(db: Queryable, tokenId: string, now: Date): Promise<ClaimHolders> {
  return endSessions(db, "token_id", tokenId, now);
}

/** Ends every Session of an Agent, as when it is removed. */
export async function endAgentSessionsOf(db: Queryable, agentId: string, now: Date): Promise<ClaimHolders> {
  return endSessions(db, "agent_id", agentId, now);
}

/** The live Sessions of each of these Agents, oldest first. */
export async function liveAgentSessions(db: Queryable, agentIds: string[], now: Date): Promise<Map<string, AgentSession[]>> {
  const { rows } = await db.query<AgentSessionRow>(
    `SELECT s.*, w.silence_threshold_seconds FROM agent_sessions s ${WITH_WORKSPACE}
     WHERE s.agent_id = ANY($1::uuid[]) AND ${isLiveAt("$2")} ORDER BY s.started_at, s.id`,
    [agentIds, now],
  );
  const byAgent = new Map<string, AgentSession[]>(agentIds.map((id) => [id, []]));
  for (const row of rows) byAgent.get(row.agent_id)!.push(toAgentSession(row));
  return byAgent;
}

/** What the Agents page shows of a live Session, to notice when it changes: its Agent's Owner, when it would fall silent, and its Claims. */
export interface SessionLook {
  ownerId: string;
  endsIfSilentAt: number;
  /** The ids of the Tickets it holds the Claims on, in order. */
  claims: string;
}

/** Every live Session at `now`, by id, as the Agents page shows it (see `SessionLook`). */
export async function lookAtLiveAgentSessions(db: Queryable, now: Date): Promise<Map<string, SessionLook>> {
  const { rows } = await db.query<{ id: string; owner_id: string; last_seen_at: Date; silence_threshold_seconds: number; claims: string }>(
    `SELECT s.id, a.owner_id, s.last_seen_at, w.silence_threshold_seconds,
            COALESCE(string_agg(t.id::text, ',' ORDER BY t.id), '') AS claims
     FROM agent_sessions s ${WITH_WORKSPACE} LEFT JOIN tickets t ON t.claim_session_id = s.id
     WHERE ${isLiveAt("$1")} GROUP BY s.id, a.owner_id, w.silence_threshold_seconds`,
    [now],
  );
  return new Map(
    rows.map((r) => [
      r.id,
      { ownerId: r.owner_id, endsIfSilentAt: r.last_seen_at.getTime() + r.silence_threshold_seconds * 1000, claims: r.claims },
    ]),
  );
}

/**
 * The Owners whose live Sessions differ between two looks: one started, ended or fell silent,
 * gained or lost a Claim, or would fall silent at another time.
 */
export function ownersWithChangedSessions(before: Map<string, SessionLook>, after: Map<string, SessionLook>): Set<string> {
  const owners = new Set<string>();
  for (const [id, was] of before) {
    const is = after.get(id);
    if (!is || is.endsIfSilentAt !== was.endsIfSilentAt || is.claims !== was.claims) owners.add(was.ownerId);
  }
  for (const [id, is] of after) if (!before.has(id)) owners.add(is.ownerId);
  return owners;
}
