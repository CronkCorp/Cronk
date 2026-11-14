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

/**
 * The items in `user`'s Inbox, in the Projects they can still see: blocking questions first,
 * then the rest, each oldest first.
 */
export async function listInbox(db: Queryable, user: User): Promise<InboxItem[]> {
  const projectIds = await visibleProjectIds(db, user);
  const items = [...(await openQuestions(db, user, projectIds)), ...(await reviews(db, user, projectIds))];
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
     FROM tickets t JOIN statuses s ON s.id = t.status_id
     WHERE t.assignee_id = $1 AND s.category = 'in_review' AND t.project_id = ANY($2::uuid[])
     ORDER BY at, t.id`,
    [user.id, projectIds],
  );
  const tickets = await findTicketsByIds(db, rows.map((r) => r.id));
  const at = new Map(rows.map((r) => [r.id, r.at]));
  return Promise.all(tickets.map(async (ticket) => ({ kind: "review" as const, at: at.get(ticket.id)!, ticket, reports: await listTicketReports(db, ticket.id) })));
}

/** Ids of the Projects, archived or not, `user` can see. */
async function visibleProjectIds(db: Queryable, user: User): Promise<string[]> {
  const projects = [...(await listProjects(db, user.workspaceId, false)), ...(await listProjects(db, user.workspaceId, true))];
  return (await visibleProjects(db, userActor(user), projects)).map((p) => p.id);
}
