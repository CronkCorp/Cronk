import { insertActivity, markAnswered, type Activity } from "../coordination/activities.js";
import { ACTIVITY_KINDS, PRIORITIES, VERIFICATIONS } from "../../shared/values.js";
import { recordChange, ticketKeySql } from "../work/tickets.js";
import { findUserById } from "../identity/users.js";
import { storeRelation } from "../work/relations.js";
import { storeDocumentLink } from "../work/document-links.js";
import { exportAttachments, importAttachments } from "./attachments.js";
import { exportComments, importComments } from "./comments.js";
import { exportDocument, importDocument, type DocumentRow } from "./documents.js";
import { exportHistory, importHistory } from "./history.js";
import { iso, type ActorColumns, type ExportContext } from "./export-context.js";
import { date, isUuid, natural, oneOf, refuse, text, type File } from "./fields.js";
import type { ImportContext } from "./import-context.js";
import type { ImportedProject, ProjectRow } from "./projects.js";

/**
 * Tickets: `tickets/<KEY>.md` with the description as its body, relations naming other
 * Tickets by key and linked Documents naming their files by path, and a Discovered Ticket's marker
 * as `discovered`; beside it `<KEY>.activities/`, `<KEY>.comments/` and `<KEY>.reports/`.
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
  autonomous: boolean;
  verification: string | null;
  discovered_by_agent_id: string | null;
  discovered_by_owner_id: string | null;
  discovered_session_id: string | null;
  source_number: number | null;
  discovered_source_claim_id: string | null;
  discovery_kept: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RelationRow {
  kind: string;
  reason: string | null;
  from_id: string;
  from_key: string;
  to_id: string;
  to_key: string;
}

/** Writes the Tickets of the Project `p` into `${dir}/tickets/`; `statusNow` names its Statuses by id. */
export async function exportTickets(ctx: ExportContext, dir: string, p: ProjectRow, statusNow: Map<string, string>): Promise<void> {
  const { rows: tickets } = await ctx.db.query<TicketRow>(
    `SELECT t.*, s.name AS status, pt.number AS parent_number, da.owner_id AS discovered_by_owner_id, st.number AS source_number
     FROM tickets t JOIN statuses s ON s.id = t.status_id LEFT JOIN tickets pt ON pt.id = t.parent_id
       LEFT JOIN agents da ON da.id = t.discovered_by_agent_id LEFT JOIN tickets st ON st.id = t.discovered_source_ticket_id
     WHERE t.project_id = $1 ORDER BY t.number`,
    [p.id],
  );
  const { rows: relations } = await ctx.db.query<RelationRow>(
    `SELECT r.kind, r.reason, r.from_ticket_id AS from_id, ${ticketKeySql("fp", "f")} AS from_key, r.to_ticket_id AS to_id, ${ticketKeySql("tp", "t")} AS to_key
     FROM ticket_relations r
       JOIN tickets f ON f.id = r.from_ticket_id JOIN projects fp ON fp.id = f.project_id
       JOIN tickets t ON t.id = r.to_ticket_id JOIN projects tp ON tp.id = t.project_id
     WHERE f.project_id = $1 OR t.project_id = $1`,
    [p.id],
  );
  for (const t of tickets) await exportTicket(ctx, dir, p.key, t, relations, statusNow);
}

/** Writes the Ticket `t` of the Project keyed `projectKey` into `${dir}/tickets/`, with its Activities, Comments and Reports beside it. */
async function exportTicket(ctx: ExportContext, dir: string, projectKey: string, t: TicketRow, relations: RelationRow[], statusNow: Map<string, string>): Promise<void> {
  const key = `${projectKey}-${t.number}`;
  const base = `${dir}/tickets/${key}`;
  const related = (kind: string, side: "from" | "to") => {
    const other = side === "from" ? "to" : "from";
    return relations.filter((r) => r.kind === kind && r[`${side}_id`] === t.id).map((r) => r[`${other}_key`]);
  };
  const sorted = (keys: string[]) => (keys.length > 0 ? keys.sort(natural) : undefined);
  const { rows: links } = await ctx.db.query<{ document_id: string }>(
    "SELECT document_id FROM ticket_document_links WHERE ticket_id = $1 ORDER BY seq",
    [t.id],
  );
  // Once every Document is written, so linked Documents can be named by path; those the export leaves out are left out.
  ctx.afterDocuments(() => {
    const documents = links.map((l) => ctx.documentPaths.get(l.document_id)).filter((p): p is string => p !== undefined);
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
        // Written only when set, as a Ticket from before Autonomous Delegation has neither.
        autonomous: t.autonomous || undefined,
        verification: t.verification ?? undefined,
        discovered: discoveryOf(ctx, projectKey, t, relations),
        blocks: sorted(related("blocks", "from")),
        blockedBy: sorted(related("blocks", "to")),
        relatesTo: sorted([...related("relates_to", "from"), ...related("relates_to", "to")]),
        documents: documents.length > 0 ? documents : undefined,
        createdAt: iso(t.created_at),
        updatedAt: iso(t.updated_at),
      },
      t.description,
    );
  });
  await exportActivitiesAndComments(ctx, base, t.id);
  await exportAttachments(ctx, base, { ticketId: t.id });
  await exportHistory(ctx, base, t.id, statusNow);
  const { rows: reports } = await ctx.db.query<DocumentRow>("SELECT * FROM documents WHERE ticket_id = $1 ORDER BY created_at, id", [t.id]);
  for (const [i, r] of reports.entries()) await exportDocument(ctx, `${base}.reports/${i + 1}`, r);
}

/**
 * A Discovered Ticket's marker as its file writes it: the Agent and Agent Session that filed it, the Ticket it came from with
 * that Claim's id, so the Reports of the Claim still list it, and whether a User kept it in Backlog; each written only when set.
 */
function discoveryOf(ctx: ExportContext, projectKey: string, t: TicketRow, relations: RelationRow[]) {
  if (t.discovered_by_agent_id === null) return undefined;
  // Only the Agent that filed it adds blocks from it, so each needs just its reason.
  const reasons = relations
    .filter((r) => r.kind === "blocks" && r.from_id === t.id && r.reason !== null)
    .sort((a, b) => natural(a.to_key, b.to_key))
    .map((r) => [r.to_key, r.reason!] as const);
  const by = ctx.agentActor({ actor_user_id: t.discovered_by_owner_id!, actor_agent_id: t.discovered_by_agent_id, actor_session_id: t.discovered_session_id });
  const sourced = t.source_number !== null;
  return {
    agent: by.agent,
    session: by.session ?? undefined,
    sourceTicket: sourced ? `${projectKey}-${t.source_number}` : undefined,
    sourceClaim: sourced ? (t.discovered_source_claim_id ?? undefined) : undefined,
    kept: t.discovery_kept || undefined,
    blockReasons: reasons.length > 0 ? Object.fromEntries(reasons) : undefined,
  };
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

/** The Ticket a Discovered Ticket's file names as its source, by key, with that Claim's id, to link once every Ticket is in. */
interface PendingDiscoverySource {
  sourceKey: string;
  claimId: string | null;
  /** Where the Ticket file names it, for refusing a key the export doesn't hold. */
  where: string;
}

/** A relation a Ticket file names, to store once every Ticket it may name is in. */
interface PendingRelation {
  from: string;
  kind: "blocks" | "relates_to";
  to: string;
  /** The Agent and reason of a block from its Discovered Ticket. */
  block?: { agentId: string; reason: string };
}

/** A Document a Ticket file links, by the path of its file, to store once every Document is in. */
interface PendingDocumentLink {
  ticketId: string;
  path: string;
  /** Where the Ticket file names it, for refusing a path the export doesn't hold. */
  where: string;
}

/** The Tickets an import brought in so far, by key, and the relations, links and history they hold, to import once every Project is in. */
export class ImportedTickets {
  readonly ids = new Map<string, string>();
  readonly relations: PendingRelation[] = [];
  readonly documentLinks: PendingDocumentLink[] = [];
  readonly histories: { ticketId: string; statusIds: Map<string, string>; file: File }[] = [];
  /** Agents' proposed Decisions, by the key of the Ticket each came from, to link once the Tickets are in. */
  readonly decisionSources: { decisionId: string; ticketKey: string; claimId: string | null }[] = [];
  /** Discovered Tickets, by the key of the Ticket each came from, to link once the Tickets are in. */
  readonly discoverySources: (PendingDiscoverySource & { ticketId: string })[] = [];
  /** Delegated Tickets the export left without an Assignee, which this import assigned to the Delegate's Owner. */
  readonly assignedToOwner: { ticketId: string; ownerId: string }[] = [];

  /** Stores the relations between Tickets this import brought in: a key elsewhere may name another Ticket here. */
  async storeRelations(ctx: ImportContext): Promise<void> {
    // Both ends name each relation; the Discovered Ticket's side, which knows why it blocks, goes first.
    for (const r of [...this.relations].sort((a, b) => Number(b.block !== undefined) - Number(a.block !== undefined))) {
      const from = this.ids.get(r.from);
      const to = this.ids.get(r.to);
      if (!from || !to || from === to) continue;
      await storeRelation(ctx.db, { kind: r.kind, from, to, block: r.block ?? null });
    }
  }

  /** Links each proposed Decision to the Ticket it came from, if that Ticket came in with this import. */
  async storeDecisionSources(ctx: ImportContext): Promise<void> {
    for (const { decisionId, ticketKey, claimId } of this.decisionSources) {
      const ticketId = this.ids.get(ticketKey.toUpperCase());
      if (ticketId) await ctx.db.query("UPDATE decisions SET source_ticket_id = $2, source_claim_id = $3 WHERE id = $1", [decisionId, ticketId, claimId]);
    }
  }

  /** Links each Discovered Ticket to the Ticket of its Project it came from, which must be in the export too. */
  async storeDiscoverySources(ctx: ImportContext): Promise<void> {
    for (const { ticketId, sourceKey, claimId, where } of this.discoverySources) {
      const sourceId = this.ids.get(sourceKey.toUpperCase()) ?? refuse(`${where} names ${sourceKey}, which isn't a Ticket in the export`);
      const { rowCount } = await ctx.db.query(
        `UPDATE tickets t SET discovered_source_ticket_id = $2, discovered_source_claim_id = $3
         FROM tickets s WHERE t.id = $1 AND s.id = $2 AND s.project_id = t.project_id`,
        [ticketId, sourceId, claimId],
      );
      if (rowCount === 0) refuse(`${where} must name a Ticket of the same Project`);
    }
  }

  /** Stores the Documents the Tickets link, in the order each Ticket file lists them: a path may name a Document of another Project here. */
  async storeDocumentLinks(ctx: ImportContext): Promise<void> {
    for (const { ticketId, path, where } of this.documentLinks) {
      const documentId = ctx.documentIds.get(path) ?? refuse(`${where} names ${path}, which isn't a Document or Report in the export`);
      await storeDocumentLink(ctx.db, ticketId, documentId);
    }
  }

  /**
   * Imports the Tickets' history, once every Ticket is in so changes can name them, then records each assignment to a
   * Delegate's Owner this import made, as a Change by Cronk itself, as the upgrade that assigned them here would have.
   */
  async importHistories(ctx: ImportContext): Promise<void> {
    for (const { ticketId, statusIds, file } of this.histories) await importHistory(ctx, file, ticketId, statusIds);
    for (const { ticketId, ownerId } of this.assignedToOwner) {
      const owner = (await findUserById(ctx.db, ownerId))!;
      await recordChange(ctx.db, ticketId, { kind: "system" }, ctx.now, { change: "assignee", from: null, to: { id: owner.id, name: owner.name } });
    }
  }
}

/** Imports the Tickets in `projects/<dirKey>/tickets/` into `project`, adding them and the relations they name to `tickets`. */
export async function importTickets(ctx: ImportContext, dirKey: string, project: ImportedProject, tickets: ImportedTickets): Promise<void> {
  const parents: { ticketId: string; parent: string; path: string }[] = [];
  for (const path of ctx.filesIn(`projects/${dirKey}/tickets`).filter((p) => !p.endsWith(".history.md"))) {
    const t = ctx.need(path);
    const { key, id, assignedToOwner, discoverySource, blockReasons } = await importTicket(ctx, t, project);
    if (discoverySource) tickets.discoverySources.push({ ticketId: id, ...discoverySource });
    if (assignedToOwner) tickets.assignedToOwner.push({ ticketId: id, ownerId: assignedToOwner });
    if (tickets.ids.has(key)) refuse(`Two Tickets have the key ${key}`);
    tickets.ids.set(key, id);
    if (typeof t.data.parent === "string") parents.push({ ticketId: id, parent: t.data.parent.toUpperCase(), path });
    tickets.relations.push(
      ...relationsOf(t, key).map((r) => {
        const reason = r.kind === "blocks" && r.from === key ? blockReasons?.reasons.get(r.to) : undefined;
        return reason === undefined ? r : { ...r, block: { agentId: blockReasons!.agentId, reason } };
      }),
    );
    tickets.documentLinks.push(...documentLinksOf(t, id));
    const base = path.slice(0, -".md".length);
    const history = ctx.read(`${base}.history.md`);
    if (history) tickets.histories.push({ ticketId: id, statusIds: project.statusIds, file: history });
    await importActivitiesAndComments(ctx, base, id);
    await importAttachments(ctx, base, { ticketId: id });
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

/**
 * Writes the Ticket file `t` into `project`; returns its key and id. A delegated Ticket the file leaves without an
 * Assignee, as an export from before delegating always assigned someone may, is assigned to its Delegate's Owner,
 * whose id it returns as `assignedToOwner`.
 */
async function importTicket(
  ctx: ImportContext,
  t: File,
  project: ImportedProject,
): Promise<{
  key: string;
  id: string;
  assignedToOwner?: string;
  discoverySource?: PendingDiscoverySource;
  blockReasons?: { agentId: string; reasons: Map<string, string> };
}> {
  const key = text(t.data.key, `${t.path} key`).toUpperCase();
  const number = Number(new RegExp(`^${project.key}-([1-9][0-9]{0,8})$`).exec(key)?.[1]);
  if (!number) refuse(`${t.path} key must be a key of ${project.key}, such as ${project.key}-1`);
  const statusId = project.statusIds.get(text(t.data.status, `${t.path} status`).toLowerCase()) ?? refuse(`${t.path} is in a Status ${project.path} doesn't list`);
  const delegate = t.data.delegate === null || t.data.delegate === undefined ? null : ctx.agent(t.data.delegate, `${t.path} delegate`);
  const assignee = t.data.assignee === null || t.data.assignee === undefined ? null : await ctx.userId(t.data.assignee, `${t.path} assignee`);
  const assignedToOwner = delegate && assignee === null ? delegate.ownerId : undefined;
  const labels = t.data.labels ?? [];
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) refuse(`${t.path} labels must be a list of text`);
  if (t.data.autonomous !== undefined && typeof t.data.autonomous !== "boolean") refuse(`${t.path} autonomous must be true or false`);
  const verification = t.data.verification === undefined || t.data.verification === null ? null : oneOf(t.data.verification, VERIFICATIONS, `${t.path} verification`);
  const discovered = await discoveryIn(ctx, t);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO tickets (project_id, number, title, description, status_id, priority, labels, assignee_id, delegate_id, autonomous, verification, created_at, updated_at,
       discovered_by_agent_id, discovered_session_id, discovery_kept)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [
      project.id,
      number,
      text(t.data.title, `${t.path} title`),
      t.body,
      statusId,
      oneOf(t.data.priority ?? "none", PRIORITIES, `${t.path} priority`),
      labels,
      assignee ?? assignedToOwner ?? null,
      delegate?.id ?? null,
      t.data.autonomous === true,
      verification,
      date(t.data.createdAt, `${t.path} createdAt`),
      date(t.data.updatedAt, `${t.path} updatedAt`),
      discovered?.agentId ?? null,
      discovered?.sessionId ?? null,
      discovered?.kept ?? false,
    ],
  );
  return {
    key,
    id: rows[0]!.id,
    assignedToOwner,
    discoverySource: discovered?.source,
    blockReasons: discovered && { agentId: discovered.agentId, reasons: discovered.blockReasons },
  };
}

/** The Discovered marker the Ticket file `t` holds, if any, with the key of its source Ticket to link once every Ticket is in. */
async function discoveryIn(ctx: ImportContext, t: File) {
  const d = t.data.discovered;
  if (d === undefined || d === null) return undefined;
  const where = `${t.path} discovered`;
  if (typeof d !== "object" || Array.isArray(d)) refuse(`${where} must name the Agent that filed it`);
  const { agent, session, sourceTicket, sourceClaim, kept, blockReasons } = d as Record<string, unknown>;
  const by = await ctx.actor({ agent, session }, where);
  if (kept !== undefined && typeof kept !== "boolean") refuse(`${where} kept must be true or false`);
  if (sourceTicket !== undefined && sourceTicket !== null && typeof sourceTicket !== "string") refuse(`${where} sourceTicket must be a Ticket key`);
  const source = typeof sourceTicket === "string" ? { sourceKey: sourceTicket, claimId: isUuid(sourceClaim) ? sourceClaim : null, where: `${where} sourceTicket` } : undefined;
  const reasons = new Map<string, string>();
  if (blockReasons !== undefined && blockReasons !== null) {
    if (typeof blockReasons !== "object" || Array.isArray(blockReasons)) refuse(`${where} blockReasons must map Ticket keys to why it blocks them`);
    for (const [key, reason] of Object.entries(blockReasons)) {
      if (typeof reason !== "string" || reason.trim() === "") refuse(`${where} blockReasons must say why it blocks ${key}`);
      reasons.set(key.toUpperCase(), reason);
    }
  }
  return { agentId: by.agentId!, sessionId: by.sessionId, kept: kept === true, source, blockReasons: reasons };
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

/** The Documents the Ticket file `t`, imported as `ticketId`, links. */
function documentLinksOf(t: File, ticketId: string): PendingDocumentLink[] {
  const paths = t.data.documents ?? [];
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) refuse(`${t.path} documents must be a list of Document paths`);
  return paths.map((path) => ({ ticketId, path, where: `${t.path} documents` }));
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
