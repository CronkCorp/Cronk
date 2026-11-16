import type { Queryable } from "../db/database.js";
import type { LiveUpdates } from "../live/live-updates.js";
import { inboxTopic, TRIAGE_TOPIC } from "../live/topics.js";
import { visibleProjects } from "../identity/access.js";
import type { User } from "../identity/users.js";
import { userActor } from "../actor.js";
import { listTicketReports, type Report } from "../knowledge/reports.js";
import { listAllProjects } from "../work/projects.js";
import { findTicketsByIds, isWaitingDiscoverySql, type Ticket, type TicketRef } from "../work/tickets.js";
import { listOpenQuestions, type Activity } from "../coordination/activities.js";
import { findDecisionById, type Decision } from "../knowledge/decisions.js";
import { findSuggestionsByIds, reviewerSql, type Suggestion } from "../knowledge/suggestions.js";

/**
 * A User's Inbox: everything waiting on them: the Tickets in an In Review Status they are Assignee of,
 * the Unverified completions of Tickets they are Assignee of, the open questions of the Agents they own, and
 * the Decisions Agents proposed that they review (see `PROPOSED_DECISIONS`), the open Suggestions on
 * Project items that they review (see `reviewerSql`), and the Discovered Tickets waiting for them (see `isWaitingDiscovery`).
 * Suggestions on Workspace items, and unassigned Discovered Tickets, go to Triage instead.
 */

/** A Ticket waiting on someone, with its Reports. `at` is when it entered its Status. */
export interface TicketItem<K extends string> {
  kind: K;
  at: Date;
  ticket: Ticket;
  reports: Report[];
}

/** A Ticket waiting for its Assignee's review. */
export type ReviewItem = TicketItem<"review">;

/** An Agent's completion under Autonomous Delegation, waiting for its Assignee to Accept it. */
export type UnverifiedItem = TicketItem<"unverified">;

/** A Discovered Ticket waiting for its Assignee to delegate it, keep it in Backlog or cancel it. `at` is when it was filed. */
export type DiscoveredItem = TicketItem<"discovered">;

/** An open question of one of the User's Agents, with the Ticket it is on. `at` is when it was asked. */
export interface QuestionItem {
  kind: "question";
  at: Date;
  question: Activity;
  ticket: TicketRef;
}

/**
 * A Decision an Agent proposed, waiting for a User to accept or reject it, with the Ticket it came
 * from, if any. `at` is when it was proposed.
 */
export interface DecisionItem {
  kind: "decision";
  at: Date;
  decision: Decision;
  ticket: TicketRef | null;
}

/** A Suggestion an Agent made, waiting for a User to accept or reject it. `at` is when it was made. */
export interface SuggestionInboxItem {
  kind: "suggestion";
  at: Date;
  suggestion: Suggestion;
}

/** One item waiting on a User. */
export type InboxItem = ReviewItem | UnverifiedItem | QuestionItem | DecisionItem | SuggestionInboxItem | DiscoveredItem;

/** The kinds of Inbox item, which the Inbox filters by. */
export const INBOX_KINDS = ["review", "unverified", "question", "decision", "suggestion", "discovered"] as const;

/** The open Suggestions on Project items, as `s`, each with `reviewer_id`, the User who reviews it (see `reviewerSql`). */
const OPEN_SUGGESTIONS = `
  SELECT s.id, s.project_id, s.at, ${reviewerSql("s", "t")} AS reviewer_id
  FROM suggestions s LEFT JOIN tickets t ON t.id = s.source_ticket_id
  WHERE s.state = 'open' AND s.project_id IS NOT NULL`;

/**
 * The Decisions Agents proposed, as `d`, each with `reviewer_id`, the User who reviews it while it is
 * proposed: the Assignee of the Ticket it came from, or else the proposing Agent's Owner.
 */
const AGENTS_DECISIONS = `
  SELECT d.id, d.project_id, d.status, d.created_at, COALESCE(t.assignee_id, v.actor_user_id) AS reviewer_id
  FROM decisions d JOIN decision_versions v ON v.decision_id = d.id AND v.number = 1
    LEFT JOIN tickets t ON t.id = d.source_ticket_id
  WHERE v.actor_kind = 'agent'`;

/** The Decisions Agents proposed that are still proposed, as `AGENTS_DECISIONS` gives them. */
const PROPOSED_DECISIONS = `SELECT * FROM (${AGENTS_DECISIONS}) a WHERE a.status = 'proposed'`;

/**
 * The User who reviews the Decision with this id while it is proposed, if an Agent proposed it, whatever
 * its status now: whose Inbox a change to it may concern.
 */
export async function decisionReviewer(db: Queryable, decisionId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ reviewer_id: string }>(`SELECT * FROM (${AGENTS_DECISIONS}) d WHERE d.id = $1`, [decisionId]);
  return rows[0]?.reviewer_id;
}

/** Narrows the Inbox: an item matches when, for every field given, it has one of that field's values. */
export interface InboxFilter {
  kinds?: InboxItem["kind"][];
  /** Project keys, in any case. */
  projectKeys?: string[];
  /** Agent ids: the Agent that asked a question, or the Delegate of a Ticket to review. */
  agentIds?: string[];
}

/**
 * The items in `user`'s Inbox, in the Projects they can still see: blocking questions first,
 * then the rest, each oldest first. A new item kind also belongs in `usersWithItemsOn`.
 */
export async function listInbox(db: Queryable, user: User, filter: InboxFilter = {}): Promise<InboxItem[]> {
  const projectIds = await visibleProjectIds(db, user, filter.projectKeys);
  const wants = (kind: InboxItem["kind"]) => !filter.kinds?.length || filter.kinds.includes(kind);
  const agents = filter.agentIds?.length ? new Set(filter.agentIds) : undefined;
  const items = [
    ...(wants("question") ? await openQuestions(db, user, projectIds) : []),
    ...(wants("review") ? await reviews(db, user, projectIds) : []),
    ...(wants("unverified") ? await unverified(db, user, projectIds) : []),
    ...(wants("decision") ? await proposedDecisions(db, user, projectIds, !filter.projectKeys?.length) : []),
    ...(wants("suggestion") ? await openSuggestions(db, user, projectIds) : []),
    ...(wants("discovered") ? await ticketItems(db, "discovered", { assigneeId: user.id, projectIds }) : []),
  ].filter((item) => !agents || agents.has(agentOf(item) ?? ""));
  const pinned = (item: InboxItem) => (item.kind === "question" && item.question.blocking ? 0 : 1);
  return items.sort((a, b) => pinned(a) - pinned(b) || a.at.getTime() - b.at.getTime());
}

/** The Agent an item is about: the one that asked, that proposed, that filed a Discovered Ticket, or that a Ticket is delegated to. */
function agentOf(item: InboxItem): string | undefined {
  if (item.kind === "question") return item.question.agent.id;
  if (item.kind === "decision") return item.decision.proposedBy.id;
  if (item.kind === "suggestion") return item.suggestion.proposedBy.id;
  if (item.kind === "discovered") return item.ticket.discovered?.agent.id;
  return item.ticket.delegate?.id;
}

/** The proposed Decisions `user` reviews, in the Projects `projectIds` and, with `inWorkspace`, the Workspace's. */
async function proposedDecisions(db: Queryable, user: User, projectIds: string[], inWorkspace: boolean): Promise<DecisionItem[]> {
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `SELECT d.id, d.created_at FROM (${PROPOSED_DECISIONS}) d
     WHERE d.reviewer_id = $1 AND (d.project_id = ANY($2::uuid[]) OR (d.project_id IS NULL AND $3))
     ORDER BY d.created_at`,
    [user.id, projectIds, inWorkspace],
  );
  const decisions = await Promise.all(rows.map(async (r) => ({ at: r.created_at, decision: (await findDecisionById(db, r.id))! })));
  const sources = await db.query<{ id: string; source_ticket_id: string }>(
    "SELECT id, source_ticket_id FROM decisions WHERE id = ANY($1::uuid[]) AND source_ticket_id IS NOT NULL",
    [rows.map((r) => r.id)],
  );
  const ticketOf = new Map(sources.rows.map((r) => [r.id, r.source_ticket_id]));
  const tickets = new Map((await findTicketsByIds(db, [...new Set(ticketOf.values())])).map((t) => [t.id, t]));
  return decisions.map(({ at, decision }) => {
    const ticket = tickets.get(ticketOf.get(decision.id) ?? "");
    return { kind: "decision", at, decision, ticket: ticket ? { key: ticket.key, title: ticket.title, status: ticket.status } : null };
  });
}

/** The open Suggestions `user` reviews, on items of the Projects `projectIds`. */
async function openSuggestions(db: Queryable, user: User, projectIds: string[]): Promise<SuggestionInboxItem[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT s.id FROM (${OPEN_SUGGESTIONS}) s WHERE s.reviewer_id = $1 AND s.project_id = ANY($2::uuid[]) ORDER BY s.at, s.id`,
    [user.id, projectIds],
  );
  return (await findSuggestionsByIds(db, rows.map((r) => r.id))).map((suggestion) => ({ kind: "suggestion", at: suggestion.at, suggestion }));
}

async function openQuestions(db: Queryable, user: User, projectIds: string[]): Promise<QuestionItem[]> {
  const questions = await listOpenQuestions(db, user.id, projectIds);
  const tickets = new Map((await findTicketsByIds(db, [...new Set(questions.map((q) => q.ticketId))])).map((t) => [t.id, t]));
  return questions.map((question) => {
    const ticket = tickets.get(question.ticketId)!;
    return { kind: "question", at: question.at, question, ticket: { key: ticket.key, title: ticket.title, status: ticket.status } };
  });
}

function reviews(db: Queryable, user: User, projectIds: string[]): Promise<ReviewItem[]> {
  return ticketItems(db, "review", { assigneeId: user.id, projectIds });
}

function unverified(db: Queryable, user: User, projectIds: string[]): Promise<UnverifiedItem[]> {
  return ticketItems(db, "unverified", { assigneeId: user.id, projectIds });
}

/** What makes a Ticket each kind of Ticket item, as SQL on the Ticket `t` and its Status `s`. */
const TICKET_KINDS = { review: "s.category = 'in_review'", unverified: "t.verification = 'unverified'", discovered: isWaitingDiscoverySql("t", "s") } as const;

/**
 * The Tickets waiting as `kind` items in the Projects `projectIds`, whose Assignee is `assigneeId` (none, with null), each with
 * its Reports, at when it entered its Status, oldest first.
 */
export async function ticketItems<K extends keyof typeof TICKET_KINDS>(
  db: Queryable,
  kind: K,
  which: { assigneeId: string | null; projectIds: string[] },
): Promise<TicketItem<K>[]> {
  const { rows } = await db.query<{ id: string; at: Date }>(
    `SELECT t.id, ${ENTERED_STATUS_AT} AS at
     FROM tickets t JOIN statuses s ON s.id = t.status_id JOIN projects p ON p.id = t.project_id
     WHERE t.assignee_id IS NOT DISTINCT FROM $1::uuid AND ${TICKET_KINDS[kind]} AND t.project_id = ANY($2::uuid[])
     ORDER BY at, p.key, t.number`,
    [which.assigneeId, which.projectIds],
  );
  return asTicketItems(db, kind, rows);
}

/** When the Ticket `t` entered its Status, as SQL. */
export const ENTERED_STATUS_AT =
  "COALESCE((SELECT max(c.at) FROM ticket_changes c WHERE c.ticket_id = t.id AND c.change IN ('created', 'status')), t.created_at)";

/**
 * The Tickets of these rows as `kind` items, each with its Reports and the row's other fields, in the order given.
 */
export async function asTicketItems<K extends string, R extends { id: string; at: Date }>(
  db: Queryable,
  kind: K,
  rows: R[],
): Promise<(TicketItem<K> & Omit<R, "id" | "at">)[]> {
  const tickets = new Map((await findTicketsByIds(db, rows.map((r) => r.id))).map((t) => [t.id, t]));
  return Promise.all(
    rows.flatMap(({ id, at, ...rest }) => {
      const ticket = tickets.get(id);
      return ticket ? [listTicketReports(db, id).then((reports) => ({ ...rest, kind, at, ticket, reports }))] : [];
    }),
  );
}

/**
 * Tells each of these Users that their Inbox may have changed, so open Inbox views fetch it
 * again. Skips missing ids and repeats. Call once the change is committed.
 *
 * Whatever changes a waiting item may also send it to Triage or take it out, as may a change of access,
 * so this tells Triage too, even with no User given: a change to an item with no clear User names none.
 */
export function waitingItemsChanged(live: LiveUpdates, userIds: (string | null | undefined)[]): void {
  for (const id of new Set(userIds)) if (id) live.publish(inboxTopic(id), { event: "changed", data: {} });
  live.publish(TRIAGE_TOPIC, { event: "triage", data: {} });
}

/**
 * Ids of the Users with items on the Tickets of a Project, or of a Status: the Assignees of those
 * in an In Review Status, Unverified or Discovered and waiting, and the Owners of Agents with open questions on them; and for a
 * Project, the Users reviewing its proposed Decisions and open Suggestions. Keep it in step
 * with the item kinds `listInbox` gathers.
 */
export async function usersWithItemsOn(db: Queryable, scope: { projectId: string } | { statusId: string }): Promise<string[]> {
  const [column, id] = "projectId" in scope ? ["t.project_id", scope.projectId] : ["t.status_id", scope.statusId];
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.assignee_id AS id FROM tickets t JOIN statuses s ON s.id = t.status_id
     WHERE ${column} = $1 AND (s.category = 'in_review' OR t.verification = 'unverified' OR ${isWaitingDiscoverySql("t", "s")}) AND t.assignee_id IS NOT NULL
     UNION
     SELECT v.actor_user_id FROM activities v JOIN tickets t ON t.id = v.ticket_id JOIN agents a ON a.id = v.actor_agent_id
     WHERE ${column} = $1 AND a.removed_at IS NULL AND v.kind = 'question' AND v.answer_comment_id IS NULL
     UNION
     SELECT d.reviewer_id FROM (${PROPOSED_DECISIONS}) d WHERE $2 AND d.project_id = $1
     UNION
     SELECT s.reviewer_id FROM (${OPEN_SUGGESTIONS}) s WHERE $2 AND s.project_id = $1 AND s.reviewer_id IS NOT NULL`,
    [id, "projectId" in scope],
  );
  return rows.map((r) => r.id);
}

/** Ids of the Projects, archived or not, `user` can see; only those with one of `keys`, if given. */
async function visibleProjectIds(db: Queryable, user: User, keys?: string[]): Promise<string[]> {
  const wanted = keys?.length ? new Set(keys.map((k) => k.toUpperCase())) : undefined;
  const projects = (await listAllProjects(db, user.workspaceId)).filter(
    (p) => !wanted || wanted.has(p.key),
  );
  return (await visibleProjects(db, userActor(user), projects)).map((p) => p.id);
}
