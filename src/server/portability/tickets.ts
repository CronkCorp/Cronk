import { insertActivity, markAnswered, type Activity } from "../coordination/activities.js";
import { ACTIVITY_KINDS, PRIORITIES } from "../../shared/values.js";
import { ticketKeySql } from "../work/tickets.js";
import { storeRelation } from "../work/relations.js";
import { exportComments, importComments } from "./comments.js";
import { exportDocument, importDocument, type DocumentRow } from "./documents.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { date, natural, oneOf, refuse, text, type File } from "./fields.js";
import type { ImportContext } from "./import-context.js";
import type { ImportedProject, ProjectRow } from "./projects.js";

/**
 * Tickets: `tickets/<KEY>.md` with the description as its body and relations naming other
 * Tickets by key; beside it `<KEY>.activities/`, `<KEY>.comments/` and `<KEY>.reports/`.
 */

interface TicketRow {
  id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  labels: string[];
  assignee_id: string | null;
  delegate_id: string | null;
  parent_number: number | null;
  created_at: Date;
  updated_at: Date;
}

interface RelationRow {
  kind: string;
  from_id: string;
  from_key: string;
  to_id: string;
  to_key: string;
}

/** Writes the Tickets of the Project `p` into `${dir}/tickets/`. */
export async function exportTickets(ctx: ExportContext, dir: string, p: ProjectRow): Promise<void> {
  const { rows: tickets } = await ctx.db.query<TicketRow>(
    `SELECT t.*, s.name AS status, pt.number AS parent_number
     FROM tickets t JOIN statuses s ON s.id = t.status_id LEFT JOIN tickets pt ON pt.id = t.parent_id
     WHERE t.project_id = $1 ORDER BY t.number`,
    [p.id],
  );
  const { rows: relations } = await ctx.db.query<RelationRow>(
    `SELECT r.kind, r.from_ticket_id AS from_id, ${ticketKeySql("fp", "f")} AS from_key, r.to_ticket_id AS to_id, ${ticketKeySql("tp", "t")} AS to_key
     FROM ticket_relations r
       JOIN tickets f ON f.id = r.from_ticket_id JOIN projects fp ON fp.id = f.project_id
       JOIN tickets t ON t.id = r.to_ticket_id JOIN projects tp ON tp.id = t.project_id
     WHERE f.project_id = $1 OR t.project_id = $1`,
    [p.id],
  );
  for (const t of tickets) await exportTicket(ctx, dir, p.key, t, relations);
}

/** Writes the Ticket `t` of the Project keyed `projectKey` into `${dir}/tickets/`, with its Activities, Comments and Reports beside it. */
async function exportTicket(ctx: ExportContext, dir: string, projectKey: string, t: TicketRow, relations: RelationRow[]): Promise<void> {
  const key = `${projectKey}-${t.number}`;
  const base = `${dir}/tickets/${key}`;
  const related = (kind: string, side: "from" | "to") => {
    const other = side === "from" ? "to" : "from";
    return relations.filter((r) => r.kind === kind && r[`${side}_id`] === t.id).map((r) => r[`${other}_key`]);
  };
  const sorted = (keys: string[]) => (keys.length > 0 ? keys.sort(natural) : undefined);
  ctx.add(
    `${base}.md`,
    {
      key,
      title: t.title,
      status: t.status,
      priority: t.priority,
      labels: t.labels,
      assignee: ctx.user(t.assignee_id),
      delegate: ctx.agent(t.delegate_id),
      parent: t.parent_number === null ? null : `${projectKey}-${t.parent_number}`,
      blocks: sorted(related("blocks", "from")),
      blockedBy: sorted(related("blocks", "to")),
      relatesTo: sorted([...related("relates_to", "from"), ...related("relates_to", "to")]),
      createdAt: iso(t.created_at),
      updatedAt: iso(t.updated_at),
    },
    t.description,
  );
  await exportActivitiesAndComments(ctx, base, t.id);
  const { rows: reports } = await ctx.db.query<DocumentRow>("SELECT * FROM documents WHERE ticket_id = $1 ORDER BY created_at, id", [t.id]);
  for (const [i, r] of reports.entries()) await exportDocument(ctx, `${base}.reports/${i + 1}`, r);
}

/** Writes a Ticket's Activities and Comments beside `${base}.md`, numbered so replies and answers can name each other. */
async function exportActivitiesAndComments(ctx: ExportContext, base: string, ticketId: string): Promise<void> {
  // Only Agents write Activities.
  const { rows: activities } = await ctx.db.query<
    ActorColumns & { actor_agent_id: string; id: string; kind: string; body: string; blocking: boolean; at: Date; answer_comment_id: string | null }
  >(
    "SELECT * FROM activities WHERE ticket_id = $1 ORDER BY seq",
    [ticketId],
  );
  const activityNumbers = new Map(activities.map((a, i) => [a.id, i + 1]));
  const commentNumbers = await exportComments(ctx, `${base}.comments`, "ticket_id", ticketId, activityNumbers);
  for (const a of activities) {
    const by = ctx.agentActor(a);
    ctx.add(
      `${base}.activities/${activityNumbers.get(a.id)}.md`,
      {
        kind: a.kind,
        blocking: a.blocking || undefined,
        at: iso(a.at),
        agent: by.agent,
        session: by.session,
        answer: a.answer_comment_id === null ? undefined : commentNumbers.get(a.answer_comment_id),
      },
      a.body,
    );
  }
}

/** A relation a Ticket file names, to store once every Ticket it may name is in. */
interface PendingRelation {
  from: string;
  kind: "blocks" | "relates_to";
  to: string;
}

/** The Tickets an import brought in so far, by key, and the relations they name, to store once every Project is in. */
export class ImportedTickets {
  readonly ids = new Map<string, string>();
  readonly relations: PendingRelation[] = [];

  /** Stores the relations between Tickets this import brought in: a key elsewhere may name another Ticket here. */
  async storeRelations(ctx: ImportContext): Promise<void> {
    for (const r of this.relations) {
      const from = this.ids.get(r.from);
      const to = this.ids.get(r.to);
      if (!from || !to || from === to) continue;
      await storeRelation(ctx.db, { kind: r.kind, from, to });
    }
  }
}

/** Imports the Tickets in `projects/<dirKey>/tickets/` into `project`, adding them and the relations they name to `tickets`. */
export async function importTickets(ctx: ImportContext, dirKey: string, project: ImportedProject, tickets: ImportedTickets): Promise<void> {
  const parents: { ticketId: string; parent: string; path: string }[] = [];
  for (const path of ctx.filesIn(`projects/${dirKey}/tickets`)) {
    const t = ctx.need(path);
    const { key, id } = await importTicket(ctx, t, project);
    if (tickets.ids.has(key)) refuse(`Two Tickets have the key ${key}`);
    tickets.ids.set(key, id);
    if (typeof t.data.parent === "string") parents.push({ ticketId: id, parent: t.data.parent.toUpperCase(), path });
    tickets.relations.push(...relationsOf(t, key));
    const base = path.slice(0, -".md".length);
    await importActivitiesAndComments(ctx, base, id);
    for (const report of ctx.filesIn(`${base}.reports`)) {
      await importDocument(ctx, report.slice(0, -".md".length), { projectId: project.id, parentId: null, position: 0, ticketId: id });
    }
  }
  for (const { ticketId, parent, path } of parents) {
    const parentId = tickets.ids.get(parent);
    if (!parentId || !parent.startsWith(`${project.key}-`)) refuse(`${path} parent must be a Ticket of ${project.key} in the export`);
    await ctx.db.query("UPDATE tickets SET parent_id = $2 WHERE id = $1", [ticketId, parentId]);
  }
}

/** Writes the Ticket file `t` into `project`; returns its key and id. */
async function importTicket(ctx: ImportContext, t: File, project: ImportedProject): Promise<{ key: string; id: string }> {
  const key = text(t.data.key, `${t.path} key`).toUpperCase();
  const number = Number(new RegExp(`^${project.key}-([1-9][0-9]{0,8})$`).exec(key)?.[1]);
  if (!number) refuse(`${t.path} key must be a key of ${project.key}, such as ${project.key}-1`);
  const statusId = project.statusIds.get(text(t.data.status, `${t.path} status`).toLowerCase()) ?? refuse(`${t.path} is in a Status ${project.path} doesn't list`);
  const delegate = t.data.delegate === null || t.data.delegate === undefined ? null : ctx.agent(t.data.delegate, `${t.path} delegate`).id;
  const labels = t.data.labels ?? [];
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) refuse(`${t.path} labels must be a list of text`);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO tickets (project_id, number, title, description, status_id, priority, labels, assignee_id, delegate_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      project.id,
      number,
      text(t.data.title, `${t.path} title`),
      t.body,
      statusId,
      oneOf(t.data.priority ?? "none", PRIORITIES, `${t.path} priority`),
      labels,
      t.data.assignee === null || t.data.assignee === undefined ? null : await ctx.userId(t.data.assignee, `${t.path} assignee`),
      delegate,
      date(t.data.createdAt, `${t.path} createdAt`),
      date(t.data.updatedAt, `${t.path} updatedAt`),
    ],
  );
  return { key, id: rows[0]!.id };
}

/** The relations the Ticket file `t`, keyed `key`, names. */
function relationsOf(t: File, key: string): PendingRelation[] {
  const relations: PendingRelation[] = [];
  for (const [field, kind, forward] of [["blocks", "blocks", true], ["blockedBy", "blocks", false], ["relatesTo", "relates_to", true]] as const) {
    const keys = t.data[field] ?? [];
    if (!Array.isArray(keys)) refuse(`${t.path} ${field} must be a list of Ticket keys`);
    for (const other of keys) {
      const otherKey = String(other).toUpperCase();
      relations.push(forward ? { from: key, kind, to: otherKey } : { from: otherKey, kind, to: key });
    }
  }
  return relations;
}

/** Imports the Activities and Comments beside `${base}.md` onto the Ticket `ticketId`, then which Comments answer which questions. */
async function importActivitiesAndComments(ctx: ImportContext, base: string, ticketId: string): Promise<void> {
  const activities = ctx.numbered(`${base}.activities`);
  const imported = new Map<number, Activity>();
  for (const [n, a] of activities) {
    const by = await ctx.actor({ agent: a.data.agent, session: a.data.session }, `${a.path} agent`);
    if (by.agentId === null || by.sessionId === null) refuse(`${a.path} must name the Agent Session that wrote it`);
    const activity = await insertActivity(
      ctx.db,
      ticketId,
      { kind: "agent", userId: by.userId, agentId: by.agentId, sessionId: by.sessionId },
      { kind: oneOf(a.data.kind, ACTIVITY_KINDS, `${a.path} kind`), body: a.body, blocking: a.data.blocking === true },
      date(a.data.at, `${a.path} at`),
    );
    imported.set(n, activity);
  }
  const commentIds = await importComments(ctx, `${base}.comments`, { ticketId }, new Map([...imported].map(([n, a]) => [n, a.id])));
  for (const [n, a] of activities) {
    if (a.data.answer === undefined || a.data.answer === null) continue;
    const answer = commentIds.get(Number(a.data.answer)) ?? refuse(`${a.path} answer names a Comment that isn't on its Ticket`);
    if (!(await markAnswered(ctx.db, imported.get(n)!, answer))) refuse(`${a.path} answer is only for a question`);
  }
}
