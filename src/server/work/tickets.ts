import type { Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { PROJECT_KEY_PATTERN, type Project, type Status } from "./projects.js";

/** A Ticket's Priority, most urgent first. */
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** A User as a Ticket shows them. */
export interface UserRef {
  id: string;
  name: string;
}

export interface Ticket {
  id: string;
  projectId: string;
  projectKey: string;
  key: string;
  number: number;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  labels: string[];
  assignee: UserRef | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TicketRow {
  id: string;
  project_id: string;
  project_key: string;
  number: number;
  title: string;
  description: string;
  status_id: string;
  status_name: string;
  status_category: Status["category"];
  priority: Priority;
  labels: string[];
  assignee_id: string | null;
  assignee_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const toTicket = (row: TicketRow): Ticket => ({
  id: row.id,
  projectId: row.project_id,
  projectKey: row.project_key,
  key: `${row.project_key}-${row.number}`,
  number: row.number,
  title: row.title,
  description: row.description,
  status: { id: row.status_id, name: row.status_name, category: row.status_category },
  priority: row.priority,
  labels: row.labels,
  assignee: row.assignee_id === null ? null : { id: row.assignee_id, name: row.assignee_name! },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT_TICKETS = `
  SELECT t.id, t.project_id, p.key AS project_key, t.number, t.title, t.description, t.priority, t.labels, t.created_at, t.updated_at,
         s.id AS status_id, s.name AS status_name, s.category AS status_category,
         a.id AS assignee_id, a.name AS assignee_name
  FROM tickets t JOIN projects p ON p.id = t.project_id JOIN statuses s ON s.id = t.status_id
  LEFT JOIN users a ON a.id = t.assignee_id`;

/**
 * Creates a Ticket with the Project's next number and records it in the history.
 * Taking the number locks the Project row until the transaction ends, so
 * concurrent creations queue up. Run inside a transaction.
 */
export async function insertTicket(
  db: Queryable,
  input: { project: Project; title: string; description: string; status: Status; actor: Actor; now: Date },
): Promise<Ticket> {
  const { rows: numbered } = await db.query<{ number: number }>(
    "UPDATE projects SET next_ticket_number = next_ticket_number + 1 WHERE id = $1 RETURNING next_ticket_number - 1 AS number",
    [input.project.id],
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO tickets (project_id, number, title, description, status_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
    [input.project.id, numbered[0]!.number, input.title, input.description, input.status.id, input.now],
  );
  const id = rows[0]!.id;
  await recordChange(db, id, input.actor, input.now, {
    change: "created",
    title: input.title,
    description: input.description,
    status: input.status,
  });
  return (await findTicketById(db, id))!;
}

export async function findTicketById(db: Queryable, id: string): Promise<Ticket | undefined> {
  const { rows } = await db.query<TicketRow>(`${SELECT_TICKETS} WHERE t.id = $1`, [id]);
  return rows[0] && toTicket(rows[0]);
}

/** `<PROJECT KEY>-<n>`; the number is capped at 9 digits so it fits the integer column. */
const TICKET_KEY = new RegExp(`^(${PROJECT_KEY_PATTERN})-([1-9][0-9]{0,8})$`);

/**
 * Finds a Ticket by its key, such as `CRONK-12`, ignoring case. With `forUpdate`,
 * locks it until the transaction ends so concurrent edits see each other's changes.
 */
export async function findTicketByKey(
  db: Queryable,
  workspaceId: string,
  key: string,
  opts: { forUpdate?: boolean } = {},
): Promise<Ticket | undefined> {
  const match = TICKET_KEY.exec(key);
  if (!match) return undefined;
  const { rows } = await db.query<TicketRow>(
    `${SELECT_TICKETS} WHERE p.workspace_id = $1 AND p.key = $2 AND t.number = $3${opts.forUpdate ? " FOR UPDATE OF t" : ""}`,
    [workspaceId, match[1]!.toUpperCase(), Number(match[2])],
  );
  return rows[0] && toTicket(rows[0]);
}

export interface TicketEdit {
  title?: string;
  description?: string;
  status?: Status;
  priority?: Priority;
  labels?: string[];
  /** A User of the Ticket's Workspace, or null to leave it unassigned. */
  assignee?: UserRef | null;
}

/**
 * Applies the changes that differ from the Ticket as it is, recording each in
 * its history. Pass a Ticket locked with `forUpdate`, inside a transaction.
 */
export async function updateTicket(db: Queryable, ticket: Ticket, changes: TicketEdit, actor: Actor, now: Date): Promise<Ticket> {
  const recorded: TicketChange[] = [];
  const columns: [column: string, value: unknown][] = [];
  if (changes.title !== undefined && changes.title !== ticket.title) {
    recorded.push({ change: "title", from: ticket.title, to: changes.title });
    columns.push(["title", changes.title]);
  }
  if (changes.description !== undefined && changes.description !== ticket.description) {
    recorded.push({ change: "description", from: ticket.description, to: changes.description });
    columns.push(["description", changes.description]);
  }
  if (changes.status !== undefined && changes.status.id !== ticket.status.id) {
    recorded.push({ change: "status", from: ticket.status, to: changes.status });
    columns.push(["status_id", changes.status.id]);
  }
  if (changes.priority !== undefined && changes.priority !== ticket.priority) {
    recorded.push({ change: "priority", from: ticket.priority, to: changes.priority });
    columns.push(["priority", changes.priority]);
  }
  if (changes.labels !== undefined && !sameList(changes.labels, ticket.labels)) {
    recorded.push({ change: "labels", from: ticket.labels, to: changes.labels });
    columns.push(["labels", changes.labels]);
  }
  if (changes.assignee !== undefined && changes.assignee?.id !== ticket.assignee?.id) {
    recorded.push({ change: "assignee", from: ticket.assignee, to: changes.assignee });
    columns.push(["assignee_id", changes.assignee?.id ?? null]);
  }
  if (recorded.length === 0) return ticket;

  columns.push(["updated_at", now]);
  await db.query(`UPDATE tickets SET ${columns.map(([column], i) => `${column} = $${i + 2}`).join(", ")} WHERE id = $1`, [
    ticket.id,
    ...columns.map(([, value]) => value),
  ]);
  for (const change of recorded) await recordChange(db, ticket.id, actor, now, change);
  return (await findTicketById(db, ticket.id))!;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Trims Labels and drops any that repeat an earlier one, ignoring case. */
export function normalizeLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels.map((l) => l.trim())) {
    if (seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    result.push(label);
  }
  return result;
}

/** One change in a Ticket's history. */
export type TicketChange =
  | { change: "created"; title: string; description: string; status: Status }
  | { change: "title"; from: string; to: string }
  | { change: "description"; from: string; to: string }
  | { change: "status"; from: Status; to: Status }
  | { change: "priority"; from: Priority; to: Priority }
  | { change: "labels"; from: string[]; to: string[] }
  | { change: "assignee"; from: UserRef | null; to: UserRef | null };

export type RecordedChange = { at: Date; actor: { kind: "user"; id: string; name: string } } & TicketChange;

async function recordChange(db: Queryable, ticketId: string, actor: Actor, at: Date, change: TicketChange): Promise<void> {
  const { change: kind, ...data } = change;
  await db.query(
    "INSERT INTO ticket_changes (ticket_id, at, actor_kind, actor_user_id, change, data) VALUES ($1, $2, $3, $4, $5, $6)",
    [ticketId, at, actor.kind, actor.user.id, kind, data],
  );
}

/** A Ticket's history, oldest first. */
export async function listHistory(db: Queryable, ticketId: string): Promise<RecordedChange[]> {
  const { rows } = await db.query<{ at: Date; user_id: string; user_name: string; change: TicketChange["change"]; data: object }>(
    `SELECT c.at, u.id AS user_id, u.name AS user_name, c.change, c.data
     FROM ticket_changes c JOIN users u ON u.id = c.actor_user_id
     WHERE c.ticket_id = $1 ORDER BY c.id`,
    [ticketId],
  );
  return rows.map(
    (row) => ({ at: row.at, actor: { kind: "user", id: row.user_id, name: row.user_name }, change: row.change, ...row.data }) as RecordedChange,
  );
}

/** A Project's Tickets in key order. */
export async function listTickets(db: Queryable, projectId: string): Promise<Ticket[]> {
  const { rows } = await db.query<TicketRow>(`${SELECT_TICKETS} WHERE t.project_id = $1 ORDER BY t.number`, [projectId]);
  return rows.map(toTicket);
}

/** The Labels on a Project's Tickets, alphabetically, one per spelling ignoring case. */
export async function listLabels(db: Queryable, projectId: string): Promise<string[]> {
  const { rows } = await db.query<{ label: string }>(
    `SELECT DISTINCT ON (lower(label)) label
     FROM tickets, unnest(labels) AS label WHERE project_id = $1 ORDER BY lower(label), label`,
    [projectId],
  );
  return rows.map((r) => r.label);
}
