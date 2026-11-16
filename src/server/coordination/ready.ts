import type pg from "pg";
import type { AgentActor } from "../actor.js";
import type { AppContext } from "../context.js";
import { transaction, type Queryable } from "../db/database.js";
import { visibleProjects } from "../identity/access.js";
import { listAgents } from "../identity/agents.js";
import type { LiveEvent } from "../live/live-updates.js";
import { agentTopic } from "../live/topics.js";
import { findProjectById, listProjects } from "../work/projects.js";
import { listRelations } from "../work/relations.js";
import { visibleRelations } from "../work/ticket-reads.js";
import { FINISHED_CATEGORIES } from "../../shared/values.js";
import { findTicketsByIds, type Ticket } from "../work/tickets.js";
import { findDelegatedTicketsInTheClear, findLiveClaim, type ReadyScope } from "./claims.js";
import { ticketsChanged } from "../work/ticket-changes.js";

/**
 * Telling an Agent when a Ticket becomes Ready for it (delegated to it, unblocked, its Claim
 * released or lapsed, or its Project opened up to it by an access or archive change), through its
 * live Agent Sessions' event stream, as a `ticketReady` event.
 *
 * A route that may make Tickets Ready asks which of them already are (`readyNow`) inside its
 * transaction, before changing anything, and after it commits passes that answer to
 * `tellNewlyReady`, which tells each Delegate of the Tickets that are Ready for it only now.
 */

/** Where the Agent looks for Ready Tickets: the unarchived Projects it may write in. */
export async function readyScope(db: Queryable, agent: AgentActor): Promise<ReadyScope> {
  const projects = await visibleProjects(db, agent, await listProjects(db, agent.owner.workspaceId, false));
  return { agentId: agent.agent.id, projectIds: projects.filter((p) => p.access === "write").map((p) => p.id) };
}

/**
 * Why `ticket`, which isn't Ready for the Agent at `now` (`isTicketReady`), isn't, as a refusal
 * to Claim it reads. Only explains: whether a Ticket is Ready is `isTicketReady`'s to say.
 */
export async function whyNotReady(db: Queryable, agent: AgentActor, scope: ReadyScope, ticket: Ticket, now: Date): Promise<string> {
  if (ticket.discovered && ticket.delegate === null) return `${ticket.key} is a Discovered Ticket waiting for a User to delegate it`;
  if (ticket.delegate?.id !== agent.agent.id) return `${ticket.key} isn't delegated to ${agent.agent.name}`;
  if (FINISHED_CATEGORIES.includes(ticket.status.category)) return `${ticket.key} is ${ticket.status.name}, so there is nothing left to work on`;
  if (ticket.status.category === "in_review") return `${ticket.key} is ${ticket.status.name}, waiting until a User Sends it back`;
  if (!scope.projectIds.includes(ticket.projectId)) {
    const project = await findProjectById(db, ticket.projectId);
    if (project?.archived) return `${ticket.key} is in the archived Project ${project.key}`;
    return `${agent.agent.name} may not work in ${ticket.projectKey}`;
  }
  const blockers = (await listRelations(db, ticket.id)).blockedBy.filter((b) => !FINISHED_CATEGORIES.includes(b.status.category));
  if (blockers.length > 0) {
    const visible = (await visibleRelations(db, agent, { blocks: [], blockedBy: blockers, relatesTo: [] })).blockedBy.map((b) => b.key);
    const hidden = blockers.length - visible.length;
    const named = [...visible, ...(hidden > 0 ? [`${hidden} Ticket${hidden === 1 ? "" : "s"} you can't see`] : [])];
    const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
    return `${ticket.key} is blocked by ${list}, which ${blockers.length === 1 ? "isn't" : "aren't"} finished`;
  }
  if (await findLiveClaim(db, ticket.id, now)) return `${ticket.key} is Claimed by another Agent Session`;
  return `${ticket.key} isn't Ready`;
}

/** Which of these Tickets are Ready for their Delegate at `now`, as a map from Ticket id to Agent id. */
export async function readyNow(db: Queryable, ticketIds: string[], now: Date): Promise<Map<string, string>> {
  const ready = new Map<string, string>();
  if (ticketIds.length === 0) return ready;
  const clear = await findDelegatedTicketsInTheClear(db, ticketIds, now);
  // Each Delegate's scope, as one of its tokens that may write sees it.
  const scopes = new Map<string, Promise<ReadyScope | undefined>>();
  const scopeOf = (agentId: string, workspaceId: string) => {
    let scope = scopes.get(agentId);
    if (!scope) {
      scope = listAgents(db, workspaceId).then((agents) => {
        const found = agents.find((a) => a.agent.id === agentId);
        if (!found?.owner.active) return undefined;
        return readyScope(db, { kind: "agent", session: null, tokenId: "", readOnly: false, ...found });
      });
      scopes.set(agentId, scope);
    }
    return scope;
  };
  for (const t of clear) {
    if ((await scopeOf(t.delegateId, t.workspaceId))?.projectIds.includes(t.projectId)) ready.set(t.ticketId, t.delegateId);
  }
  return ready;
}

/** The ids of the Tickets that any of these block. */
export async function ticketsBlockedBy(db: Queryable, ticketIds: string[]): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("SELECT DISTINCT to_ticket_id AS id FROM ticket_relations WHERE kind = 'blocks' AND from_ticket_id = ANY($1::uuid[])", [
    ticketIds,
  ]);
  return rows.map((r) => r.id);
}

/** A Ticket as the welcome and a `ticketReady` event list it: what the Agent needs to pick it. */
export const readyTicket = (t: Ticket) => ({ key: t.key, title: t.title, priority: t.priority, status: t.status, autonomous: t.autonomous });

/** The `ticketReady` event telling an Agent that `ticket` became Ready for it. */
export const readyEvent = (ticket: Ticket): LiveEvent => ({ event: "ticketReady", data: { ticket: readyTicket(ticket) } });

/**
 * Tells each Delegate of these Tickets which of them are Ready for it now but weren't in
 * `before` (what `readyNow` answered before the change). Call once the change is committed.
 * Telling is a courtesy, as the next welcome lists Ready Tickets anyway, so failing to check
 * never fails the change that was already made.
 */
export async function tellNewlyReady(ctx: AppContext, ticketIds: string[], before: Map<string, string>): Promise<void> {
  try {
    const after = await readyNow(ctx.db, ticketIds, ctx.clock.now());
    const fresh = [...after].filter(([ticketId, agentId]) => before.get(ticketId) !== agentId);
    if (fresh.length === 0) return;
    const tickets = new Map((await findTicketsByIds(ctx.db, fresh.map(([id]) => id))).map((t) => [t.id, t]));
    for (const [ticketId, agentId] of fresh) {
      const ticket = tickets.get(ticketId);
      if (ticket) ctx.live.publish(agentTopic(agentId), readyEvent(ticket));
    }
  } catch {
    // Nothing to undo: the change stands, and the Agent's next welcome lists what is Ready.
  }
}

/**
 * Tells the watchers of these Tickets that their live Claims ended (released, lapsed, or ended
 * with their Agent Session), and their Delegates which of them are now Ready. Being Claimed,
 * none of them was Ready before. Call once the change is committed.
 */
export async function claimsEnded(ctx: AppContext, ticketIds: string[]): Promise<void> {
  if (ticketIds.length === 0) return;
  ticketsChanged(ctx.live, await findTicketsByIds(ctx.db, ticketIds));
  await tellNewlyReady(ctx, ticketIds, new Map());
}

/**
 * The delegated Tickets an access or archive change can make Ready: those in a Project, those
 * delegated to one of a User's Agents, or, for the User's access in one Project, both at once.
 */
export type AffectedTickets = { projectId: string; ownerId?: string } | { projectId?: undefined; ownerId: string };

/** The ids of the delegated Tickets `affected` describes. */
async function delegatedTicketIds(db: Queryable, affected: AffectedTickets): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.id FROM tickets t JOIN agents a ON a.id = t.delegate_id
     WHERE ($1::uuid IS NULL OR t.project_id = $1) AND ($2::uuid IS NULL OR a.owner_id = $2)`,
    [affected.projectId ?? null, affected.ownerId ?? null],
  );
  return rows.map((r) => r.id);
}

/**
 * Makes an access or archive change in a transaction, then tells the Delegates of the Tickets
 * `affected` describes which of them the change made Ready. A change that can't make anything
 * Ready (archiving, lowering access) passes no `affected`, and only runs. Returns what `change` returns.
 */
export async function tellReadyAfter<T>(ctx: AppContext, affected: AffectedTickets | undefined, change: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!affected) return transaction(ctx.db, change);
  const { result, ticketIds, before } = await transaction(ctx.db, async (tx) => {
    const ticketIds = await delegatedTicketIds(tx, affected);
    const before = await readyNow(tx, ticketIds, ctx.clock.now());
    return { result: await change(tx), ticketIds, before };
  });
  await tellNewlyReady(ctx, ticketIds, before);
  return result;
}
