import { actorColumns, toRecordedActor, type Actor, type RecordedActor, type RecordedActorRow, type StoredActor } from "../actor.js";
import { lockUntilCommit, type Queryable } from "../db/database.js";
import type { Priority, RelationKind, StatusCategory } from "../../shared/values.js";
import { PROJECT_KEY_PATTERN, type Project, type Status } from "./projects.js";

/** SQL for the key, such as CRONK-12, of the Ticket aliased `ticket` in the Project aliased `project`. */
export const ticketKeySql = (project: string, ticket: string) => `${project}.key || '-' || ${ticket}.number`;

/** A User as a Ticket shows them. */
export interface UserRef {
  id: string;
  name: string;
}

/** An Agent as a Ticket shows it. */
export interface AgentRef {
  id: string;
  name: string;
}

/** Another Ticket as a Ticket's parent and history name it. */
export interface TicketName {
  key: string;
  title: string;
}

/** Another Ticket, as a Ticket lists it among its Sub-Tickets or relations. */
export interface TicketRef {
  key: string;
  title: string;
  status: Status;
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
  /** The Agent the Assignee handed the Ticket to; always one of the Assignee's own. */
  delegate: AgentRef | null;
  /** Set on a Sub-Ticket. */
  parent: TicketName | null;
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
  delegate_id: string | null;
  delegate_name: string | null;
  parent_number: number | null;
  parent_title: string | null;
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
  delegate: row.delegate_id === null ? null : { id: row.delegate_id, name: row.delegate_name! },
  parent: row.parent_number === null ? null : { key: `${row.project_key}-${row.parent_number}`, title: row.parent_title! },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT_TICKETS = `
  SELECT t.id, t.project_id, p.key AS project_key, t.number, t.title, t.description, t.priority, t.labels, t.created_at, t.updated_at,
         s.id AS status_id, s.name AS status_name, s.category AS status_category,
         a.id AS assignee_id, a.name AS assignee_name, d.id AS delegate_id, d.name AS delegate_name, pt.number AS parent_number, pt.title AS parent_title
  FROM tickets t JOIN projects p ON p.id = t.project_id JOIN statuses s ON s.id = t.status_id
  LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN agents d ON d.id = t.delegate_id LEFT JOIN tickets pt ON pt.id = t.parent_id`;

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

/** The Tickets with these ids, in the order given. */
export async function findTicketsByIds(db: Queryable, ids: string[]): Promise<Ticket[]> {
  const { rows } = await db.query<TicketRow>(`${SELECT_TICKETS} WHERE t.id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows.map((row) => [row.id, toTicket(row)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
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

/**
 * A Ticket update as the API takes it: Status, assignee and parent by id or key, and null to clear them.
 * Routes resolve it into a `TicketEdit`, which carries the records themselves.
 */
export interface TicketChanges {
  title?: string;
  description?: string;
  statusId?: string;
  priority?: Priority;
  labels?: string[];
  assigneeId?: string | null;
  delegateId?: string | null;
  parentKey?: string | null;
}

export interface TicketEdit {
  title?: string;
  description?: string;
  status?: Status;
  priority?: Priority;
  labels?: string[];
  /** A User of the Ticket's Workspace, or null to leave it unassigned. */
  assignee?: UserRef | null;
  /** One of the Assignee's own Agents, or null. Callers drop the Ticket's Claim when it changes. */
  delegate?: AgentRef | null;
  /** A Ticket of the same Project that isn't this one or below it (see `wouldNestUnderItself`), or null. */
  parent?: Ticket | null;
}

/**
 * Applies the changes that differ from the Ticket as it is, recording each in
 * its history. Pass a Ticket locked with `forUpdate`, inside a transaction.
 * Returns the Ticket as changed, or `ticket` itself when nothing differs.
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
  if (changes.delegate !== undefined && changes.delegate?.id !== ticket.delegate?.id) {
    recorded.push({ change: "delegate", from: ticket.delegate, to: changes.delegate });
    columns.push(["delegate_id", changes.delegate?.id ?? null]);
  }
  if (changes.parent !== undefined && changes.parent?.key !== ticket.parent?.key) {
    const to = changes.parent && { key: changes.parent.key, title: changes.parent.title };
    recorded.push({ change: "parent", from: ticket.parent, to });
    columns.push(["parent_id", changes.parent?.id ?? null]);
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
  | { change: "assignee"; from: UserRef | null; to: UserRef | null }
  | { change: "delegate"; from: AgentRef | null; to: AgentRef | null }
  | { change: "parent"; from: TicketName | null; to: TicketName | null }
  | { change: "relation added" | "relation removed"; kind: RelationKind; ticket: TicketName };

export type { RecordedActor };

export type RecordedChange = { at: Date; actor: RecordedActor } & TicketChange;

/** Records a change in the Ticket's history: by `actor` as it calls now, or as an import stored it. */
export async function recordChange(db: Queryable, ticketId: string, actor: Actor | StoredActor, at: Date, change: TicketChange): Promise<void> {
  const { change: kind, ...data } = change;
  await db.query(
    `INSERT INTO ticket_changes (ticket_id, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id, change, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ticketId, at, ...actorColumns(actor), kind, data],
  );
}

interface HistoryRow extends RecordedActorRow {
  at: Date;
  change: TicketChange["change"];
  data: object;
}

/** A Ticket's history, oldest first. */
export async function listHistory(db: Queryable, ticketId: string): Promise<RecordedChange[]> {
  const { rows } = await db.query<HistoryRow>(
    `SELECT c.at, u.id AS user_id, u.name AS user_name, a.id AS agent_id, a.name AS agent_name, c.actor_session_id AS session_id, c.change, c.data
     FROM ticket_changes c JOIN users u ON u.id = c.actor_user_id LEFT JOIN agents a ON a.id = c.actor_agent_id
     WHERE c.ticket_id = $1 ORDER BY c.id`,
    [ticketId],
  );
  return rows.map((row) => ({ at: row.at, actor: toRecordedActor(row), change: row.change, ...row.data }) as RecordedChange);
}

/**
 * Narrows a Ticket list. A Ticket matches when, for every field given, it has
 * one of that field's values. Labels match ignoring case.
 */
export interface TicketFilter {
  statusIds?: string[];
  categories?: StatusCategory[];
  /** User ids; `null` matches unassigned Tickets. */
  assigneeIds?: (string | null)[];
  priorities?: Priority[];
  labels?: string[];
}

/** A Project's Tickets matching `filter`, in key order. */
export async function listTickets(db: Queryable, projectId: string, filter: TicketFilter = {}): Promise<Ticket[]> {
  const params: unknown[] = [projectId];
  const conditions = ["t.project_id = $1"];
  const param = (value: unknown) => `$${params.push(value)}`;
  if (filter.statusIds?.length) conditions.push(`t.status_id = ANY(${param(filter.statusIds)}::uuid[])`);
  if (filter.categories?.length) conditions.push(`s.category = ANY(${param(filter.categories)}::text[])`);
  if (filter.assigneeIds?.length) {
    const ids = filter.assigneeIds.filter((id) => id !== null);
    const unassigned = ids.length < filter.assigneeIds.length;
    conditions.push(`(t.assignee_id = ANY(${param(ids)}::uuid[])${unassigned ? " OR t.assignee_id IS NULL" : ""})`);
  }
  if (filter.priorities?.length) conditions.push(`t.priority = ANY(${param(filter.priorities)}::text[])`);
  if (filter.labels?.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM unnest(t.labels) AS l WHERE lower(l) = ANY(${param(filter.labels.map((l) => l.trim().toLowerCase()))}::text[]))`,
    );
  }
  const { rows } = await db.query<TicketRow>(`${SELECT_TICKETS} WHERE ${conditions.join(" AND ")} ORDER BY t.number`, params);
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

/**
 * Whether making `parent` the parent of `ticket` would put the Ticket below
 * itself. Takes a lock on the Project's parents first, so concurrent moves
 * can't make a loop between them. Run inside a transaction.
 */
export async function wouldNestUnderItself(db: Queryable, ticket: Ticket, parent: Ticket): Promise<boolean> {
  await lockUntilCommit(db, `ticket-parents:${ticket.projectId}`);
  const { rows } = await db.query(
    `WITH RECURSIVE ancestors(id) AS (
       SELECT $1::uuid
       UNION SELECT t.parent_id FROM tickets t JOIN ancestors a ON t.id = a.id WHERE t.parent_id IS NOT NULL
     )
     SELECT 1 FROM ancestors WHERE id = $2`,
    [parent.id, ticket.id],
  );
  return rows.length > 0;
}

/** A Ticket's Sub-Tickets in key order. */
export function listSubTickets(db: Queryable, ticketId: string): Promise<TicketRef[]> {
  return listTicketRefs(db, "t.parent_id = $1", [ticketId]);
}

/** The Tickets matching an SQL condition on `t`, in key order across Projects. */
export async function listTicketRefs(db: Queryable, where: string, params: unknown[]): Promise<TicketRef[]> {
  const { rows } = await db.query<TicketRow>(`${SELECT_TICKETS} WHERE ${where} ORDER BY p.key, t.number`, params);
  return rows.map(toTicket).map((ticket) => ({ key: ticket.key, title: ticket.title, status: ticket.status }));
}

/**
 * Moves every Ticket in one Status to another, recording the move in each
 * Ticket's history, and returns them as moved. Locks those Tickets; run inside a transaction.
 */
export async function moveTicketsBetweenStatuses(db: Queryable, from: Status, to: Status, actor: Actor, now: Date): Promise<Ticket[]> {
  const { rows } = await db.query<TicketRow>(`${SELECT_TICKETS} WHERE t.status_id = $1 ORDER BY t.number FOR UPDATE OF t`, [from.id]);
  const moved: Ticket[] = [];
  for (const row of rows) moved.push(await updateTicket(db, toTicket(row), { status: to }, actor, now));
  return moved;
}
