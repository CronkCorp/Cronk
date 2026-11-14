import type { Nodes } from "mdast";
import type { LiveEvent } from "../live/live-updates.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Actor, AgentActor } from "../actor.js";
import { actingUser } from "../actor.js";
import { lockUntilCommit, type Queryable } from "../db/database.js";
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
  /** Its position in the order work starts waiting, which only grows; its stream event's id. */
  seq: string;
}

/** A Comment waiting for an Agent, with why and what it is on. */
export interface WaitingWork {
  reason: WaitingReason;
  comment: ReturnType<typeof publicComment>;
  ticket: CommentOn["ticket"];
  document: CommentOn["document"];
}

/** The `waiting` event that pushes `work` to the Agent's live Agent Sessions, with its position as the event's id. */
export function waitingEvent(seq: string, work: WaitingWork): LiveEvent {
  return { event: "waiting", id: seq, data: { waiting: work } };
}

/** Where a Comment was posted, as deciding who it waits for needs it. */
export interface CommentPlace {
  /** Null for a Workspace Document. */
  projectId: string | null;
  /** The Delegate of the Ticket it is on, if any. */
  delegateId: string | null;
}

/** An @mention of an Agent: its name, and the name of the Owner it picks, if it picks one. Both lower-cased. */
interface Mention {
  owner: string | null;
  name: string;
}

/** A letter, mark, digit or `_`, in any script. */
const WORD = String.raw`[\p{L}\p{M}\p{N}_]`;

/** One name in a mention, captured in `quoted` or `bare`: `"anything but quotes"`, or word characters and `-` with inner dots. */
const namePart = (group: string) => String.raw`"(?<${group}Quoted>[^"\n]+)"|(?<${group}Bare>(?:${WORD}|-)+(?:\.(?:${WORD}|-)+)*)`;

/** `@name` or `@owner/name`, not preceded by a word character or another `@`. */
const MENTION = new RegExp(String.raw`(?<!${WORD}|@)@(?:(?:${namePart("owner")})/)?(?:${namePart("name")})`, "gu");

/**
 * The @mentions in a Comment's Markdown, without repeats: each `@name` or `@owner/name` not
 * preceded by a word character. A bare name runs of letters, digits, `_`, `-` and inner dots;
 * a name that contains anything else, such as spaces, goes in double quotes: `@"claude laptop"`.
 * Mentions inside code spans, code blocks and block quotes don't count.
 */
function mentionsIn(body: string): Mention[] {
  const seen = new Map<string, Mention>();
  for (const { groups } of proseOf(fromMarkdown(body)).matchAll(MENTION)) {
    const owner = groups!.ownerQuoted ?? groups!.ownerBare;
    const name = (groups!.nameQuoted ?? groups!.nameBare)!;
    const mention = { owner: owner?.trim().toLowerCase() ?? null, name: name.trim().toLowerCase() };
    seen.set(JSON.stringify(mention), mention);
  }
  return [...seen.values()];
}

/** Markdown nodes whose text is never prose: code, quotes of someone else, and raw HTML. */
const NOT_PROSE = new Set(["code", "inlineCode", "blockquote", "html"]);

/** Markdown nodes whose children run together on one line. */
const INLINE = new Set(["paragraph", "heading", "emphasis", "strong", "link", "linkReference"]);

/** The prose text of Markdown `node`, leaving out code and quotes; blocks and hard breaks start new lines. */
function proseOf(node: Nodes): string {
  if (NOT_PROSE.has(node.type)) return " ";
  if (node.type === "text") return node.value;
  if (node.type === "break") return "\n";
  if (!("children" in node)) return "";
  return node.children.map(proseOf).join(INLINE.has(node.type) ? "" : "\n");
}

/**
 * The Agents `actor` means by each mention. `@owner/name` is that Owner's Agent of that name.
 * `@name` is the writer's own Agent of that name if they have one, otherwise every other
 * Owner's Agent of that name. The writer is the posting User, or the posting Agent's Owner;
 * an Agent never means itself.
 */
function mentionedAgents(agents: { agent: Agent; owner: User }[], actor: Actor, mentions: Mention[]): string[] {
  const writerId = actingUser(actor).id;
  const poster = actor.kind === "agent" ? actor.agent.id : null;
  return mentions.flatMap(({ owner, name }) => {
    const named = agents.filter((a) => a.agent.name.toLowerCase() === name && a.agent.id !== poster);
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
    mention: mentionedAgents(agents, actor, mentionsIn(comment.body)),
    comment: place.delegateId ? [place.delegateId] : [],
  };
  const poster = actor.kind === "agent" ? actor.agent.id : null;
  const marked = new Map<string, WaitingReason>();
  // A Comment waits for an Agent for the first reason that applies, in precedence order.
  for (const reason of WAITING_REASONS) {
    for (const agentId of candidates[reason]) if (agentId !== poster && !marked.has(agentId)) marked.set(agentId, reason);
  }
  const concerned: [string, WaitingReason][] = [];
  for (const [agentId, reason] of marked) {
    const found = agents.find((a) => a.agent.id === agentId);
    if (!found?.owner.active) continue;
    if (await canRead(db, agentReading(found.agent, found.owner), place.projectId)) concerned.push([agentId, reason]);
  }
  // Posts concerning the same Agent take positions and commit one after another, so a position
  // is never passed by one still uncommitted (see `missedWaitingWork`). Other Agents' posts don't
  // wait. Locking in id order keeps two posts naming the same Agents from deadlocking.
  for (const agentId of concerned.map(([id]) => id).sort()) await lockUntilCommit(db, `waiting-work:${agentId}`);
  const waiting: WaitingFor[] = [];
  for (const [agentId, reason] of concerned) {
    const { rows } = await db.query<{ seq: string }>(
      "INSERT INTO waiting_work (agent_id, comment_id, reason, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING seq",
      [agentId, comment.id, reason, at],
    );
    if (rows[0]) waiting.push({ agentId, reason, seq: rows[0].seq });
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

/**
 * The work still waiting for the Agent that started waiting after position `afterSeq`, with
 * each one's position, in that order, leaving out what the Agent can't see right now: what a
 * stream reopened from `afterSeq` missed. Nothing is taken.
 *
 * Safe because an Agent's committed positions are never passed by an uncommitted one
 * (`markWaiting` serializes them per Agent): any work that commits later than position
 * `afterSeq` was seen has a higher position, so it is never skipped.
 */
export async function missedWaitingWork(db: Queryable, agent: AgentActor, afterSeq: string): Promise<{ seq: string; work: WaitingWork }[]> {
  const { rows } = await db.query<{ seq: string; comment_id: string; reason: WaitingReason }>(
    "SELECT seq, comment_id, reason FROM waiting_work WHERE agent_id = $1 AND taken_at IS NULL AND seq > $2 ORDER BY seq",
    [agent.agent.id, afterSeq],
  );
  const work = new Map((await waitingWorkFor(db, agent, rows.map((r) => ({ commentId: r.comment_id, reason: r.reason })))).map((w) => [w.comment.id, w]));
  return rows.filter((r) => work.has(r.comment_id)).map((r) => ({ seq: r.seq, work: work.get(r.comment_id)! }));
}

/**
 * The position of the work that last started waiting for the Agent, taken or not; "0" if none has.
 * Work for the Agent still uncommitted when this is read will have a higher position, as
 * `markWaiting` serializes it per Agent, so replaying from it skips nothing.
 */
export async function latestWaitingSeq(db: Queryable, agentId: string): Promise<string> {
  const { rows } = await db.query<{ seq: string | null }>("SELECT max(seq)::text AS seq FROM waiting_work WHERE agent_id = $1", [agentId]);
  return rows[0]?.seq ?? "0";
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
