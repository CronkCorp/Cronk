import type { Actor, AgentActor } from "../actor.js";
import { actingUser } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { requireProjectAccess, requireWorkspaceAccess } from "../identity/access.js";
import { listAgents } from "../identity/agents.js";
import { findProjectById } from "../work/projects.js";
import { findCommentsByIds, publicComment, type Comment } from "../conversation/comments.js";

/**
 * Work waiting for an Agent (ADR 0005): Cronk never starts an Agent, so when a Comment
 * concerns one, Cronk marks it as waiting for that Agent. It is listed in the welcome of the
 * Agent's next Agent Session, which takes it, and pushed to the Agent's connected Sessions.
 */

/** Why a Comment waits for an Agent: it answers the Agent's question, @mentions it, or is on a Ticket delegated to it. */
export type WaitingReason = "answer" | "mention" | "comment";

/** The reasons in order of precedence: a Comment waits for an Agent for the first that applies. */
const REASONS: WaitingReason[] = ["answer", "mention", "comment"];

/** A Comment waiting for an Agent, with why and what it is on. */
export interface WaitingWork {
  reason: WaitingReason;
  comment: ReturnType<typeof publicComment>;
  ticket: { key: string; title: string } | null;
  document: { id: string; title: string } | null;
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
): Promise<{ agentId: string; reason: WaitingReason }[]> {
  const agents = await listAgents(db, actingUser(actor).workspaceId);
  const mentioned = new Set(mentionedNames(comment.body));
  const candidates: Record<WaitingReason, string[]> = {
    answer: answered ? [answered.agentId] : [],
    mention: agents.filter((a) => mentioned.has(a.agent.name.toLowerCase())).map((a) => a.agent.id),
    comment: place.delegateId ? [place.delegateId] : [],
  };
  const poster = actor.kind === "agent" ? actor.agent.id : null;
  const marked = new Map<string, WaitingReason>();
  for (const reason of REASONS) {
    for (const agentId of candidates[reason]) if (agentId !== poster && !marked.has(agentId)) marked.set(agentId, reason);
  }
  const waiting: { agentId: string; reason: WaitingReason }[] = [];
  for (const [agentId, reason] of marked) {
    const found = agents.find((a) => a.agent.id === agentId);
    if (!found?.owner.active) continue;
    const agent: AgentActor = { kind: "agent", session: null, tokenId: "", readOnly: true, agent: found.agent, owner: found.owner };
    if (!(await canSee(db, agent, place.projectId))) continue;
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

/** Whether `agent` can read in the Project with this id, or in the Workspace when it is null. */
async function canSee(db: Queryable, agent: AgentActor, projectId: string | null): Promise<boolean> {
  try {
    if (projectId === null) await requireWorkspaceAccess(db, agent, "read");
    else await requireProjectAccess(db, agent, (await findProjectById(db, projectId))!, "read");
    return true;
  } catch (err) {
    if (err instanceof HttpError) return false;
    throw err;
  }
}

/**
 * Takes the work waiting for the Agent, oldest first, for its Agent Session `sessionId`'s
 * welcome: once taken it no longer waits. Leaves out what the Agent can no longer see.
 */
export async function takeWaitingWork(db: Queryable, agent: AgentActor, sessionId: string, now: Date): Promise<WaitingWork[]> {
  const { rows } = await db.query<{ comment_id: string; reason: WaitingReason }>(
    `UPDATE waiting_work SET taken_at = $2, taken_by_session_id = $3 WHERE agent_id = $1 AND taken_at IS NULL
     RETURNING comment_id, reason, seq`,
    [agent.agent.id, now, sessionId],
  );
  return waitingWorkFor(db, agent, rows.map((r) => ({ commentId: r.comment_id, reason: r.reason })));
}

/** The waiting work for these Comments, in the order they were posted, leaving out those `agent` can't see. */
export async function waitingWorkFor(db: Queryable, agent: AgentActor, items: { commentId: string; reason: WaitingReason }[]): Promise<WaitingWork[]> {
  const reasons = new Map(items.map((i) => [i.commentId, i.reason]));
  const comments = await findCommentsByIds(db, [...reasons.keys()]);
  const work: WaitingWork[] = [];
  for (const { comment, on } of comments) {
    if (!(await canSee(db, agent, on.projectId))) continue;
    work.push({
      reason: reasons.get(comment.id)!,
      comment: publicComment(comment),
      ticket: on.ticket,
      document: on.document,
    });
  }
  return work;
}
