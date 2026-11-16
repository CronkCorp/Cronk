import type { AgentActor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { FINISHED_CATEGORIES, PRIORITIES, WORKABLE_CATEGORIES } from "../../shared/values.js";
import { ticketKeySql, type AgentRef, type Ticket } from "../work/tickets.js";
import { isLiveAt, silenceWindow, WITH_WORKSPACE } from "./agent-sessions.js";

/**
 * An Agent Session's exclusive, temporary hold on a Ticket. A Ticket stores at most one
 * (its `claim_session_id`), and the Claim is live exactly while its Agent Session is: every
 * call in the Session refreshes both, and both lapse once the Session stays silent longer
 * than the Workspace's silence threshold. Lapsing keeps the Ticket's Delegate.
 */
export interface Claim {
  agent: AgentRef;
  session: { id: string };
  claimedAt: Date;
  /** When its Agent Session was last heard from: its last call, or its open stream's last heartbeat. */
  lastSeenAt: Date;
  /** When the Claim lapses if its Agent Session stays silent until then. */
  endsIfSilentAt: Date;
}

interface ClaimRow {
  claim_id: string;
  agent_id: string;
  agent_name: string;
  session_id: string;
  claimed_at: Date;
  last_seen_at: Date;
  silence_threshold_seconds: number;
}

/** The Ticket's live Claim, if it has one at `now`. */
export async function findLiveClaim(db: Queryable, ticketId: string, now: Date): Promise<Claim | undefined> {
  return (await findLiveClaimWithId(db, ticketId, now))?.claim;
}

/**
 * The Ticket's live Claim at `now` with its id, which Reports written in it record. Each Claim gets
 * a new id, so Claiming again after a release is a new Claim.
 */
async function findLiveClaimWithId(db: Queryable, ticketId: string, now: Date): Promise<{ id: string; claim: Claim } | undefined> {
  const { rows } = await db.query<ClaimRow>(
    `SELECT t.claim_id, a.id AS agent_id, a.name AS agent_name, s.id AS session_id, t.claimed_at, s.last_seen_at, w.silence_threshold_seconds
     FROM tickets t JOIN agent_sessions s ON s.id = t.claim_session_id ${WITH_WORKSPACE}
     WHERE t.id = $1 AND ${isLiveAt("$2")}`,
    [ticketId, now],
  );
  const row = rows[0];
  return (
    row && {
      id: row.claim_id,
      claim: {
        agent: { id: row.agent_id, name: row.agent_name },
        session: { id: row.session_id },
        claimedAt: row.claimed_at,
        ...silenceWindow(row),
      },
    }
  );
}

/**
 * Gives the Session `sessionId` the Ticket's Claim, replacing any lapsed one. Callers check
 * first, with the Ticket locked, that no other Session holds a live Claim. Claiming again
 * from the same Session keeps the original time.
 */
export async function setClaim(db: Queryable, ticketId: string, sessionId: string, now: Date): Promise<void> {
  await db.query(
    `UPDATE tickets SET claim_session_id = $2, claimed_at = $3, claim_id = gen_random_uuid() WHERE id = $1 AND claim_session_id IS DISTINCT FROM $2`,
    [ticketId, sessionId, now],
  );
}

/** The Claims live at `now`, as a map from Ticket id to the id of the Agent Session holding it. */
export async function listLiveClaims(db: Queryable, now: Date): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; session_id: string }>(
    `SELECT t.id, s.id AS session_id FROM tickets t JOIN agent_sessions s ON s.id = t.claim_session_id ${WITH_WORKSPACE} WHERE ${isLiveAt("$1")}`,
    [now],
  );
  return new Map(rows.map((r) => [r.id, r.session_id]));
}

/** A Ticket an Agent Session holds the Claim on, as the Agents list shows it. */
export interface ClaimedTicket {
  ticketKey: string;
  title: string;
  projectId: string;
}

/**
 * The Tickets each of these Agent Sessions holds the Claim on, in key order. Pass only live Sessions:
 * a Claim is live exactly while its Session is.
 */
export async function listClaimsOfSessions(db: Queryable, sessionIds: string[]): Promise<Map<string, ClaimedTicket[]>> {
  const { rows } = await db.query<{ session_id: string; ticket_key: string; title: string; project_id: string }>(
    `SELECT t.claim_session_id AS session_id, ${ticketKeySql("p", "t")} AS ticket_key, t.title, t.project_id
     FROM tickets t JOIN projects p ON p.id = t.project_id
     WHERE t.claim_session_id = ANY($1::uuid[]) ORDER BY p.key, t.number`,
    [sessionIds],
  );
  const bySession = new Map<string, ClaimedTicket[]>(sessionIds.map((id) => [id, []]));
  for (const row of rows) bySession.get(row.session_id)!.push({ ticketKey: row.ticket_key, title: row.title, projectId: row.project_id });
  return bySession;
}

/**
 * How many unfinished Tickets each of these Agents is Delegate on, per Agent and then per Project, so
 * callers can leave out the Projects they can't read.
 */
export async function countDelegatedTickets(db: Queryable, agentIds: string[]): Promise<Map<string, Map<string, number>>> {
  const { rows } = await db.query<{ delegate_id: string; project_id: string; count: number }>(
    `SELECT t.delegate_id, t.project_id, count(*)::int AS count FROM tickets t JOIN statuses s ON s.id = t.status_id
     WHERE t.delegate_id = ANY($1::uuid[]) AND s.category NOT IN ${FINISHED} GROUP BY t.delegate_id, t.project_id`,
    [agentIds],
  );
  const byAgent = new Map<string, Map<string, number>>(agentIds.map((id) => [id, new Map()]));
  for (const row of rows) byAgent.get(row.delegate_id)!.set(row.project_id, row.count);
  return byAgent;
}

/**
 * The Tickets whose Claims lapsed since the last look, at `since`, when `claims` (Ticket id to
 * Agent Session id) were live: the Ticket still names the Session, which nobody ended, and it
 * is no longer live at `now`, having been live at `since` or having lapsed after it. Claims
 * released, or whose Session was ended, are left out, as is any taken by another Session since.
 */
export async function findLapsedClaims(db: Queryable, claims: Map<string, string>, since: Date, now: Date): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.id FROM tickets t JOIN agent_sessions s ON s.id = t.claim_session_id ${WITH_WORKSPACE}
     WHERE s.ended_at IS NULL AND NOT (${isLiveAt("$4")})
       AND (s.last_seen_at > $3::timestamptz - make_interval(secs => w.silence_threshold_seconds)
            OR (t.id, s.id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[])))`,
    [[...claims.keys()], [...claims.values()], since, now],
  );
  return rows.map((r) => r.id);
}

/** Drops the Ticket's Claim, as when it is released or its Delegate changes. */
export async function clearClaim(db: Queryable, ticketId: string): Promise<void> {
  await db.query("UPDATE tickets SET claim_session_id = NULL, claimed_at = NULL, claim_id = NULL WHERE id = $1", [ticketId]);
}

/** SQL condition: the Ticket `t` has a live Claim at the time in the parameter `nowParam`. */
const hasLiveClaim = (nowParam: string) => `EXISTS (
  SELECT 1 FROM agent_sessions cs JOIN agents ca ON ca.id = cs.agent_id JOIN workspaces cw ON cw.id = ca.workspace_id
  WHERE cs.id = t.claim_session_id AND ${isLiveAt(nowParam, { session: "cs", workspace: "cw" })})`;

/** SQL list of the finished Status Categories, for `IN`. */
const FINISHED = `(${FINISHED_CATEGORIES.map((c) => `'${c}'`).join(", ")})`;

/** SQL list of the Status Categories of work an Agent can take up, for `IN`. */
const WORKABLE = `(${WORKABLE_CATEGORIES.map((c) => `'${c}'`).join(", ")})`;

/**
 * SQL condition: the Ticket `t`, in the Status `s`, is Ready for the Agent `agentParam` among the
 * Projects `projectsParam`: delegated to it, in a Backlog, Unstarted or Started Status, not blocked by an
 * unfinished Ticket, and without a live Claim.
 */
const isReady = (agentParam: string, projectsParam: string, nowParam: string) => `
  t.delegate_id = ${agentParam} AND t.project_id = ANY(${projectsParam}::uuid[]) AND ${hasNothingInTheWay(nowParam)}`;

/**
 * SQL condition: nothing keeps the Ticket `t`, in the Status `s`, from being worked on: it isn't
 * In Review (waiting on a User) or finished, blocked or Claimed.
 */
const hasNothingInTheWay = (nowParam: string) => `
  s.category IN ${WORKABLE}
  AND NOT EXISTS (
    SELECT 1 FROM ticket_relations r JOIN tickets b ON b.id = r.from_ticket_id JOIN statuses bs ON bs.id = b.status_id
    WHERE r.kind = 'blocks' AND r.to_ticket_id = t.id AND bs.category NOT IN ${FINISHED})
  AND NOT ${hasLiveClaim(nowParam)}`;

/** Ready Tickets are offered highest Priority first, then oldest first. */
const READY_ORDER = `
  CASE t.priority ${PRIORITIES.map((p, i) => `WHEN '${p}' THEN ${i}`).join(" ")} END,
  t.created_at, t.number, t.id`;

/** Where an Agent looks for Ready Tickets: the Agent, and the Projects it may work in. */
export interface ReadyScope {
  agentId: string;
  projectIds: string[];
}

/** The ids of the Agent's Ready Tickets in the order they are offered, at most `limit` of them if given. */
export async function listReadyTicketIds(db: Queryable, scope: ReadyScope, now: Date, limit?: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.id FROM tickets t JOIN statuses s ON s.id = t.status_id WHERE ${isReady("$1", "$2", "$3")} ORDER BY ${READY_ORDER} LIMIT $4`,
    [scope.agentId, scope.projectIds, now, limit ?? null],
  );
  return rows.map((r) => r.id);
}

/**
 * Those of these Tickets that have a Delegate and nothing in their way (neither In Review nor
 * finished, unblocked, unclaimed at `now`), each with its Delegate, Project and Workspace: whether one is Ready for its
 * Delegate then rests only on the Delegate's access to the Project.
 */
export async function findDelegatedTicketsInTheClear(
  db: Queryable,
  ticketIds: string[],
  now: Date,
): Promise<{ ticketId: string; delegateId: string; projectId: string; workspaceId: string }[]> {
  const { rows } = await db.query<{ id: string; delegate_id: string; project_id: string; workspace_id: string }>(
    `SELECT t.id, t.delegate_id, t.project_id, p.workspace_id FROM tickets t JOIN statuses s ON s.id = t.status_id JOIN projects p ON p.id = t.project_id
     WHERE t.id = ANY($1::uuid[]) AND t.delegate_id IS NOT NULL AND ${hasNothingInTheWay("$2")}`,
    [ticketIds, now],
  );
  return rows.map((r) => ({ ticketId: r.id, delegateId: r.delegate_id, projectId: r.project_id, workspaceId: r.workspace_id }));
}

/** Whether the Ticket `ticketId` is Ready for the Agent at `now`. */
export async function isTicketReady(db: Queryable, scope: ReadyScope, ticketId: string, now: Date): Promise<boolean> {
  const { rowCount } = await db.query(`SELECT 1 FROM tickets t JOIN statuses s ON s.id = t.status_id WHERE t.id = $4 AND ${isReady("$1", "$2", "$3")}`, [
    scope.agentId,
    scope.projectIds,
    now,
    ticketId,
  ]);
  return rowCount !== 0;
}

/**
 * Claims the Agent's first Ready Ticket for the Session `sessionId` and returns its id;
 * undefined if none is Ready. Run inside a transaction.
 *
 * Each candidate is locked and then checked again in a fresh statement, which sees any Claim
 * committed before the lock was granted; a Ticket another call has locked is skipped. So two
 * Sessions never get the same Ticket. (Checking within the locking statement isn't enough:
 * Postgres re-checks a locked row's joins against the rows it first saw.)
 */
export async function claimNextReady(db: Queryable, scope: ReadyScope, sessionId: string, now: Date): Promise<string | undefined> {
  for (const id of await listReadyTicketIds(db, scope, now)) {
    const locked = await db.query("SELECT 1 FROM tickets WHERE id = $1 FOR UPDATE SKIP LOCKED", [id]);
    if (locked.rowCount === 0) continue;
    if (!(await isTicketReady(db, scope, id, now))) continue;
    await setClaim(db, id, sessionId, now);
    return id;
  }
  return undefined;
}

/**
 * Refuses an Agent unless it calls within the Agent Session holding the Ticket's live Claim (a 409),
 * and returns that Claim's id. `refusedAction` completes the refusal "Claim CRONK-1 in your Agent
 * Session before …", such as "moving it".
 */
export async function requireClaimHolder(db: Queryable, agent: AgentActor, ticket: Ticket, now: Date, refusedAction: string): Promise<string> {
  const held = await findLiveClaimWithId(db, ticket.id, now);
  if (!held || !agent.session || held.claim.session.id !== agent.session.id) {
    throw new HttpError(409, `Claim ${ticket.key} in your Agent Session before ${refusedAction}`);
  }
  return held.id;
}
