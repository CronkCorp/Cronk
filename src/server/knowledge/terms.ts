import { actorColumns, toRecordedActor, type Actor, type RecordedActor, type RecordedActorRow, type StoredActor } from "../actor.js";
import { lockUntilCommit, type Queryable } from "../db/database.js";
import type { Readable } from "../identity/access.js";
import { recordMentions, recordMentionsOfNames } from "./mentions.js";
import { withSuggestions, type VersionSuggestion } from "./version-suggestions.js";

/**
 * Terms: the Workspace's or a Project's glossary, each Term naming one concept with its definition
 * and the words to avoid for it. Names are unique per place ignoring case, and within a Project a
 * Project Term replaces the Workspace Term of the same name. Every save is a new Version.
 */

/** Where Terms belong: a Project, or the Workspace when `projectId` is null. */
export interface TermPlace {
  workspaceId: string;
  projectId: string | null;
}

/** What a Term says, as each Version records it. */
export interface TermFields {
  name: string;
  /** Markdown. */
  definition: string;
  /** The words to avoid for it, as written. */
  avoid: string[];
  /** The group the glossary lists it under; null for none. */
  group: string | null;
}

/** A Term as the API answers it. */
export interface Term extends TermFields {
  id: string;
  /** Null for a Workspace Term. */
  projectId: string | null;
  projectKey: string | null;
  version: number;
  /** Whether Agents may read but not change it. */
  protected: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** For a Project Term: the Workspace Term of the same name it replaces in its Project, if the reader can see the Workspace's Terms. */
  overrides: { id: string; name: string; definition: string } | null;
  /** For a Workspace Term: the Project Terms of the same name that replace it, in Projects the reader can see, by Project key. */
  overriddenBy: { id: string; name: string; projectKey: string }[];
}

interface TermRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  project_key: string | null;
  name: string;
  definition: string;
  avoid: string[];
  group_name: string | null;
  version: number;
  protected: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A Term's own fields, before its overrides are looked up. */
export type StoredTerm = Omit<Term, "overrides" | "overriddenBy">;

const toTerm = (row: TermRow): StoredTerm => ({
  id: row.id,
  projectId: row.project_id,
  projectKey: row.project_key,
  name: row.name,
  definition: row.definition,
  avoid: row.avoid,
  group: row.group_name,
  version: row.version,
  protected: row.protected,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT_TERMS = "SELECT t.*, p.key AS project_key FROM terms t LEFT JOIN projects p ON p.id = t.project_id";

/** Orders Terms as a glossary reads: by name, ignoring case. */
const ORDER = "ORDER BY lower(t.name), t.name, p.key NULLS FIRST";

/** The fields as stored: names and group trimmed, a blank group none, and words to avoid trimmed, blanks and repeats (ignoring case) dropped. */
export function tidyFields(fields: TermFields): TermFields {
  const seen = new Set<string>();
  const avoid = fields.avoid
    .map((w) => w.trim())
    .filter((w) => w !== "" && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()));
  const group = fields.group?.trim() || null;
  return { name: fields.name.trim(), definition: fields.definition, avoid, group };
}

/** Takes a lock on a place's Term names until the transaction ends, so two Terms can't both take a name. */
const lockNames = (db: Queryable, place: TermPlace) => lockUntilCommit(db, `terms:${place.workspaceId}:${place.projectId ?? "workspace"}`);

/** Whether another Term than `except` in `place` has `name`, ignoring case. Lock the names first. */
async function nameTaken(db: Queryable, place: TermPlace, name: string, except: string | null): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT 1 FROM terms WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3) AND id IS DISTINCT FROM $4",
    [place.workspaceId, place.projectId, name, except],
  );
  return rows.length > 0;
}

/** Creates a Term in `place` at Version 1, or refuses if a Term there already has its name. Run inside a transaction. */
export async function insertTerm(
  db: Queryable,
  input: { place: TermPlace; fields: TermFields; actor: Actor; now: Date },
): Promise<StoredTerm | "name taken"> {
  const fields = tidyFields(input.fields);
  await lockNames(db, input.place);
  if (await nameTaken(db, input.place, fields.name, null)) return "name taken";
  const id = await insertTermRow(db, { ...input.place, ...fields, version: 1, createdAt: input.now, updatedAt: input.now });
  await insertTermVersion(db, id, { number: 1, ...fields, at: input.now, actor: input.actor });
  await recordMentions(db, { kind: "term", id });
  await recordMentionsOfNames(db, input.place, [fields.name]);
  return (await findTerm(db, input.place.workspaceId, id))!;
}

/** A Term's row as written in full, as an import writes it with its times; callers record its Versions. */
export async function insertTermRow(
  db: Queryable,
  t: TermPlace & TermFields & { version: number; createdAt: Date; updatedAt: Date },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO terms (workspace_id, project_id, name, definition, avoid, group_name, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [t.workspaceId, t.projectId, t.name, t.definition, t.avoid, t.group, t.version, t.createdAt, t.updatedAt],
  );
  return rows[0]!.id;
}

/** Records Version `number` of a Term. */
export async function insertTermVersion(
  db: Queryable,
  termId: string,
  v: TermFields & { number: number; at: Date; actor: Actor | StoredActor },
): Promise<void> {
  await db.query(
    `INSERT INTO term_versions (term_id, number, name, definition, avoid, group_name, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [termId, v.number, v.name, v.definition, v.avoid, v.group, v.at, ...actorColumns(v.actor)],
  );
}

/** A Term of the Workspace, by id. With `forUpdate`, locks it until the transaction ends. */
export async function findTerm(db: Queryable, workspaceId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<StoredTerm | undefined> {
  const { rows } = await db.query<TermRow>(`${SELECT_TERMS} WHERE t.workspace_id = $1 AND t.id = $2${opts.forUpdate ? " FOR UPDATE OF t" : ""}`, [
    workspaceId,
    id,
  ]);
  return rows[0] && toTerm(rows[0]);
}

/** The Terms of one place, the Workspace's or a Project's own, in glossary order. */
export async function listTerms(db: Queryable, place: TermPlace): Promise<StoredTerm[]> {
  const { rows } = await db.query<TermRow>(`${SELECT_TERMS} WHERE t.workspace_id = $1 AND t.project_id IS NOT DISTINCT FROM $2 ${ORDER}`, [
    place.workspaceId,
    place.projectId,
  ]);
  return rows.map(toTerm);
}

/** The names of each of these Projects' own Terms, by name. */
export async function termNamesByProject(db: Queryable, projectIds: string[]): Promise<Map<string, string[]>> {
  const { rows } = await db.query<{ project_id: string; name: string }>(
    "SELECT t.project_id, t.name FROM terms t WHERE t.project_id = ANY($1::uuid[]) ORDER BY lower(t.name), t.name",
    [projectIds],
  );
  return new Map(projectIds.map((id) => [id, rows.filter((r) => r.project_id === id).map((r) => r.name)]));
}

/**
 * The Terms that apply in a Project: its own, and the Workspace's it has none of the same name for
 * (ignoring case), in glossary order. The Workspace's are left out when `withWorkspace` is false.
 */
export async function listApplicableTerms(db: Queryable, place: TermPlace & { projectId: string }, withWorkspace: boolean): Promise<StoredTerm[]> {
  const { rows } = await db.query<TermRow>(
    `${SELECT_TERMS}
     WHERE t.workspace_id = $1 AND (t.project_id = $2 OR ($3 AND t.project_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM terms o WHERE o.workspace_id = $1 AND o.project_id = $2 AND lower(o.name) = lower(t.name))))
     ${ORDER}`,
    [place.workspaceId, place.projectId, withWorkspace],
  );
  return rows.map(toTerm);
}

/**
 * Adds to each Term what overrides it or what it overrides, as far as `readable` lets its reader see:
 * a Project Term names the Workspace Term it replaces, and a Workspace Term the Project Terms replacing it.
 */
export async function withOverrides(db: Queryable, workspaceId: string, terms: StoredTerm[], readable: Readable): Promise<Term[]> {
  if (terms.length === 0) return [];
  const names = [...new Set(terms.map((t) => t.name.toLowerCase()))];
  const { rows } = await db.query<{ id: string; name: string; definition: string; project_key: string | null }>(
    `SELECT t.id, t.name, t.definition, p.key AS project_key FROM terms t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.workspace_id = $1 AND lower(t.name) = ANY($2::text[])
       AND (t.project_id = ANY($3::uuid[]) OR (t.project_id IS NULL AND $4::uuid IS NOT NULL))
     ORDER BY p.key NULLS FIRST`,
    [workspaceId, names, readable.projectIds, readable.workspaceId],
  );
  return terms.map((term) => {
    const same = rows.filter((r) => r.name.toLowerCase() === term.name.toLowerCase());
    if (term.projectId === null) {
      return { ...term, overrides: null, overriddenBy: same.filter((r) => r.project_key !== null).map((r) => ({ id: r.id, name: r.name, projectKey: r.project_key! })) };
    }
    const workspaceTerm = same.find((r) => r.project_key === null);
    return { ...term, overrides: workspaceTerm ? { id: workspaceTerm.id, name: workspaceTerm.name, definition: workspaceTerm.definition } : null, overriddenBy: [] };
  });
}

/**
 * Saves a new Version of a Term with `fields`, unless it would change nothing, or refuses if another
 * Term of its place has the new name. Pass a Term locked with `forUpdate`, inside a transaction.
 */
export async function saveTermVersion(
  db: Queryable,
  workspaceId: string,
  term: StoredTerm,
  save: { fields: TermFields; actor: Actor | StoredActor; now: Date },
): Promise<StoredTerm | "name taken"> {
  const fields = tidyFields(save.fields);
  const same =
    fields.name === term.name &&
    fields.definition === term.definition &&
    fields.group === term.group &&
    fields.avoid.length === term.avoid.length &&
    fields.avoid.every((w, i) => w === term.avoid[i]);
  if (same) return term;
  const place = { workspaceId, projectId: term.projectId };
  if (fields.name.toLowerCase() !== term.name.toLowerCase()) {
    await lockNames(db, place);
    if (await nameTaken(db, place, fields.name, term.id)) return "name taken";
  }
  const number = term.version + 1;
  await insertTermVersion(db, term.id, { number, ...fields, at: save.now, actor: save.actor });
  await db.query("UPDATE terms SET name = $2, definition = $3, avoid = $4, group_name = $5, version = $6, updated_at = $7 WHERE id = $1", [
    term.id,
    fields.name,
    fields.definition,
    fields.avoid,
    fields.group,
    number,
    save.now,
  ]);
  await recordMentions(db, { kind: "term", id: term.id });
  if (fields.name !== term.name) await recordMentionsOfNames(db, place, [term.name, fields.name]);
  return { ...term, ...fields, version: number, updatedAt: save.now };
}

/** The Protected Workspace Term named `name`, ignoring case, if there is one: a Project Term of that name would replace it. */
export async function findProtectedWorkspaceTerm(db: Queryable, workspaceId: string, name: string): Promise<StoredTerm | undefined> {
  const { rows } = await db.query<TermRow>(`${SELECT_TERMS} WHERE t.workspace_id = $1 AND t.project_id IS NULL AND t.protected AND lower(t.name) = lower($2)`, [
    workspaceId,
    name.trim(),
  ]);
  return rows[0] && toTerm(rows[0]);
}

/** Deletes a Term and its Versions, and what mentions it then mentions any Workspace Term it overrode. Run inside a transaction. */
export async function deleteTerm(db: Queryable, workspaceId: string, term: StoredTerm): Promise<void> {
  await db.query("DELETE FROM terms WHERE id = $1", [term.id]);
  if (term.projectId !== null) await recordMentionsOfNames(db, { workspaceId, projectId: term.projectId }, [term.name]);
}

/** One saved state of a Term, with the Actor who saved it. */
export interface TermVersion extends TermFields {
  number: number;
  at: Date;
  actor: RecordedActor;
  /** The Suggestion a User accepted to make it, unchanged or edited; null for a Version saved otherwise. */
  suggestion: VersionSuggestion | null;
}

interface TermVersionRow extends RecordedActorRow {
  number: number;
  name: string;
  definition: string;
  avoid: string[];
  group_name: string | null;
  at: Date;
}

/** A Term's Versions, newest first. */
export async function listTermVersions(db: Queryable, termId: string): Promise<TermVersion[]> {
  const { rows } = await db.query<TermVersionRow>(
    `SELECT v.number, v.name, v.definition, v.avoid, v.group_name, v.at,
            u.id AS user_id, u.name AS user_name, a.id AS agent_id, a.name AS agent_name, v.actor_session_id AS session_id
     FROM term_versions v JOIN users u ON u.id = v.actor_user_id LEFT JOIN agents a ON a.id = v.actor_agent_id
     WHERE v.term_id = $1 ORDER BY v.number DESC`,
    [termId],
  );
  const versions = rows.map((r) => ({
    number: r.number,
    name: r.name,
    definition: r.definition,
    avoid: r.avoid,
    group: r.group_name,
    at: r.at,
    actor: toRecordedActor(r),
  }));
  return withSuggestions(db, { kind: "term", id: termId }, versions);
}
