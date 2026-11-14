import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
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

/** An @mention of an Agent: its name, and the name of the Owner it picks, if it picks one. Both lower-cased. */
export interface Mention {
  owner: string | null;
  name: string;
}

/**
 * The @mentions in a Comment's Markdown, without repeats: each `@name` or `@owner/name` not
 * preceded by a word character. A bare name runs of letters, digits, `_`, `-` and inner dots;
 * a name that contains anything else, such as spaces, goes in double quotes: `@"claude laptop"`.
 * Mentions inside code spans, code blocks and block quotes don't count.
 */
export function mentionsIn(body: string): Mention[] {
  const part = String.raw`"([^"\n]+)"|([\w-]+(?:\.[\w-]+)*)`;
  const pattern = new RegExp(String.raw`(?<![\w@])@(?:(?:${part})/)?(?:${part})`, "gu");
  const seen = new Map<string, Mention>();
  for (const m of proseOf(fromMarkdown(body)).matchAll(pattern)) {
    const owner = m[1] ?? m[2];
    const mention = { owner: owner?.trim().toLowerCase() ?? null, name: (m[3] ?? m[4])!.trim().toLowerCase() };
    seen.set(JSON.stringify(mention), mention);
  }
  return [...seen.values()];
}

/** Markdown nodes whose text is never prose: code, quotes of someone else, and raw HTML. */
const NOT_PROSE = new Set(["code", "inlineCode", "blockquote", "html"]);

/** Markdown nodes whose children run together on one line. */
const INLINE = new Set(["paragraph", "heading", "tableCell", "emphasis", "strong", "delete", "link", "linkReference"]);

/** The prose text of Markdown `node`, leaving out code and quotes; blocks go on lines of their own. */
function proseOf(node: Nodes): string {
  if (NOT_PROSE.has(node.type)) return " ";
  if (node.type === "text") return node.value;
  if (!("children" in node)) return "";
  return node.children.map(proseOf).join(INLINE.has(node.type) ? "" : "\n");
}

/**
 * The Agents the writer `writerId` means by each mention. `@owner/name` is that Owner's Agent
 * of that name. `@name` is the writer's own Agent of that name if they have one, otherwise
 * every other Owner's Agent of that name.
 */
function mentionedAgents(agents: { agent: Agent; owner: User }[], writerId: string, mentions: Mention[]): string[] {
  return mentions.flatMap(({ owner, name }) => {
    const named = agents.filter((a) => a.agent.name.toLowerCase() === name);
    if (owner !== null) return named.filter((a) => a.owner.name.toLowerCase() === owner).map((a) => a.agent.id);
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
    mention: mentionedAgents(agents, actingUser(actor).id, mentionsIn(comment.body)),
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
