import { actingUser, userActor, type Actor, type AgentActor, type RecordedActor, type StoredActor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { canRead, requireAdmin, requireProjectAccess, requireWorkspaceAccess, type Access } from "../identity/access.js";
import type { User } from "../identity/users.js";
import { findProjectById, findProjectByKey } from "../work/projects.js";
import { ticketKeySql } from "../work/tickets.js";
import { sourceClaimOf } from "../coordination/sources.js";
import { findDecisionById, findDecisionByKey, findDecisionVersion, saveDecision, contentOf as decisionContentOf } from "./decisions.js";
import { findDocument, findVersion, insertDocument, saveVersion, type Document } from "./documents.js";
import { getGuidance, guidanceAt, listGuidanceVersions, writeGuidance } from "./guidance.js";
import { findTerm, listTermVersions, saveTermVersion, tidyFields } from "./terms.js";
import { mergeField, mergeMarkdown, type FieldConflict, type MergedSection } from "./sections.js";

/**
 * Suggestions (ADR 0014): an Agent can't change a Protected item, so it proposes the item's whole new
 * content, the Version it started from and its reasoning, parked until a User accepts or rejects it.
 * Accepting it unchanged makes it the item's next Version, credited to the Agent; a User who edits it
 * first makes the Version their own, linked to the Suggestion. One shape covers Documents, Terms,
 * Decisions and Guidance (which only Users write, so Agents always suggest changes to it).
 */

export { SUGGESTION_KINDS, SUGGESTION_STATES, type SuggestionKind, type SuggestionState } from "../../shared/values.js";
import { SUGGESTION_TEXT_FIELD, type DecisionStatus, type SuggestionKind, type SuggestionState } from "../../shared/values.js";

/**
 * What a Suggestion proposes: the item's whole content as its next Version would hold it. A Document's
 * `title` and `body`; a Term's `name`, `definition`, `avoid` and `group`; a Decision's `title`, `body`
 * and `group`; Guidance's `markdown`.
 */
export type SuggestedContent = Record<string, string | string[] | null>;

/** The fields each kind's content holds, in order. */
export const CONTENT_FIELDS: Record<SuggestionKind, readonly string[]> = {
  document: ["title", "body"],
  term: ["name", "definition", "avoid", "group"],
  decision: ["title", "body", "group"],
  guidance: ["markdown"],
};

/**
 * An item as an Agent names it to suggest a change: a Document or Term by id, a Decision by key, Guidance by its Project's
 * key (none for the Workspace's); or, for a new Document, the Document it would go under as `parentId`.
 */
export type ItemRef =
  | { kind: "document"; id: string }
  | { kind: "document"; parentId: string }
  | { kind: "term"; id: string }
  | { kind: "decision"; key: string }
  | { kind: "guidance"; project?: string | null };

/** A Suggestion's item, as it stands now. */
export interface SuggestionItem {
  kind: SuggestionKind;
  /** Null for Guidance. */
  id: string | null;
  /** A Decision's key; null for the other kinds. */
  key: string | null;
  /** A Document's or Decision's title, a Term's name; "Guidance" for Guidance. */
  title: string;
  /** A Decision's status; null for the other kinds. */
  status: DecisionStatus | null;
  /** Null for a Workspace item. */
  projectId: string | null;
  projectKey: string | null;
  protected: boolean;
  /** Its current Version: 0 for Guidance nobody has written. */
  version: number;
}

/** A Suggestion as the API answers it. */
export interface Suggestion {
  id: string;
  item: SuggestionItem;
  baseVersion: number;
  /** What the item held at `baseVersion`, in the same shape as `content`. */
  base: SuggestedContent;
  content: SuggestedContent;
  reasoning: string;
  /**
   * For a Suggestion of a new Document (`baseVersion` 0): the Document it goes under, as it stands now; once accepted, the one
   * the new Document sits under, null at the top. Null for a Suggestion changing an existing item.
   */
  parent: { id: string; title: string } | null;
  proposedBy: RecordedActor;
  at: Date;
  /** The Ticket the Agent held the Claim on when suggesting it; null for none. */
  sourceTicket: { key: string; title: string } | null;
  /** Who reviews it: the source Ticket's Assignee, else the Agent's Owner, for a Project item; null for Triage. */
  reviewer: { id: string; name: string } | null;
  state: SuggestionState;
  /** Whether the item has a newer Version than `baseVersion`, while it is open. */
  outdated: boolean;
  /** While it is outdated: the item's current Version, newer than `baseVersion`, who saved it and when; null otherwise. */
  newerVersion: { number: number; actor: RecordedActor; at: Date } | null;
  /** Whether the User changed it before accepting it; null unless accepted. */
  acceptedWithEdits: boolean | null;
  /** The Version accepting it made; null unless accepted. */
  resultVersion: number | null;
  decidedBy: { id: string; name: string } | null;
  decidedAt: Date | null;
  /** Why it was rejected; null unless rejected. */
  reason: string | null;
}

/** One loaded item a Suggestion can be on: what it holds, and how to read and save its Versions. */
interface Suggestable {
  item: SuggestionItem;
  /** Whether an Agent may change it directly, so has no need to suggest. */
  openToAgents: boolean;
  current: SuggestedContent;
  contentAt(db: Queryable, version: number): Promise<SuggestedContent | undefined>;
  /** Who saved its Version `version`, and when, if it has one. */
  savedAt(db: Queryable, version: number): Promise<Saved | undefined>;
  /**
   * Saves `content` as its next Version by `actor`; returns its number, and the id of the Document it created for a new one, or
   * why it was refused.
   */
  save(db: Queryable, content: SuggestedContent, actor: Actor | StoredActor, now: Date): Promise<{ version: number; documentId?: string } | string>;
  /** For a new Document, or one a Suggestion created: the Document it goes, or went, under (see `Suggestion.parent`). */
  parent?: { id: string; title: string } | null;
}

/** Who saved one of an item's Versions, and when. */
interface Saved {
  actor: RecordedActor;
  at: Date;
}

/** A Version's `Saved`, if there is one. */
const savedOf = (v: Saved | undefined): Saved | undefined => v && { actor: v.actor, at: v.at };

/** Where a loaded item lives, and its row's ids, as a Suggestion's columns store it. */
interface ItemColumns {
  documentId: string | null;
  /** The parent of a new Document, which has no id yet. */
  parentDocumentId: string | null;
  termId: string | null;
  decisionId: string | null;
  projectId: string | null;
}

const itemColumns = (kind: SuggestionKind, item: SuggestionItem, parent: Suggestable["parent"]): ItemColumns => ({
  documentId: kind === "document" ? item.id : null,
  parentDocumentId: kind === "document" && item.id === null ? parent!.id : null,
  termId: kind === "term" ? item.id : null,
  decisionId: kind === "decision" ? item.id : null,
  projectId: item.projectId,
});

/** A field of content `completeContent` has checked is text, as text. */
const textOf = (v: unknown) => v as string;

/** What a Document held before its first Version: what a Suggestion of a new Document starts from, at Version 0. */
const EMPTY_DOCUMENT: SuggestedContent = { title: "", body: "" };

/** The Document `id`; with the Document it sits under when `createdBySuggestion`, made by accepting a Suggestion of a new Document. */
async function documentItem(db: Queryable, workspaceId: string, id: string, createdBySuggestion = false): Promise<Suggestable | undefined> {
  const d = await findDocument(db, workspaceId, id);
  if (!d) return undefined;
  return {
    item: { kind: "document", id: d.id, key: null, title: d.title, status: null, projectId: d.projectId, projectKey: d.projectKey, protected: d.protected, version: d.version },
    openToAgents: !d.protected,
    current: { title: d.title, body: d.body },
    contentAt: async (q, n) => {
      if (n === 0) return EMPTY_DOCUMENT;
      const v = await findVersion(q, d.id, n);
      return v && { title: v.title, body: v.body };
    },
    savedAt: async (q, n) => savedOf(await findVersion(q, d.id, n)),
    save: async (q, c, actor, now) => ({ version: (await saveVersion(q, d, { title: textOf(c.title), body: textOf(c.body), actor, now })).version }),
    ...(createdBySuggestion && { parent: d.parentId === null ? null : idAndTitle(await findDocument(db, workspaceId, d.parentId)) }),
  };
}

/** A Document as `Suggestion.parent` names it. */
const idAndTitle = (d: Document | undefined) => d && { id: d.id, title: d.title };

/**
 * A new Document titled `title` under the Document `parentId`, which an Agent may not create itself while the branch there
 * is Protected: Version 0 holds nothing, and saving it creates the Document last among its siblings, at Version 1.
 */
async function newDocumentItem(db: Queryable, workspaceId: string, parentId: string, title: string): Promise<Suggestable | undefined> {
  const parent = await findDocument(db, workspaceId, parentId);
  // A Report sits outside the page tree, so nothing goes under it.
  if (!parent || parent.ticketKey !== null) return undefined;
  return {
    item: { kind: "document", id: null, key: null, title, status: null, projectId: parent.projectId, projectKey: parent.projectKey, protected: parent.protected, version: 0 },
    openToAgents: !parent.protected,
    current: EMPTY_DOCUMENT,
    contentAt: async (_, n) => (n === 0 ? EMPTY_DOCUMENT : undefined),
    savedAt: async () => undefined,
    save: async (q, c, actor, now) => {
      const tree = { workspaceId, projectId: parent.projectId };
      const created = await insertDocument(q, { tree, parentId, title: textOf(c.title), body: textOf(c.body), actor, now });
      return created === "no such parent" ? `${parent.title} is gone` : { version: created.version, documentId: created.id };
    },
    parent: idAndTitle(parent)!,
  };
}

async function termItem(db: Queryable, workspaceId: string, id: string): Promise<Suggestable | undefined> {
  const t = await findTerm(db, workspaceId, id);
  if (!t) return undefined;
  const fields = (f: { name: string; definition: string; avoid: string[]; group: string | null }) => ({ name: f.name, definition: f.definition, avoid: f.avoid, group: f.group });
  return {
    item: { kind: "term", id: t.id, key: null, title: t.name, status: null, projectId: t.projectId, projectKey: t.projectKey, protected: t.protected, version: t.version },
    openToAgents: !t.protected,
    current: fields(t),
    contentAt: async (q, n) => {
      const v = (await listTermVersions(q, t.id)).find((v) => v.number === n);
      return v && fields(v);
    },
    savedAt: async (q, n) => savedOf((await listTermVersions(q, t.id)).find((v) => v.number === n)),
    save: async (q, c, actor, now) => {
      const saved = await saveTermVersion(q, workspaceId, t, { fields: c as unknown as Parameters<typeof tidyFields>[0], actor, now });
      return saved === "name taken" ? `There is already a Term named ${textOf(c.name)} here; names are unique ignoring case` : { version: saved.version };
    },
  };
}

function decisionItem(d: Awaited<ReturnType<typeof findDecisionById>>): Suggestable | undefined {
  if (!d) return undefined;
  return {
    item: { kind: "decision", id: d.id, key: d.key, title: d.title, status: d.status, projectId: d.projectId, projectKey: d.projectKey, protected: d.protected, version: d.version },
    // An Agent edits a Decision only while it is proposed, and not then if it is Protected.
    openToAgents: d.status === "proposed" && !d.protected,
    current: { title: d.title, body: d.body, group: d.group },
    contentAt: async (q, n) => {
      const v = await findDecisionVersion(q, d, n);
      return v && { title: v.title, body: v.body, group: v.group };
    },
    savedAt: async (q, n) => savedOf(await findDecisionVersion(q, d, n)),
    save: async (q, c, actor, now) => ({
      version: (await saveDecision(q, d, { ...decisionContentOf(d), title: textOf(c.title), body: textOf(c.body), group: c.group as string | null }, actor, now)).version,
    }),
  };
}

async function guidanceItem(db: Queryable, workspaceId: string, projectId: string | null, projectKey: string | null): Promise<Suggestable> {
  const owner = { workspaceId, projectId };
  const g = await getGuidance(db, owner);
  return {
    item: { kind: "guidance", id: null, key: null, title: "Guidance", status: null, projectId, projectKey, protected: true, version: g.version },
    // Only Users write Guidance.
    openToAgents: false,
    current: { markdown: g.markdown },
    contentAt: async (q, n) => {
      const markdown = await guidanceAt(q, owner, n);
      return markdown === undefined ? undefined : { markdown };
    },
    savedAt: async (q, n) => savedOf((await listGuidanceVersions(q, owner)).find((v) => v.version === n)),
    save: async (q, c, actor, now) => {
      const saved = await writeGuidance(q, owner, { markdown: textOf(c.markdown), baseVersion: g.version, actor, now });
      return saved ? { version: saved.version } : "The Guidance changed meanwhile; try again";
    },
  };
}

/**
 * Checks `actor` has at least `need` where an item lives: in its Project (one they can't see answers 404
 * with `hiddenAs`), or in the Workspace. Writing the Workspace's Guidance takes an Admin.
 */
async function requirePlace(db: Queryable, actor: Actor, item: SuggestionItem, need: Access, hiddenAs: string): Promise<void> {
  if (item.projectId === null) {
    await requireWorkspaceAccess(db, actor, need);
    if (item.kind === "guidance" && need === "write" && actor.kind === "user") requireAdmin(actor, "change the Workspace's Guidance");
  } else {
    await requireProjectAccess(db, actor, (await findProjectById(db, item.projectId))!, need, hiddenAs);
  }
}

/** The item `ref` names, if `actor` has at least `need` where it lives. */
async function itemFor(db: Queryable, actor: Actor, ref: ItemRef, need: Access): Promise<Suggestable> {
  const workspaceId = actingUser(actor).workspaceId;
  let found: Suggestable | undefined;
  if (ref.kind === "document") found = "parentId" in ref ? await newDocumentItem(db, workspaceId, ref.parentId, "") : await documentItem(db, workspaceId, ref.id);
  else if (ref.kind === "term") found = await termItem(db, workspaceId, ref.id);
  else if (ref.kind === "decision") found = decisionItem(await findDecisionByKey(db, workspaceId, ref.key));
  else if (!ref.project) found = await guidanceItem(db, workspaceId, null, null);
  else {
    const project = await findProjectByKey(db, workspaceId, ref.project.toUpperCase());
    found = project && (await guidanceItem(db, workspaceId, project.id, project.key));
  }
  const hiddenAs = `No such ${ref.kind === "guidance" ? "Project" : NAMES[ref.kind]}`;
  if (!found) throw new HttpError(404, hiddenAs);
  await requirePlace(db, actor, found.item, need, hiddenAs);
  return found;
}

const NAMES: Record<SuggestionKind, string> = { document: "Document", term: "Term", decision: "Decision", guidance: "Guidance" };

/** How a refusal names an item, as in "the Document Architecture" or "CRONK's Guidance". */
const nameOf = (item: SuggestionItem) =>
  item.kind === "guidance"
    ? `${item.projectKey ?? "The Workspace"}'s Guidance`
    : item.kind === "decision"
      ? `${item.key}`
      : `the ${NAMES[item.kind]} ${item.title}`;

/** The stored item a Suggestion row is on, with no access check. */
async function itemOf(db: Queryable, row: SuggestionRow): Promise<Suggestable> {
  if (row.kind === "document" && row.document_id === null) return (await newDocumentItem(db, row.workspace_id, row.parent_document_id!, textOf(row.content.title)))!;
  // A Document Suggestion based on Version 0 created its Document.
  if (row.kind === "document") return (await documentItem(db, row.workspace_id, row.document_id!, row.base_version === 0))!;
  if (row.kind === "term") return (await termItem(db, row.workspace_id, row.term_id!))!;
  if (row.kind === "decision") return decisionItem(await findDecisionById(db, row.decision_id!))!;
  const project = row.project_id === null ? undefined : await findProjectById(db, row.project_id);
  return guidanceItem(db, row.workspace_id, row.project_id, project?.key ?? null);
}

/** Text of at most `max` characters, or why not; trimmed and non-blank when `required`. */
function textField(value: unknown, field: string, max: number, opts: { trim?: boolean; nonBlank?: boolean } = {}): string {
  if (typeof value !== "string") throw new HttpError(400, `content.${field} must be text`);
  const text = opts.trim ? value.trim() : value;
  if (opts.nonBlank && text === "") throw new HttpError(400, `content.${field} can't be blank`);
  if (text.length > max) throw new HttpError(400, `content.${field} is longer than ${max} characters`);
  return text;
}

/** A group as given: trimmed, and null when blank. */
function groupField(value: unknown): string | null {
  if (value !== null && typeof value !== "string") throw new HttpError(400, "content.group must be text or null");
  return value?.trim() ? textField(value, "group", 200, { trim: true }) : null;
}

/**
 * The whole content a proposal for a `kind` item holds: each field given, tidied as a save tidies it, and
 * each left out as `base` holds it. Refuses fields the kind doesn't hold.
 */
export function completeContent(kind: SuggestionKind, given: Record<string, unknown>, base: SuggestedContent): SuggestedContent {
  const fields = CONTENT_FIELDS[kind];
  const stray = Object.keys(given).find((f) => !fields.includes(f));
  if (stray) throw new HttpError(400, `A Suggestion on ${kind === "guidance" ? "" : "a "}${NAMES[kind]} holds ${fields.join(", ")}, not ${stray}`);
  const merged: Record<string, unknown> = { ...base, ...given };
  if (kind === "document") return { title: textField(merged.title, "title", 500, { trim: true, nonBlank: true }), body: textField(merged.body, "body", 1_000_000) };
  if (kind === "decision") {
    return { title: textField(merged.title, "title", 500, { trim: true, nonBlank: true }), body: textField(merged.body, "body", 1_000_000), group: groupField(merged.group) };
  }
  if (kind === "guidance") return { markdown: textField(merged.markdown, "markdown", 100_000) };
  const avoid = merged.avoid;
  if (!Array.isArray(avoid) || avoid.length > 100 || !avoid.every((w) => typeof w === "string" && w.length <= 200)) {
    throw new HttpError(400, "content.avoid must be a list of at most 100 words");
  }
  const tidy = tidyFields({
    name: textField(merged.name, "name", 200, { trim: true, nonBlank: true }),
    definition: textField(merged.definition, "definition", 100_000, { nonBlank: true }),
    avoid,
    group: groupField(merged.group),
  });
  return { name: tidy.name, definition: tidy.definition, avoid: tidy.avoid, group: tidy.group };
}

/** Whether two contents of the same kind hold the same. */
const same = (a: SuggestedContent, b: SuggestedContent) => JSON.stringify(a) === JSON.stringify(b);

/** A Suggestion's row, with what `SELECT_SUGGESTIONS` joins to it. */
interface SuggestionRow {
  id: string;
  workspace_id: string;
  kind: SuggestionKind;
  document_id: string | null;
  parent_document_id: string | null;
  term_id: string | null;
  decision_id: string | null;
  project_id: string | null;
  base_version: number;
  content: SuggestedContent;
  reasoning: string;
  at: Date;
  actor_user_id: string;
  actor_agent_id: string;
  actor_session_id: string | null;
  state: SuggestionState;
  with_edits: boolean | null;
  result_version: number | null;
  reason: string | null;
  decided_at: Date | null;
  decided_by_user_id: string | null;
  user_name: string;
  agent_name: string;
  decided_by_name: string | null;
  source_ticket_key: string | null;
  source_ticket_title: string | null;
  reviewer_id: string | null;
  reviewer_name: string | null;
}

/**
 * SQL for the User who reviews what an Agent made, from the ids of its source Ticket's Assignee and of the Agent's Owner: the Assignee,
 * else the Owner, whichever is still active; none (Triage) when neither is. Suggestions and proposed Decisions share it.
 */
export const activeReviewerSql = (assigneeId: string, ownerId: string) => `
  COALESCE(
    (SELECT x.id FROM users x WHERE x.id = ${assigneeId} AND x.deactivated_at IS NULL),
    (SELECT x.id FROM users x WHERE x.id = ${ownerId} AND x.deactivated_at IS NULL))`;

/**
 * SQL for the User who reviews the Suggestion aliased `s`, whose source Ticket is aliased `t`: on a
 * Project item, the source Ticket's Assignee, else the proposing Agent's Owner, whichever is still
 * active (see `activeReviewerSql`); none (Triage) on a Workspace item, or when neither is. Keep `usersInheritingFrom` in step with it.
 */
export const reviewerSql = (s: string, t: string) => `
  CASE WHEN ${s}.project_id IS NULL THEN NULL ELSE ${activeReviewerSql(`${t}.assignee_id`, `${s}.actor_user_id`)} END`;

const SELECT_SUGGESTIONS = `
  SELECT s.*, u.name AS user_name, a.name AS agent_name, dec.name AS decided_by_name,
         ${ticketKeySql("tp", "t")} AS source_ticket_key, t.title AS source_ticket_title, r.id AS reviewer_id, r.name AS reviewer_name
  FROM suggestions s JOIN users u ON u.id = s.actor_user_id JOIN agents a ON a.id = s.actor_agent_id
    LEFT JOIN users dec ON dec.id = s.decided_by_user_id
    LEFT JOIN tickets t ON t.id = s.source_ticket_id LEFT JOIN projects tp ON tp.id = t.project_id
    LEFT JOIN users r ON r.id = (${reviewerSql("s", "t")})`;

async function toSuggestion(db: Queryable, row: SuggestionRow): Promise<Suggestion> {
  const { item, contentAt, savedAt, parent } = await itemOf(db, row);
  const outdated = row.state === "open" && item.version !== row.base_version;
  const newer = outdated ? await savedAt(db, item.version) : undefined;
  return {
    id: row.id,
    item,
    baseVersion: row.base_version,
    base: (await contentAt(db, row.base_version)) ?? {},
    content: row.content,
    reasoning: row.reasoning,
    parent: parent ?? null,
    proposedBy: {
      kind: "agent",
      id: row.actor_agent_id,
      name: row.agent_name,
      owner: { id: row.actor_user_id, name: row.user_name },
      session: row.actor_session_id === null ? null : { id: row.actor_session_id },
    },
    at: row.at,
    sourceTicket: row.source_ticket_key === null ? null : { key: row.source_ticket_key, title: row.source_ticket_title! },
    reviewer: row.reviewer_id === null ? null : { id: row.reviewer_id, name: row.reviewer_name! },
    state: row.state,
    outdated,
    newerVersion: newer ? { number: item.version, ...newer } : null,
    acceptedWithEdits: row.with_edits,
    resultVersion: row.result_version,
    decidedBy: row.decided_by_user_id === null ? null : { id: row.decided_by_user_id, name: row.decided_by_name! },
    decidedAt: row.decided_at,
    reason: row.reason,
  };
}

/** The Suggestion with this id in the Workspace, if there is one, with no access check. */
export async function findSuggestion(db: Queryable, workspaceId: string, id: string): Promise<Suggestion | undefined> {
  const { rows } = await db.query<SuggestionRow>(`${SELECT_SUGGESTIONS} WHERE s.workspace_id = $1 AND s.id = $2`, [workspaceId, id]);
  return rows[0] && toSuggestion(db, rows[0]);
}

/** The Suggestions with these ids, in that order, with no access check. */
export async function findSuggestionsByIds(db: Queryable, ids: string[]): Promise<Suggestion[]> {
  const { rows } = await db.query<SuggestionRow>(`${SELECT_SUGGESTIONS} WHERE s.id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return Promise.all(ids.flatMap((id) => (byId.has(id) ? [toSuggestion(db, byId.get(id)!)] : [])));
}

/** The Suggestion with this id, if `actor` has at least `need` where its item lives (one they can't see answers 404). */
export async function suggestionFor(db: Queryable, actor: Actor, id: string, need: Access): Promise<Suggestion> {
  const found = await findSuggestion(db, actingUser(actor).workspaceId, id);
  if (!found) throw new HttpError(404, "No such Suggestion");
  await requirePlace(db, actor, found.item, need, "No such Suggestion");
  return found;
}

/** The Suggestions the Agent made, newest first, on items it can still read; only those in `states` when given. */
export async function listAgentSuggestions(db: Queryable, agent: AgentActor, states?: SuggestionState[]): Promise<Suggestion[]> {
  const { rows } = await db.query<SuggestionRow>(
    `${SELECT_SUGGESTIONS} WHERE s.actor_agent_id = $1 AND ($2::text[] IS NULL OR s.state = ANY($2::text[])) ORDER BY s.at DESC, s.id`,
    [agent.agent.id, states ?? null],
  );
  const places = new Map<string | null, boolean>();
  for (const projectId of new Set(rows.map((r) => r.project_id))) places.set(projectId, await canRead(db, agent, projectId));
  return Promise.all(rows.filter((r) => places.get(r.project_id)).map((r) => toSuggestion(db, r)));
}

/** What an Agent sends to suggest a change. */
export interface NewSuggestion {
  item: ItemRef;
  baseVersion: number;
  /** Fields left out keep what the base Version holds. */
  content: Record<string, unknown>;
  reasoning: string;
  ticket?: string;
}

/**
 * Records `actor`'s Suggestion of a new Version of an item it may not change itself, based on a Version
 * the item has. Only Agents suggest; a User changes the item directly. Run inside a transaction.
 */
export async function createSuggestion(db: Queryable, actor: Actor, input: NewSuggestion, now: Date): Promise<Suggestion> {
  if (actor.kind === "user") throw new HttpError(403, "Only an Agent makes a Suggestion; a User with Write changes the item directly");
  const { item, openToAgents, contentAt, parent } = await itemFor(db, actor, input.item, "write");
  const isNew = item.kind === "document" && item.id === null;
  if (openToAgents) {
    throw new HttpError(
      409,
      isNew
        ? `${parent!.title} isn't Protected, so you may create Documents under it directly; Suggestions are for protected branches`
        : `${capitalize(nameOf(item))} isn't Protected, so you may change it directly; Suggestions are for Protected items`,
    );
  }
  if (isNew && input.baseVersion !== 0) throw new HttpError(400, "A new Document starts from nothing: suggest it with baseVersion 0");
  const base = await contentAt(db, input.baseVersion);
  if (!base) throw new HttpError(404, `${capitalize(nameOf(item))} has no Version ${input.baseVersion}`);
  const content = completeContent(item.kind, input.content, base);
  if (same(content, base)) throw new HttpError(400, `This Suggestion changes nothing from Version ${input.baseVersion}`);
  const reasoning = input.reasoning.trim();
  if (!reasoning) throw new HttpError(400, "A Suggestion needs reasoning: why the change, so a User can judge it");
  const source = await sourceClaimOf(db, actor, item.projectId, input.ticket, now, "a Suggestion");
  const where = itemColumns(item.kind, item, parent);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO suggestions (workspace_id, kind, document_id, term_id, decision_id, project_id, base_version, content, reasoning, at,
       actor_user_id, actor_agent_id, actor_session_id, source_ticket_id, parent_document_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [
      actingUser(actor).workspaceId,
      item.kind,
      where.documentId,
      where.termId,
      where.decisionId,
      where.projectId,
      input.baseVersion,
      JSON.stringify(content),
      reasoning,
      now,
      actor.owner.id,
      actor.agent.id,
      actor.session?.id ?? null,
      source?.ticketId ?? null,
      where.parentDocumentId,
    ],
  );
  return (await findSuggestion(db, actingUser(actor).workspaceId, rows[0]!.id))!;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One field of a Suggestion's content merged with the item's current Version. */
export interface MergedContentField {
  field: string;
  /** The merged value; null when it conflicts, and for a group, also when there is none. */
  value: string | string[] | null;
  /** For a field that merges whole: each side's value, set when both changed it differently. */
  conflict: FieldConflict<string | string[] | null> | null;
  /** For the Markdown field: its sections, in order, conflicting ones included; null for a field that merges whole. */
  sections: MergedSection[] | null;
}

/** An outdated Suggestion's content merged with the item's current Version, from its base Version as the common ancestor. */
export interface SuggestionMerge {
  /** The item's current Version the merge is onto; accept the settled result with it as `onto`. */
  onto: number;
  /** What the item holds at `onto`. */
  current: SuggestedContent;
  /** The merged content; null while any field conflicts. */
  content: SuggestedContent | null;
  /** Each field of the kind's content, in order. */
  fields: MergedContentField[];
  /** How many sections of the Markdown field conflict, plus one for each other field that does. */
  conflicts: number;
}

/** Whether a merged field still needs a User's choice. */
const conflicted = (f: MergedContentField) => f.conflict !== null || (f.sections ?? []).some((s) => s.conflict !== null);

/**
 * Three-way merges two edits of a Term's words to avoid, word by word and ignoring case, so it never conflicts: `theirs`, less
 * the words `mine` removed from `base`, then the words only `mine` added.
 */
function mergeWords(base: string[], mine: string[], theirs: string[]): string[] {
  const has = (list: string[], word: string) => list.some((w) => w.toLowerCase() === word.toLowerCase());
  const removedByMine = base.filter((w) => !has(mine, w));
  const addedByMine = mine.filter((w) => !has(base, w) && !has(theirs, w));
  return [...theirs.filter((w) => !has(removedByMine, w)), ...addedByMine];
}

/**
 * Three-way merges `mine` (the Suggestion's content) and `theirs` (the item's current content), both changed from `base`: the
 * Markdown field section by section, a Term's words to avoid word by word, and every other field whole, taken from the side
 * that changed it, or a conflict when both did, differently.
 */
function mergeContent(kind: SuggestionKind, base: SuggestedContent, mine: SuggestedContent, theirs: SuggestedContent, onto: number): SuggestionMerge {
  const fields = CONTENT_FIELDS[kind].map((field): MergedContentField => {
    if (field === SUGGESTION_TEXT_FIELD[kind]) {
      const m = mergeMarkdown(textOf(base[field] ?? ""), textOf(mine[field]), textOf(theirs[field]));
      return { field, value: m.markdown, conflict: null, sections: m.sections };
    }
    if (field === "avoid") {
      return { field, value: mergeWords(base.avoid as string[], mine.avoid as string[], theirs.avoid as string[]), conflict: null, sections: null };
    }
    const m = mergeField(base[field] ?? null, mine[field] ?? null, theirs[field] ?? null, (a, b) => JSON.stringify(a) === JSON.stringify(b));
    return { field, value: m.merged, conflict: m.conflict, sections: null };
  });
  const clean = !fields.some(conflicted);
  return {
    onto,
    current: theirs,
    content: clean ? Object.fromEntries(fields.map((f) => [f.field, f.value])) : null,
    fields,
    conflicts: fields.reduce((n, f) => n + (f.conflict ? 1 : 0) + (f.sections ?? []).filter((s) => s.conflict).length, 0),
  };
}

/** An open Suggestion's content merged with its item's current Version, if `actor` can read where the item lives. */
export async function mergeSuggestion(db: Queryable, actor: Actor, id: string): Promise<SuggestionMerge> {
  const suggestion = await suggestionFor(db, actor, id, "read");
  if (suggestion.state !== "open") throw new HttpError(409, `This Suggestion was ${suggestion.state} already`);
  const { rows } = await db.query<SuggestionRow>(`${SELECT_SUGGESTIONS} WHERE s.id = $1`, [id]);
  const item = await itemOf(db, rows[0]!);
  return mergeContent(item.item.kind, suggestion.base, suggestion.content, item.current, item.item.version);
}

/** Locks an open Suggestion `user` may decide on, with its item; refuses one already decided. */
async function lockOpen(db: Queryable, user: User, id: string): Promise<{ suggestion: Suggestion; item: Suggestable }> {
  const actor = userActor(user);
  const { rows } = await db.query<{ id: string }>("SELECT id FROM suggestions WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [user.workspaceId, id]);
  if (!rows[0]) throw new HttpError(404, "No such Suggestion");
  const suggestion = await suggestionFor(db, actor, id, "write");
  if (suggestion.state !== "open") throw new HttpError(409, `This Suggestion was ${suggestion.state} already`);
  const lock = { document: "documents", term: "terms", decision: "decisions" } as const;
  // A new Document has no row yet; creating it locks its page tree.
  if (suggestion.item.kind !== "guidance" && suggestion.item.id !== null) await db.query(`SELECT 1 FROM ${lock[suggestion.item.kind]} WHERE id = $1 FOR UPDATE`, [suggestion.item.id]);
  const { rows: stored } = await db.query<SuggestionRow>(`${SELECT_SUGGESTIONS} WHERE s.id = $1`, [id]);
  return { suggestion, item: await itemOf(db, stored[0]!) };
}

/** How accepting a Suggestion is asked for: with the User's `content`, and the item's Version `onto` which they merged an outdated one. */
export interface Acceptance {
  content?: Record<string, unknown>;
  onto?: number;
}

/**
 * Accepts an open Suggestion by `user`, who has Write where its item lives, making it the item's next
 * Version: as suggested, credited to the Agent; or, with `edited` content that differs, as edited,
 * credited to the User and linked to the Suggestion. An outdated one, whose item has a newer Version than
 * its base, is merged with that Version (ADR 0014), and the result is the User's, linked to the Suggestion:
 * clean merges take the side that changed each part, and conflicting parts need the User's `content`.
 * Accepting an outdated one needs `onto`, the Version the User saw it merged onto. Run inside a transaction. Returns the accepted Suggestion.
 */
export async function acceptSuggestion(db: Queryable, user: User, id: string, acceptance: Acceptance, now: Date): Promise<Suggestion> {
  const { suggestion, item } = await lockOpen(db, user, id);
  const { content: edited, onto } = acceptance;
  const name = capitalize(nameOf(item.item));
  if (onto !== undefined && onto !== item.item.version) {
    throw new HttpError(409, `${name} is at Version ${item.item.version} now, not Version ${onto} you merged onto; merge it again`);
  }
  let content: SuggestedContent;
  let withEdits: boolean;
  if (item.item.version === suggestion.baseVersion) {
    content = edited === undefined ? suggestion.content : completeContent(item.item.kind, edited, suggestion.content);
    withEdits = !same(content, suggestion.content);
  } else {
    // Only a User who saw the merge accepts it, so it never takes in a Version they didn't see.
    if (onto === undefined) {
      throw new HttpError(
        409,
        `${name} is at Version ${item.item.version}, newer than Version ${suggestion.baseVersion} this Suggestion is based on, so it is outdated: ` +
          `merge it (POST /api/suggestions/{id}/merge) and accept with \`onto\` ${item.item.version}`,
      );
    }
    const merge = mergeContent(item.item.kind, suggestion.base, suggestion.content, item.current, item.item.version);
    const open = merge.fields.filter((f) => conflicted(f) && !(edited && f.field in edited)).map((f) => f.field);
    if (open.length > 0) {
      throw new HttpError(
        409,
        `${name} is at Version ${item.item.version}, newer than Version ${suggestion.baseVersion} this Suggestion is based on, and merging them leaves ` +
          `${open.join(" and ")} conflicting: settle ${open.length === 1 ? "it" : "them"} and accept with \`content\` and \`onto\` ${item.item.version}`,
      );
    }
    const clean = Object.fromEntries(merge.fields.filter((f) => !conflicted(f)).map((f) => [f.field, f.value]));
    content = completeContent(item.item.kind, edited ?? {}, clean);
    // A merge counts as the User's edit, whatever it holds.
    withEdits = true;
  }
  if (same(content, item.current)) throw new HttpError(400, "Accepting it like this would change nothing; reject it instead");
  // Only Agents make Suggestions, so it records an Agent, with the Owner it acted for.
  const proposedBy = suggestion.proposedBy as Extract<RecordedActor, { kind: "agent" }>;
  const agent: StoredActor = { kind: "agent", userId: proposedBy.owner.id, agentId: proposedBy.id, sessionId: proposedBy.session?.id ?? null };
  const saved = await item.save(db, content, withEdits ? userActor(user) : agent, now);
  if (typeof saved === "string") throw new HttpError(409, saved);
  // Accepting a new Document's Suggestion created it, which the Suggestion now names in place of its parent.
  await db.query(
    `UPDATE suggestions SET state = 'accepted', with_edits = $2, result_version = $3, decided_at = $4, decided_by_user_id = $5,
       document_id = coalesce($6, document_id), parent_document_id = NULL
     WHERE id = $1`,
    [id, withEdits, saved.version, now, user.id, saved.documentId ?? null],
  );
  return (await findSuggestion(db, user.workspaceId, id))!;
}

/** Rejects an open Suggestion by `user`, who has Write where its item lives, for `reason`. Run inside a transaction. */
export async function rejectSuggestion(db: Queryable, user: User, id: string, reason: string, now: Date): Promise<Suggestion> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "Rejecting a Suggestion needs a reason, so the Agent that made it knows why");
  await lockOpen(db, user, id);
  await db.query("UPDATE suggestions SET state = 'rejected', reason = $2, decided_at = $3, decided_by_user_id = $4 WHERE id = $1", [id, why, now, user.id]);
  return (await findSuggestion(db, user.workspaceId, id))!;
}
