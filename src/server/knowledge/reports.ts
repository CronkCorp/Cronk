import { actingUser, type AgentActor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { ticketKeySql, type Ticket } from "../work/tickets.js";
import { findDocument, insertVersion, type Document } from "./documents.js";

/**
 * Reports: Documents of findings an Agent Session writes on a Ticket while holding its Claim.
 * A Report belongs to the Ticket's Project and has Versions like any Document, but lives with
 * its Ticket instead of in the page tree. Each records the Claim it was written in, since an
 * Agent hands work over only with a Report from its current Claim.
 */

/** A Report as its Ticket and its Project list it: without its body, with who wrote it. */
export interface Report {
  id: string;
  ticketKey: string;
  ticketTitle: string;
  title: string;
  /** The number of its current Version. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** The Agent that wrote it, with the Owner it acts for. */
  agent: { id: string; name: string; owner: { id: string; name: string } };
  /** The Agent Session it was written in. */
  session: { id: string };
}

interface ReportRow {
  id: string;
  ticket_key: string;
  ticket_title: string;
  title: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  agent_id: string;
  agent_name: string;
  owner_id: string;
  owner_name: string;
  session_id: string;
}

const toReport = (row: ReportRow): Report => ({
  id: row.id,
  ticketKey: row.ticket_key,
  ticketTitle: row.ticket_title,
  title: row.title,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  agent: { id: row.agent_id, name: row.agent_name, owner: { id: row.owner_id, name: row.owner_name } },
  session: { id: row.session_id },
});

/** Selects Reports as `d`, with their Ticket `t` and the Agent and Session of their first Version. */
const SELECT_REPORTS = `
  SELECT d.id, ${ticketKeySql("p", "t")} AS ticket_key, t.title AS ticket_title, d.title, d.version, d.created_at, d.updated_at,
    a.id AS agent_id, a.name AS agent_name, u.id AS owner_id, u.name AS owner_name, v.actor_session_id AS session_id
  FROM documents d JOIN tickets t ON t.id = d.ticket_id JOIN projects p ON p.id = t.project_id
    JOIN document_versions v ON v.document_id = d.id AND v.number = 1
    JOIN agents a ON a.id = v.actor_agent_id JOIN users u ON u.id = v.actor_user_id`;

/**
 * Writes a Report on the Ticket at Version 1, recording the Claim `claimId` it is written in.
 * Callers check, inside the same transaction, that the Agent Session holds that Claim.
 */
export async function insertReport(
  db: Queryable,
  input: { ticket: Ticket; claimId: string; agent: AgentActor; title: string; body: string; now: Date },
): Promise<Document> {
  const workspaceId = actingUser(input.agent).workspaceId;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO documents (workspace_id, project_id, parent_id, position, title, body, version, created_at, updated_at, ticket_id, claim_id)
     VALUES ($1, $2, NULL, 0, $3, $4, 1, $5, $5, $6, $7) RETURNING id`,
    [workspaceId, input.ticket.projectId, input.title, input.body, input.now, input.ticket.id, input.claimId],
  );
  const id = rows[0]!.id;
  await insertVersion(db, id, { number: 1, title: input.title, body: input.body, actor: input.agent, now: input.now, restoredFrom: null });
  return (await findDocument(db, workspaceId, id))!;
}

/** The Report with this Document id, as listings show it. */
export async function findReport(db: Queryable, id: string): Promise<Report | undefined> {
  const { rows } = await db.query<ReportRow>(`${SELECT_REPORTS} WHERE d.id = $1`, [id]);
  return rows[0] && toReport(rows[0]);
}

/** A Ticket's Reports, oldest first. */
export async function listTicketReports(db: Queryable, ticketId: string): Promise<Report[]> {
  const { rows } = await db.query<ReportRow>(`${SELECT_REPORTS} WHERE d.ticket_id = $1 ORDER BY d.created_at, d.id`, [ticketId]);
  return rows.map(toReport);
}

/** A Project's Reports, newest first. */
export async function listProjectReports(db: Queryable, projectId: string): Promise<Report[]> {
  const { rows } = await db.query<ReportRow>(`${SELECT_REPORTS} WHERE t.project_id = $1 ORDER BY d.created_at DESC, d.id`, [projectId]);
  return rows.map(toReport);
}

/** Whether a Report was written on the Ticket during the Claim `claimId`. */
export async function hasReportFromClaim(db: Queryable, ticketId: string, claimId: string): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM documents WHERE ticket_id = $1 AND claim_id = $2 LIMIT 1", [ticketId, claimId]);
  return rows.length > 0;
}
