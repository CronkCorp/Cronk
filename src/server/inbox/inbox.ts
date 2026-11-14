import type { Queryable } from "../db/database.js";
import { visibleProjects } from "../identity/access.js";
import type { User } from "../identity/users.js";
import { userActor } from "../actor.js";
import { listTicketReports, type Report } from "../knowledge/reports.js";
import { listProjects } from "../work/projects.js";
import { findTicketsByIds, type Ticket, type TicketRef } from "../work/tickets.js";
import { listOpenQuestions, type Activity } from "../coordination/activities.js";

/**
 * A User's Inbox: everything waiting on them. In Phase 1 that is the Tickets in an In Review
 * Status they are Assignee of, and the open questions of the Agents they own.
 */

/** A Ticket waiting for its Assignee's review, with its Reports. `at` is when it entered its Status. */
export interface ReviewItem {
  kind: "review";
  at: Date;
  ticket: Ticket;
  reports: Report[];
}

/** An open question of one of the User's Agents, with the Ticket it is on. `at` is when it was asked. */
export interface QuestionItem {
  kind: "question";
  at: Date;
  question: Activity;
  ticket: TicketRef;
}

export type InboxItem = ReviewItem | QuestionItem;

export const INBOX_KINDS = ["review", "question"] as const;

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
 * then the rest, each oldest first.
 */
export async function listInbox(db: Queryable, user: User, filter: InboxFilter = {}): Promise<InboxItem[]> {
  const projectIds = await visibleProjectIds(db, user, filter.projectKeys);
  const wants = (kind: InboxItem["kind"]) => !filter.kinds?.length || filter.kinds.includes(kind);
  const agents = filter.agentIds?.length ? new Set(filter.agentIds) : undefined;
  const items = [
    ...(wants("question") ? await openQuestions(db, user, projectIds) : []),
    ...(wants("review") ? await reviews(db, user, projectIds) : []),
  ].filter((item) => !agents || agents.has((item.kind === "question" ? item.question.agent.id : item.ticket.delegate?.id) ?? ""));
  const pinned = (item: InboxItem) => (item.kind === "question" && item.question.blocking ? 0 : 1);
  return items.sort((a, b) => pinned(a) - pinned(b) || a.at.getTime() - b.at.getTime());
}

async function openQuestions(db: Queryable, user: User, projectIds: string[]): Promise<QuestionItem[]> {
  const questions = await listOpenQuestions(db, user.id, projectIds);
  const tickets = new Map((await findTicketsByIds(db, [...new Set(questions.map((q) => q.ticketId))])).map((t) => [t.id, t]));
  return questions.map((question) => {
    const ticket = tickets.get(question.ticketId)!;
    return { kind: "question", at: question.at, question, ticket: { key: ticket.key, title: ticket.title, status: ticket.status } };
  });
}

async function reviews(db: Queryable, user: User, projectIds: string[]): Promise<ReviewItem[]> {
  const { rows } = await db.query<{ id: string; at: Date }>(
    `SELECT t.id, COALESCE((SELECT max(c.at) FROM ticket_changes c WHERE c.ticket_id = t.id AND c.change IN ('created', 'status')), t.created_at) AS at
     FROM tickets t JOIN statuses s ON s.id = t.status_id JOIN projects p ON p.id = t.project_id
     WHERE t.assignee_id = $1 AND s.category = 'in_review' AND t.project_id = ANY($2::uuid[])
     ORDER BY at, p.key, t.number`,
    [user.id, projectIds],
  );
  const tickets = await findTicketsByIds(db, rows.map((r) => r.id));
  const at = new Map(rows.map((r) => [r.id, r.at]));
  return Promise.all(tickets.map(async (ticket) => ({ kind: "review" as const, at: at.get(ticket.id)!, ticket, reports: await listTicketReports(db, ticket.id) })));
}

/** Ids of the Projects, archived or not, `user` can see; only those with one of `keys`, if given. */
async function visibleProjectIds(db: Queryable, user: User, keys?: string[]): Promise<string[]> {
  const wanted = keys?.length ? new Set(keys.map((k) => k.toUpperCase())) : undefined;
  const projects = [...(await listProjects(db, user.workspaceId, false)), ...(await listProjects(db, user.workspaceId, true))].filter(
    (p) => !wanted || wanted.has(p.key),
  );
  return (await visibleProjects(db, userActor(user), projects)).map((p) => p.id);
}
