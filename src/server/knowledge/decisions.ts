import { actorColumns, toRecordedActor, type Actor, type RecordedActor, type RecordedActorRow, type StoredActor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { PROJECT_KEY_PATTERN } from "../work/projects.js";
import { ticketKeySql } from "../work/tickets.js";
import type { DecisionStatus } from "../../shared/values.js";

/**
 * Decisions: recorded choices with their reasoning and a status, belonging to a Project or the
 * Workspace and numbered in order within it, keyed `CRONK-D7` (`D7` in the Workspace). Kept as
 * Markdown (ADR 0003); every change, an edit or a change of status, is a new Version.
 */

/** Where a Decision belongs: a Project's Decisions, or the Workspace's when `projectId` is null. */
export interface DecisionScope {
  workspaceId: string;
  projectId: string | null;
}

/** Another Decision of the same scope, as a Decision names it. */
export interface DecisionRef {
  key: string;
  title: string;
  status: DecisionStatus;
}

export interface Decision {
  id: string;
  /** `CRONK-D7`, or `D7` for a Workspace Decision. */
  key: string;
  number: number;
  /** Null for a Workspace Decision. */
  projectId: string | null;
  projectKey: string | null;
  title: string;
  status: DecisionStatus;
  /** Null when it is in no group. */
  group: string | null;
  /** Markdown. */
  body: string;
  /** The number of its current Version. */
  version: number;
  /** The Decisions it replaces once accepted, in key order. */
  supersedes: DecisionRef[];
  /** The accepted Decision that replaced it, if it is superseded. */
  supersededBy: DecisionRef | null;
  /** The Ticket an Agent was working on when it proposed it: the one its Agent Session held the Claim on. Null otherwise. */
  sourceTicket: { key: string; title: string } | null;
  /** Who recorded it: the Actor of its first Version. */
  proposedBy: RecordedActor;
  /** Why it took its current status, as the User gave it: the reason it was rejected. Null when none was given. */
  statusReason: string | null;
  /** When, and by whom, it took its current status. */
  statusChangedAt: Date;
  statusChangedBy: RecordedActor;
  createdAt: Date;
  updatedAt: Date;
}

/** A Decision as its register lists it, without its body. */
export type DecisionSummary = Omit<Decision, "body" | "supersedes" | "sourceTicket" | "proposedBy" | "statusReason" | "statusChangedAt" | "statusChangedBy">;

/** The ADR sections a new Decision's body starts with when none is given. */
export const DECISION_TEMPLATE = `What was decided, and why.

## Consequences

What becomes easier or harder because of it.

## Considered Options

- **Another option**: why it wasn't chosen.
`;

const KEY = new RegExp(`^(?:(${PROJECT_KEY_PATTERN})-)?[Dd]([1-9][0-9]{0,8})$`);

/** A Decision key's Project key (null for the Workspace) and number, or undefined if it isn't one. */
export function parseDecisionKey(key: string): { projectKey: string | null; number: number } | undefined {
  const match = KEY.exec(key.trim());
  return match ? { projectKey: match[1]?.toUpperCase() ?? null, number: Number(match[2]) } : undefined;
}

/** A Decision's key from its Project key (null for the Workspace) and number. */
export const decisionKey = (projectKey: string | null, number: number) => (projectKey === null ? `D${number}` : `${projectKey}-D${number}`);

interface DecisionRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  project_key: string | null;
  number: number;
  title: string;
  body: string;
  status: DecisionStatus;
  status_reason: string | null;
  group_name: string | null;
  supersedes: number[];
  superseded_by: number | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  source_ticket_key: string | null;
  source_ticket_title: string | null;
}

const SELECT_DECISIONS = `
  SELECT d.*, p.key AS project_key, ${ticketKeySql("sp", "st")} AS source_ticket_key, st.title AS source_ticket_title
  FROM decisions d LEFT JOIN projects p ON p.id = d.project_id
    LEFT JOIN tickets st ON st.id = d.source_ticket_id LEFT JOIN projects sp ON sp.id = st.project_id`;
const IN_SCOPE = "d.workspace_id = $1 AND d.project_id IS NOT DISTINCT FROM $2";

const summarize = (row: DecisionRow, refs: Map<number, DecisionRef>): DecisionSummary => ({
  id: row.id,
  key: decisionKey(row.project_key, row.number),
  number: row.number,
  projectId: row.project_id,
  projectKey: row.project_key,
  title: row.title,
  status: row.status,
  group: row.group_name,
  version: row.version,
  supersededBy: row.superseded_by === null ? null : (refs.get(row.superseded_by) ?? null),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The Decisions of a scope with these numbers, as refs by number. */
async function refsIn(db: Queryable, scope: DecisionScope, numbers: number[]): Promise<Map<number, DecisionRef>> {
  if (numbers.length === 0) return new Map();
  const { rows } = await db.query<DecisionRow>(`${SELECT_DECISIONS} WHERE ${IN_SCOPE} AND d.number = ANY($3::int[])`, [scope.workspaceId, scope.projectId, numbers]);
  return new Map(rows.map((r) => [r.number, { key: decisionKey(r.project_key, r.number), title: r.title, status: r.status }]));
}

async function toDecision(db: Queryable, row: DecisionRow): Promise<Decision> {
  const scope = { workspaceId: row.workspace_id, projectId: row.project_id };
  const refs = await refsIn(db, scope, [...row.supersedes, ...(row.superseded_by === null ? [] : [row.superseded_by])]);
  const { rows: actors } = await db.query<RecordedActorRow & { number: number; at: Date }>(
    // Its first Version, and the first of the Versions since its status last changed.
    `${SELECT_DECISION_VERSIONS}
     WHERE v.decision_id = $1 AND (v.number = 1 OR v.number = (
       SELECT coalesce(max(number), 0) + 1 FROM decision_versions WHERE decision_id = $1 AND status <> $2))
     ORDER BY v.number`,
    [row.id, row.status],
  );
  const statusChange = actors.at(-1)!;
  const { supersededBy, ...summary } = summarize(row, refs);
  return {
    ...summary,
    body: row.body,
    supersedes: [...row.supersedes].sort((a, b) => a - b).flatMap((n) => refs.get(n) ?? []),
    supersededBy,
    sourceTicket: row.source_ticket_key === null ? null : { key: row.source_ticket_key, title: row.source_ticket_title! },
    proposedBy: toRecordedActor(actors[0]!),
    statusReason: row.status_reason,
    statusChangedAt: statusChange.at,
    statusChangedBy: toRecordedActor(statusChange),
  };
}

/** The Decision of the Workspace with this key, if there is one. With `forUpdate`, locks it until the transaction ends. */
export async function findDecisionByKey(db: Queryable, workspaceId: string, key: string, opts: { forUpdate?: boolean } = {}): Promise<Decision | undefined> {
  const parsed = parseDecisionKey(key);
  if (!parsed) return undefined;
  const { rows } = await db.query<DecisionRow>(
    `${SELECT_DECISIONS} WHERE d.workspace_id = $1 AND d.number = $2 AND ${parsed.projectKey === null ? "d.project_id IS NULL" : "p.key = $3"}
     ${opts.forUpdate ? "FOR UPDATE OF d" : ""}`,
    parsed.projectKey === null ? [workspaceId, parsed.number] : [workspaceId, parsed.number, parsed.projectKey],
  );
  return rows[0] && toDecision(db, rows[0]);
}

/** What a Decision holds besides its number: what every Version records. */
export interface DecisionContent {
  title: string;
  body: string;
  status: DecisionStatus;
  /** Why it took its status; a change of status replaces it. */
  statusReason: string | null;
  group: string | null;
  /** Numbers of Decisions of the same scope. */
  supersedes: number[];
}

/** Records Version `number` of a Decision. Run inside the transaction that creates or changes it. */
export async function insertDecisionVersion(
  db: Queryable,
  decisionId: string,
  v: DecisionContent & { number: number; actor: Actor | StoredActor; now: Date },
): Promise<void> {
  await db.query(
    `INSERT INTO decision_versions (decision_id, number, title, body, status, status_reason, group_name, supersedes, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [decisionId, v.number, v.title, v.body, v.status, v.statusReason, v.group, v.supersedes, v.now, ...actorColumns(v.actor)],
  );
}

/** Takes the next Decision number of a scope. */
async function nextNumber(db: Queryable, scope: DecisionScope): Promise<number> {
  const { rows } = await db.query<{ number: number }>(
    scope.projectId === null
      ? "UPDATE workspaces SET next_decision_number = next_decision_number + 1 WHERE id = $1 RETURNING next_decision_number - 1 AS number"
      : "UPDATE projects SET next_decision_number = next_decision_number + 1 WHERE id = $1 RETURNING next_decision_number - 1 AS number",
    [scope.projectId ?? scope.workspaceId],
  );
  return rows[0]!.number;
}

/** The Claim an Agent proposed a Decision in, and its Ticket. */
export interface DecisionSource {
  ticketId: string;
  claimId: string;
}

/** Creates a Decision with the next number of its scope, at Version 1, proposed in `source` if an Agent proposed it during a Claim. Run inside a transaction. */
export async function insertDecision(
  db: Queryable,
  scope: DecisionScope,
  content: DecisionContent,
  actor: Actor,
  now: Date,
  source: DecisionSource | null = null,
): Promise<Decision> {
  const number = await nextNumber(db, scope);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO decisions (workspace_id, project_id, number, title, body, status, status_reason, group_name, supersedes, version, created_at, updated_at, source_ticket_id, source_claim_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10, $11, $12) RETURNING id`,
    [scope.workspaceId, scope.projectId, number, content.title, content.body, content.status, content.statusReason, content.group, content.supersedes, now, source?.ticketId ?? null, source?.claimId ?? null],
  );
  const id = rows[0]!.id;
  await insertDecisionVersion(db, id, { ...content, number: 1, actor, now });
  return (await findDecisionById(db, id))!;
}

export async function findDecisionById(db: Queryable, id: string): Promise<Decision | undefined> {
  const { rows } = await db.query<DecisionRow>(`${SELECT_DECISIONS} WHERE d.id = $1`, [id]);
  return rows[0] && toDecision(db, rows[0]);
}

/** What a Decision holds now, as its next Version would record it unchanged. */
export const contentOf = (decision: Decision): DecisionContent => ({
  title: decision.title,
  body: decision.body,
  status: decision.status,
  statusReason: decision.statusReason,
  group: decision.group,
  supersedes: decision.supersedes.map((ref) => parseDecisionKey(ref.key)!.number),
});

/** Whether two lists hold the same numbers, in any order. */
const sameNumbers = (a: number[], b: number[]) => a.length === b.length && a.every((n) => b.includes(n));

/**
 * Saves a new Version of a Decision holding `content`, unless it would change nothing. Pass a
 * Decision locked with `forUpdate`, inside a transaction. Changes nothing else: superseding others
 * on acceptance is the caller's.
 */
export async function saveDecision(db: Queryable, decision: Decision, content: DecisionContent, actor: Actor | StoredActor, now: Date): Promise<Decision> {
  const current = contentOf(decision);
  const unchanged =
    content.title === current.title &&
    content.body === current.body &&
    content.status === current.status &&
    content.statusReason === current.statusReason &&
    content.group === current.group &&
    sameNumbers(content.supersedes, current.supersedes);
  if (unchanged) return decision;
  const number = decision.version + 1;
  await insertDecisionVersion(db, decision.id, { ...content, number, actor, now });
  await db.query(
    // Only a superseded Decision names what superseded it.
    `UPDATE decisions SET title = $2, body = $3, status = $4, group_name = $5, supersedes = $6, version = $7, updated_at = $8,
       superseded_by = CASE WHEN $4 = 'superseded' THEN superseded_by END, status_reason = $9
     WHERE id = $1`,
    [decision.id, content.title, content.body, content.status, content.group, content.supersedes, number, now, content.statusReason],
  );
  return (await findDecisionById(db, decision.id))!;
}

/** One saved state of a Decision, with the Actor who saved it. */
export interface DecisionVersion {
  number: number;
  title: string;
  body: string;
  status: DecisionStatus;
  /** Why it had that status, as given when it took it. */
  statusReason: string | null;
  group: string | null;
  /** Keys of the Decisions it superseded at this Version. */
  supersedes: string[];
  at: Date;
  actor: RecordedActor;
}

interface DecisionVersionRow extends RecordedActorRow {
  number: number;
  title: string;
  body: string;
  status: DecisionStatus;
  status_reason: string | null;
  group_name: string | null;
  supersedes: number[];
  at: Date;
}

const SELECT_DECISION_VERSIONS = `
  SELECT v.number, v.title, v.body, v.status, v.status_reason, v.group_name, v.supersedes, v.at,
         u.id AS user_id, u.name AS user_name, a.id AS agent_id, a.name AS agent_name, v.actor_session_id AS session_id
  FROM decision_versions v JOIN users u ON u.id = v.actor_user_id LEFT JOIN agents a ON a.id = v.actor_agent_id`;

const toDecisionVersion = (decision: Decision, row: DecisionVersionRow): DecisionVersion => ({
  number: row.number,
  title: row.title,
  body: row.body,
  status: row.status,
  statusReason: row.status_reason,
  group: row.group_name,
  supersedes: [...row.supersedes].sort((a, b) => a - b).map((n) => decisionKey(decision.projectKey, n)),
  at: row.at,
  actor: toRecordedActor(row),
});

/** One of a Decision's Versions, by number. */
export async function findDecisionVersion(db: Queryable, decision: Decision, number: number): Promise<DecisionVersion | undefined> {
  const { rows } = await db.query<DecisionVersionRow>(`${SELECT_DECISION_VERSIONS} WHERE v.decision_id = $1 AND v.number = $2`, [decision.id, number]);
  return rows[0] && toDecisionVersion(decision, rows[0]);
}

/** A Decision's Versions, newest first, without their bodies. */
export async function listDecisionVersions(db: Queryable, decision: Decision): Promise<Omit<DecisionVersion, "body">[]> {
  const { rows } = await db.query<DecisionVersionRow>(`${SELECT_DECISION_VERSIONS} WHERE v.decision_id = $1 ORDER BY v.number DESC`, [decision.id]);
  return rows.map((row) => toDecisionVersion(decision, row)).map(({ body: _, ...summary }) => summary);
}

/**
 * The numbers of the Decisions `keys` name, which must be other Decisions of `scope` than the one
 * numbered `own` (null for a Decision not yet recorded); or why they can't be superseded.
 */
export async function supersededNumbers(db: Queryable, scope: DecisionScope, own: number | null, keys: string[]): Promise<number[] | string> {
  const numbers: number[] = [];
  const projectKey = scope.projectId === null ? null : await scopeKey(db, scope.projectId);
  for (const key of keys) {
    const parsed = parseDecisionKey(key);
    if (!parsed || parsed.projectKey !== projectKey) {
      return `${key.trim()} isn't a Decision of ${projectKey ?? "the Workspace"}; a Decision supersedes only others of its own ${projectKey === null ? "Workspace" : "Project"}`;
    }
    if (parsed.number === own) return "A Decision can't supersede itself";
    if (!numbers.includes(parsed.number)) numbers.push(parsed.number);
  }
  const found = await refsIn(db, scope, numbers);
  const missing = numbers.find((n) => !found.has(n));
  if (missing !== undefined) return `There is no Decision ${decisionKey(projectKey, missing)}`;
  return numbers.sort((a, b) => a - b);
}

async function scopeKey(db: Queryable, projectId: string): Promise<string> {
  const { rows } = await db.query<{ key: string }>("SELECT key FROM projects WHERE id = $1", [projectId]);
  return rows[0]!.key;
}

/**
 * Keeps the Decisions `decision` supersedes in step with a save that took it from `before`, as a
 * change by `actor`: once accepted, each Decision it newly supersedes (all of them, when it has just
 * become accepted) is marked superseded, unless superseded or rejected already; and each Decision it
 * no longer supersedes that it had superseded goes back to the status it had before. Run inside the
 * transaction that saved it. Returns the Decisions it changed.
 */
export async function applySuperseding(
  db: Queryable,
  scope: DecisionScope,
  before: DecisionContent,
  decision: Decision,
  actor: Actor | StoredActor,
  now: Date,
): Promise<Decision[]> {
  const changed: Decision[] = [];
  const numbers = contentOf(decision).supersedes;
  const added = before.status === "accepted" ? numbers.filter((n) => !before.supersedes.includes(n)) : numbers;
  const dropped = before.supersedes.filter((n) => !numbers.includes(n));
  if (decision.status === "accepted" && added.length > 0) {
    for (const older of await lockedIn(db, scope, added, "d.status NOT IN ('superseded', 'rejected')")) {
      changed.push(await saveDecision(db, older, { ...contentOf(older), status: "superseded", statusReason: null }, actor, now));
      await db.query("UPDATE decisions SET superseded_by = $2 WHERE id = $1", [older.id, decision.number]);
    }
  }
  if (dropped.length > 0) {
    for (const older of await lockedIn(db, scope, dropped, `d.status = 'superseded' AND d.superseded_by = ${decision.number}`)) {
      const { rows } = await db.query<{ status: DecisionStatus }>(
        "SELECT status FROM decision_versions WHERE decision_id = $1 AND status <> 'superseded' ORDER BY number DESC LIMIT 1",
        [older.id],
      );
      changed.push(await saveDecision(db, older, { ...contentOf(older), status: rows[0]?.status ?? "accepted", statusReason: null }, actor, now));
    }
  }
  return changed;
}

/** The Decisions of a scope with these numbers that meet `condition` (SQL on `d`), locked until the transaction ends, in number order. */
async function lockedIn(db: Queryable, scope: DecisionScope, numbers: number[], condition: string): Promise<Decision[]> {
  const { rows } = await db.query<DecisionRow>(
    `${SELECT_DECISIONS} WHERE ${IN_SCOPE} AND d.number = ANY($3::int[]) AND ${condition} ORDER BY d.number FOR UPDATE OF d`,
    [scope.workspaceId, scope.projectId, numbers],
  );
  return Promise.all(rows.map((row) => toDecision(db, row)));
}

/** A scope's Decisions, newest first, with only those in one of `statuses` and, ignoring case, one of `groups` when given. */
export async function listDecisions(db: Queryable, scope: DecisionScope, filters: { statuses?: DecisionStatus[]; groups?: string[] } = {}): Promise<DecisionSummary[]> {
  const { rows } = await db.query<DecisionRow>(
    `${SELECT_DECISIONS} WHERE ${IN_SCOPE}
       AND ($3::text[] IS NULL OR d.status = ANY($3::text[]))
       AND ($4::text[] IS NULL OR lower(d.group_name) = ANY($4::text[]))
     ORDER BY d.number DESC`,
    [scope.workspaceId, scope.projectId, filters.statuses ?? null, filters.groups?.map((g) => g.trim().toLowerCase()) ?? null],
  );
  const refs = await refsIn(db, scope, rows.flatMap((r) => (r.superseded_by === null ? [] : [r.superseded_by])));
  return rows.map((row) => summarize(row, refs));
}

/**
 * The Decisions Agents proposed during each of these Claims, oldest first, each with its Project (null for
 * the Workspace), by Claim id.
 */
export async function listDecisionsProposedIn(db: Queryable, claimIds: string[]): Promise<Map<string, (DecisionRef & { projectId: string | null })[]>> {
  const { rows } = await db.query<{ claim_id: string; project_id: string | null; project_key: string | null; number: number; title: string; status: DecisionStatus }>(
    `SELECT d.source_claim_id AS claim_id, d.project_id, p.key AS project_key, d.number, d.title, d.status
     FROM decisions d LEFT JOIN projects p ON p.id = d.project_id
     WHERE d.source_claim_id = ANY($1::uuid[]) ORDER BY d.created_at, d.project_id IS NULL, d.number`,
    [claimIds],
  );
  const byClaim = new Map<string, (DecisionRef & { projectId: string | null })[]>();
  for (const r of rows) {
    const list = byClaim.get(r.claim_id) ?? [];
    byClaim.set(r.claim_id, list);
    list.push({ key: decisionKey(r.project_key, r.number), title: r.title, status: r.status, projectId: r.project_id });
  }
  return byClaim;
}

/** A Decision's row as an import writes it, keeping its number and times; the caller records its Versions. */
export async function insertDecisionRow(
  db: Queryable,
  scope: DecisionScope,
  d: DecisionContent & { number: number; supersededBy: number | null; version: number; createdAt: Date; updatedAt: Date },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO decisions (workspace_id, project_id, number, title, body, status, status_reason, group_name, supersedes, superseded_by, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [scope.workspaceId, scope.projectId, d.number, d.title, d.body, d.status, d.statusReason, d.group, d.supersedes, d.supersededBy, d.version, d.createdAt, d.updatedAt],
  );
  return rows[0]!.id;
}

/** Makes a scope's next Decision number follow the highest it holds, as after an import. */
export async function continueNumbering(db: Queryable, scope: DecisionScope): Promise<void> {
  const next = `(SELECT coalesce(max(number), 0) + 1 FROM decisions WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2)`;
  if (scope.projectId === null) await db.query(`UPDATE workspaces SET next_decision_number = ${next} WHERE id = $1`, [scope.workspaceId, null]);
  else await db.query(`UPDATE projects SET next_decision_number = ${next} WHERE id = $2`, [scope.workspaceId, scope.projectId]);
}
