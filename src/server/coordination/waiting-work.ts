import type { Actor, AgentActor } from "../actor.js";
import { actingUser } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { agentReading, canRead } from "../identity/access.js";
import { listAgents, type Agent } from "../identity/agents.js";
import type { User } from "../identity/users.js";
import { findCommentsByIds, publicComment, type Comment, type CommentOn } from "../conversation/comments.js";
import { WAITING_REASONS, type WaitingReason } from "../../shared/values.js";

export type { WaitingReason };

/**
 * Work waiting for an Agent (ADR 0005): Cronk never starts an Agent, so when a Comment
 * concerns one, Cronk marks it as waiting for that Agent. It is listed in the welcome of the
 * Agent's next Agent Session, which takes it, and pushed to the Agent's live Agent Sessions.
 */

/** One Agent a Comment now waits for, and why. */
export interface WaitingFor {
  agentId: string;
  reason: WaitingReason;
}

/** A Comment waiting for an Agent, with why and what it is on. */
export interface WaitingWork {
  reason: WaitingReason;
  comment: ReturnType<typeof publicComment>;
  ticket: CommentOn["ticket"];
  document: CommentOn["document"];
}

/** Where a Comment was posted, as deciding who it waits for needs it. */
export interface CommentPlace {
  /** Null for a Workspace Document. */
  projectId: string | null;
  /** The Delegate of the Ticket it is on, if any. */
  delegateId: string | null;
}

/**
 * The @mentions in a Comment's Markdown: each `@name` not preceded by a word character, where
 * the name runs of letters, digits, `_`, `-` and inner dots. Lower-cased, without repeats.
 */
export function mentionedNames(body: string): string[] {
  const names = [...body.matchAll(/(?<![\w@])@([\w-]+(?:\.[\w-]+)*)/gu)].map((m) => m[1]!.toLowerCase());
  return [...new Set(names)];
}

/**
 * The Agents the writer `writerId` means by each mentioned name: their own Agent of that name
 * if they have one, otherwise every other Owner's Agent of that name.
 */
function mentionedAgents(agents: { agent: Agent; owner: User }[], writerId: string, names: string[]): string[] {
  return names.flatMap((name) => {
    const named = agents.filter((a) => a.agent.name.toLowerCase() === name);
    const own = named.filter((a) => a.owner.id === writerId);
    return (own.length > 0 ? own : named).map((a) => a.agent.id);
  });
}

/**
 * Marks `comment`, posted by `actor` at `place`, as waiting for each Agent it concerns: the
 * Agent whose question it answers (`answered`), every Agent it @mentions by name, and the
 * Delegate of the Ticket it is on. Never for the Agent that posted it, and only for Agents
 * that can see where it was posted. Returns the Agents it now waits for, and why.
 */
export async function markWaiting(
  db: Queryable,
  actor: Actor,
  comment: Comment,
  place: CommentPlace,
  answered: { agentId: string } | null,
  at: Date,
): Promise<WaitingFor[]> {
  const agents = await listAgents(db, actingUser(actor).workspaceId);
  const candidates: Record<WaitingReason, string[]> = {
    answer: answered ? [answered.agentId] : [],
    mention: mentionedAgents(agents, actingUser(actor).id, mentionedNames(comment.body)),
    comment: place.delegateId ? [place.delegateId] : [],
  };
  const poster = actor.kind === "agent" ? actor.agent.id : null;
  const marked = new Map<string, WaitingReason>();
  // A Comment waits for an Agent for the first reason that applies, in precedence order.
  for (const reason of WAITING_REASONS) {
    for (const agentId of candidates[reason]) if (agentId !== poster && !marked.has(agentId)) marked.set(agentId, reason);
  }
  const waiting: WaitingFor[] = [];
  for (const [agentId, reason] of marked) {
    const found = agents.find((a) => a.agent.id === agentId);
    if (!found?.owner.active) continue;
    if (!(await canRead(db, agentReading(found.agent, found.owner), place.projectId))) continue;
    await db.query("INSERT INTO waiting_work (agent_id, comment_id, reason, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [
      agentId,
      comment.id,
      reason,
      at,
    ]);
    waiting.push({ agentId, reason });
  }
  return waiting;
}

/**
 * The work waiting for the Agent, oldest first, for the welcome of its Agent Session
 * `sessionId`, leaving out what the Agent can't see right now (it keeps waiting until it can).
 * A full token's welcome takes what it lists, so it no longer waits; a read-only token, which
 * can't act on it, leaves it waiting.
 */
export async function takeWaitingWork(db: Queryable, agent: AgentActor, sessionId: string, now: Date): Promise<WaitingWork[]> {
  const { rows } = await db.query<{ comment_id: string; reason: WaitingReason }>(
    "SELECT comment_id, reason FROM waiting_work WHERE agent_id = $1 AND taken_at IS NULL",
    [agent.agent.id],
  );
  const work = await waitingWorkFor(db, agent, rows.map((r) => ({ commentId: r.comment_id, reason: r.reason })));
  if (!agent.readOnly && work.length > 0) {
    await db.query(
      "UPDATE waiting_work SET taken_at = $2, taken_by_session_id = $3 WHERE agent_id = $1 AND comment_id = ANY($4) AND taken_at IS NULL",
      [agent.agent.id, now, sessionId, work.map((w) => w.comment.id)],
    );
  }
  return work;
}

/** The waiting work for these Comments, in the order they were posted, leaving out those `agent` can't see. */
export async function waitingWorkFor(db: Queryable, agent: AgentActor, items: { commentId: string; reason: WaitingReason }[]): Promise<WaitingWork[]> {
  const reasons = new Map(items.map((i) => [i.commentId, i.reason]));
  const comments = await findCommentsByIds(db, [...reasons.keys()]);
  const work: WaitingWork[] = [];
  for (const { comment, on } of comments) {
    if (!(await canRead(db, agent, on.projectId))) continue;
    work.push({
      reason: reasons.get(comment.id)!,
      comment: publicComment(comment),
      ticket: on.ticket,
      document: on.document,
    });
  }
  return work;
}
