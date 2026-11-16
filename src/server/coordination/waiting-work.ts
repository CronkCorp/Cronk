import type { Nodes } from "mdast";
import type { LiveEvent, LiveUpdates } from "../live/live-updates.js";
import { agentTopic } from "../live/topics.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Actor, AgentActor, RecordedActor } from "../actor.js";
import { actingUser } from "../actor.js";
import { lockUntilCommit, transaction, type Database, type Queryable } from "../db/database.js";
import { agentReading, canRead } from "../identity/access.js";
import { listAgents, type Agent } from "../identity/agents.js";
import type { User } from "../identity/users.js";
import { findCommentsByIds, publicComment, type Comment, type CommentOn } from "../conversation/comments.js";
import { WAITING_REASONS, type WaitingReason } from "../../shared/values.js";
import { findDecisionById, findDecisionVersion, type Decision, type DecisionVersion } from "../knowledge/decisions.js";
import { findSuggestionsByIds, type Suggestion } from "../knowledge/suggestions.js";

export type { WaitingReason };

/**
 * Work waiting for an Agent (ADR 0005): Cronk never starts an Agent, so when a Comment
 * concerns one, or a User rejects a Decision it proposed or a Suggestion it made, Cronk marks it as waiting for that
 * Agent. It is listed in the welcome of the Agent's next Agent Session, which takes it, and
 * pushed to the Agent's live Agent Sessions.
 */

/** One Agent a Comment now waits for, and why. */
export interface WaitingFor {
  agentId: string;
  reason: CommentWork["reason"];
  /** Its position in the order work starts waiting, which only grows; its stream event's id. */
  seq: string;
}

/** Work waiting for an Agent: a Comment, or the rejection of a Decision it proposed or of a Suggestion it made. */
export type WaitingWork = CommentWork | RejectionWork | SuggestionRejectionWork;

/** A Comment waiting for an Agent, with why and what it is on. */
export interface CommentWork {
  reason: Exclude<WaitingReason, "rejected" | "suggestion_rejected">;
  comment: ReturnType<typeof publicComment>;
  ticket: CommentOn["ticket"];
  document: CommentOn["document"];
}

/** A User's rejection of a Decision the Agent proposed, with their reason and the Ticket it came from. */
export interface RejectionWork {
  reason: "rejected";
  comment: null;
  decision: RejectedDecision;
  ticket: { key: string; title: string } | null;
  document: null;
}

/** A Decision as its rejection reaches the Agent that proposed it: the Version that rejected it. */
export interface RejectedDecision {
  key: string;
  title: string;
  /** Why the User rejected it. */
  reason: string;
  rejectedBy: RecordedActor;
  at: Date;
}

/** A User's rejection of a Suggestion the Agent made, with their reason and the Ticket it came from. */
export interface SuggestionRejectionWork {
  reason: "suggestion_rejected";
  comment: null;
  suggestion: {
    id: string;
    item: Pick<Suggestion["item"], "kind" | "id" | "key" | "title" | "projectKey">;
    /** Why the User rejected it. */
    reason: string;
    rejectedBy: RecordedActor;
    at: Date;
  };
  ticket: { key: string; title: string } | null;
  document: null;
}

/** The rejection of a rejected `suggestion` as Waiting Work. */
export function suggestionRejectionOf(suggestion: Suggestion): SuggestionRejectionWork {
  const { kind, id, key, title, projectKey } = suggestion.item;
  return {
    reason: "suggestion_rejected",
    comment: null,
    suggestion: {
      id: suggestion.id,
      item: { kind, id, key, title, projectKey },
      reason: suggestion.reason ?? "",
      rejectedBy: { kind: "user", ...suggestion.decidedBy! },
      at: suggestion.decidedAt!,
    },
    ticket: suggestion.sourceTicket,
    document: null,
  };
}

/** The rejection of `decision` at Version `rejecting` as Waiting Work: as that Version says it. */
export function rejectionOf(decision: Pick<Decision, "key" | "sourceTicket">, rejecting: DecisionVersion): RejectionWork {
  return {
    reason: "rejected",
    comment: null,
    decision: { key: decision.key, title: rejecting.title, reason: rejecting.statusReason ?? "", rejectedBy: rejecting.actor, at: rejecting.at },
    ticket: decision.sourceTicket,
    document: null,
  };
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

/** Told each position `markWaiting` or `markRejected` takes for an Agent, before the transaction taking it commits. */
export type Positioned = (agentId: string, seq: string) => void;

/**
 * Runs `fn` in a transaction, passing it what to tell `markWaiting` or `markRejected` about the positions
 * it takes, then `committed` with its result. Each position is expected on its Agent's stream
 * (`LiveUpdates.expect`) before it commits, until `committed` pushes it. If the transaction rolls back
 * or `committed` throws, they are forgotten, so they never hold a stream's `ready` back for good.
 */
export async function withWaitingWork<T>(
  ctx: { db: Database; live: LiveUpdates },
  fn: (tx: Queryable, positioned: Positioned) => Promise<T>,
  committed: (result: T) => void,
): Promise<T> {
  const forget: (() => void)[] = [];
  try {
    const result = await transaction(ctx.db, (tx) => fn(tx, (agentId, seq) => forget.push(ctx.live.expect(agentTopic(agentId), seq))));
    committed(result);
    return result;
  } catch (err) {
    for (const f of forget) f();
    throw err;
  }
}

/**
 * Marks `comment`, posted by `actor` at `place`, as waiting for each Agent it concerns: the
 * Agent whose question it answers (`answered`), every Agent it @mentions by name, and the
 * Delegate of the Ticket it is on. Never for the Agent that posted it, and only for Agents
 * that can see where it was posted. Returns the Agents it now waits for, and why. Calls
 * `positioned` with each position as soon as it is taken, before the transaction commits.
 */
export async function markWaiting(
  db: Queryable,
  actor: Actor,
  comment: Comment,
  place: CommentPlace,
  answered: { agentId: string } | null,
  at: Date,
  positioned: Positioned,
): Promise<WaitingFor[]> {
  const agents = await listAgents(db, actingUser(actor).workspaceId);
  const candidates: Record<WaitingReason, string[]> = {
    answer: answered ? [answered.agentId] : [],
    mention: mentionedAgents(agents, actor, mentionsIn(comment.body)),
    comment: place.delegateId ? [place.delegateId] : [],
    rejected: [],
    suggestion_rejected: [],
  };
  const poster = actor.kind === "agent" ? actor.agent.id : null;
  const marked = new Map<string, WaitingReason>();
  // A Comment waits for an Agent for the first reason that applies, in precedence order.
  for (const reason of WAITING_REASONS) {
    for (const agentId of candidates[reason]) if (agentId !== poster && !marked.has(agentId)) marked.set(agentId, reason);
  }
  const concerned: { agentId: string; reason: CommentWork["reason"] }[] = [];
  for (const [agentId, reason] of marked) {
    const found = agents.find((a) => a.agent.id === agentId);
    if (!found?.owner.active) continue;
    if (await canRead(db, agentReading(found.agent, found.owner), place.projectId)) concerned.push({ agentId, reason: reason as CommentWork["reason"] });
  }
  // Posts concerning the same Agent take positions and commit one after another, so a position
  // is never passed by one still uncommitted (see `missedWaitingWork`). Other Agents' posts don't
  // wait. Locking in id order keeps two posts naming the same Agents from deadlocking.
  for (const agentId of concerned.map((c) => c.agentId).sort()) await lockUntilCommit(db, `waiting-work:${agentId}`);
  const waiting: WaitingFor[] = [];
  for (const { agentId, reason } of concerned) {
    const { rows } = await db.query<{ seq: string }>(
      "INSERT INTO waiting_work (agent_id, comment_id, reason, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING seq",
      [agentId, comment.id, reason, at],
    );
    if (!rows[0]) continue;
    positioned(agentId, rows[0].seq);
    waiting.push({ agentId, reason, seq: rows[0].seq });
  }
  return waiting;
}

/**
 * Marks the rejection of `decision`, which the Agent `agentId` proposed, as waiting for it, at the
 * Version that rejected it, if the Agent can still see it and its Owner is active. Returns its
 * position, which `positioned` hears first, before the transaction commits.
 */
export async function markRejected(
  db: Queryable,
  workspaceId: string,
  decision: Decision,
  agentId: string,
  at: Date,
  positioned: Positioned,
): Promise<string | undefined> {
  return markFor(db, workspaceId, agentId, decision.projectId, positioned, {
    sql: "INSERT INTO waiting_work (agent_id, decision_id, decision_version, reason, at) VALUES ($1, $2, $3, 'rejected', $4) ON CONFLICT DO NOTHING RETURNING seq",
    params: [agentId, decision.id, decision.version, at],
  });
}

/**
 * Marks the rejection of `suggestion`, which the Agent that made it hears of, as waiting for it, if the
 * Agent can still see its item and its Owner is active. Returns its position, which `positioned` hears
 * first, before the transaction commits.
 */
export async function markSuggestionRejected(db: Queryable, workspaceId: string, suggestion: Suggestion, at: Date, positioned: Positioned): Promise<string | undefined> {
  const agentId = suggestion.proposedBy.id;
  return markFor(db, workspaceId, agentId, suggestion.item.projectId, positioned, {
    sql: "INSERT INTO waiting_work (agent_id, suggestion_id, reason, at) VALUES ($1, $2, 'suggestion_rejected', $3) ON CONFLICT DO NOTHING RETURNING seq",
    params: [agentId, suggestion.id, at],
  });
}

/** Inserts one piece of work for an Agent with `insert`, if it can still read where it lies (`projectId`) and its Owner is active. */
async function markFor(
  db: Queryable,
  workspaceId: string,
  agentId: string,
  projectId: string | null,
  positioned: Positioned,
  insert: { sql: string; params: unknown[] },
): Promise<string | undefined> {
  const found = (await listAgents(db, workspaceId)).find((a) => a.agent.id === agentId);
  if (!found?.owner.active || !(await canRead(db, agentReading(found.agent, found.owner), projectId))) return undefined;
  // As in `markWaiting`: one Agent's work takes positions and commits in order.
  await lockUntilCommit(db, `waiting-work:${agentId}`);
  const { rows } = await db.query<{ seq: string }>(insert.sql, insert.params);
  if (!rows[0]) return undefined;
  positioned(agentId, rows[0].seq);
  return rows[0].seq;
}

/**
 * The work waiting for the Agent, oldest first, for the welcome of its Agent Session
 * `sessionId`, leaving out what the Agent can't see right now (it keeps waiting until it can).
 * A full token's welcome takes what it lists, so it no longer waits; a read-only token, which
 * can't act on it, leaves it waiting.
 */
export async function takeWaitingWork(db: Queryable, agent: AgentActor, sessionId: string, now: Date): Promise<WaitingWork[]> {
  const { rows } = await db.query<WaitingRow>(`${SELECT_WAITING} WHERE agent_id = $1 AND taken_at IS NULL ORDER BY seq`, [agent.agent.id]);
  const work = await waitingWorkFor(db, agent, rows);
  if (!agent.readOnly && work.length > 0) {
    await db.query("UPDATE waiting_work SET taken_at = $2, taken_by_session_id = $3 WHERE agent_id = $1 AND seq = ANY($4::bigint[]) AND taken_at IS NULL", [
      agent.agent.id,
      now,
      sessionId,
      work.map((w) => w.seq),
    ]);
  }
  return work.map((w) => w.work);
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
  const { rows } = await db.query<WaitingRow>(`${SELECT_WAITING} WHERE agent_id = $1 AND taken_at IS NULL AND seq > $2 ORDER BY seq`, [agent.agent.id, afterSeq]);
  return waitingWorkFor(db, agent, rows);
}

/**
 * The position of the work that last started waiting for the Agent, taken or not; "0" if none has.
 * Work for the Agent still uncommitted when this is read will have a higher position, as
 * `markWaiting` serializes it per Agent, so a replay from it never skips that work. Work that
 * committed but whose `waiting` event a stream has yet to send may have this position or lower:
 * a stream's `ready` must not carry this alone, but the furthest of it and every id the stream
 * sent before `ready`, having sent everything published meanwhile, and kept below the
 * positions committed but not yet pushed (see `LiveUpdates.stream` and `LiveUpdates.expect`).
 */
export async function latestWaitingSeq(db: Queryable, agentId: string): Promise<string> {
  const { rows } = await db.query<{ seq: string | null }>("SELECT max(seq)::text AS seq FROM waiting_work WHERE agent_id = $1", [agentId]);
  return rows[0]?.seq ?? "0";
}

/** A row of `waiting_work`, as `SELECT_WAITING` reads it. */
interface WaitingRow {
  seq: string;
  reason: WaitingReason;
  comment_id: string | null;
  decision_id: string | null;
  decision_version: number | null;
  suggestion_id: string | null;
}

const SELECT_WAITING = "SELECT seq::text AS seq, reason, comment_id, decision_id, decision_version, suggestion_id FROM waiting_work";

/** The waiting work these rows hold, each with its position, in their order, leaving out what `agent` can't see. */
async function waitingWorkFor(db: Queryable, agent: AgentActor, rows: WaitingRow[]): Promise<{ seq: string; work: WaitingWork }[]> {
  const comments = new Map((await findCommentsByIds(db, rows.flatMap((r) => (r.comment_id ? [r.comment_id] : [])))).map((c) => [c.comment.id, c]));
  const suggestions = new Map((await findSuggestionsByIds(db, rows.flatMap((r) => (r.suggestion_id ? [r.suggestion_id] : [])))).map((s) => [s.id, s]));
  const work: { seq: string; work: WaitingWork }[] = [];
  for (const row of rows) {
    if (row.comment_id !== null) {
      const found = comments.get(row.comment_id);
      if (!found || !(await canRead(db, agent, found.on.projectId))) continue;
      const reason = row.reason as CommentWork["reason"];
      work.push({ seq: row.seq, work: { reason, comment: publicComment(found.comment), ticket: found.on.ticket, document: found.on.document } });
    } else if (row.suggestion_id !== null) {
      const found = suggestions.get(row.suggestion_id);
      if (!found || !(await canRead(db, agent, found.item.projectId))) continue;
      work.push({ seq: row.seq, work: suggestionRejectionOf(found) });
    } else {
      const decision = await findDecisionById(db, row.decision_id!);
      const version = decision && (await findDecisionVersion(db, decision, row.decision_version!));
      if (!decision || !version || !(await canRead(db, agent, decision.projectId))) continue;
      work.push({ seq: row.seq, work: rejectionOf(decision, version) });
    }
  }
  return work;
}
