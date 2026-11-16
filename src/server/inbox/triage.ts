import type { Queryable } from "../db/database.js";
import { noAccessSql, visibleProjects } from "../identity/access.js";
import type { User } from "../identity/users.js";
import { userActor } from "../actor.js";
import { listAllProjects } from "../work/projects.js";
import { findSuggestionsByIds, reviewerSql } from "../knowledge/suggestions.js";
import { asTicketItems, ENTERED_STATUS_AT, ticketItems, type DiscoveredItem, type SuggestionInboxItem, type TicketItem, type UnverifiedItem } from "./inbox.js";

/**
 * Triage: the shared list of waiting items with no clear User to go to. Each User sees the items they could
 * act on, which takes Write where the item lives; Admins have Write everywhere, so they see all. An item
 * leaves Triage as soon as someone acts on it. A new item kind also belongs in the live updates (see
 * `waitingItemsChanged`), which tell Triage whenever any waiting item may have changed.
 */

/** Why an unattended Ticket's Assignee can't act on it: they are deactivated, or have no access to its Project. */
export type UnattendedReason = "deactivated" | "no_access";

/**
 * An open Ticket, delegated or In Review, whose Assignee is deactivated or can't see its Project, so it waits in an Inbox
 * no one reads until someone reassigns it.
 */
export type UnattendedItem = TicketItem<"unattended"> & { reason: UnattendedReason };

/** One item in Triage. */
export type TriageItem = UnverifiedItem | UnattendedItem | SuggestionInboxItem | DiscoveredItem;

/** The kinds of Triage item, which Triage filters by. */
export const TRIAGE_KINDS = ["unverified", "unattended", "suggestion", "discovered"] as const;

/** Narrows Triage: an item matches when, for every field given, it has one of that field's values. */
export interface TriageFilter {
  kinds?: TriageItem["kind"][];
  /** Project keys, in any case; an item on a Workspace item has none, so matches no Project filter. */
  projectKeys?: string[];
}

/** The items in Triage that `user` could act on, oldest first. */
export async function listTriage(db: Queryable, user: User, filter: TriageFilter = {}): Promise<TriageItem[]> {
  const projectIds = await writableProjectIds(db, user, filter.projectKeys);
  const inWorkspace = !filter.projectKeys?.length;
  const wants = (kind: TriageItem["kind"]) => !filter.kinds?.length || filter.kinds.includes(kind);
  const items = [
    ...(wants("unverified") ? await unverified(db, projectIds) : []),
    ...(wants("unattended") ? await unattended(db, projectIds) : []),
    ...(wants("suggestion") ? await suggestions(db, user, projectIds, inWorkspace) : []),
    ...(wants("discovered") ? await discovered(db, projectIds) : []),
  ];
  return items.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The Unverified completions of Tickets with no Assignee in the Projects `projectIds`, which any User with Write there may Accept. */
function unverified(db: Queryable, projectIds: string[]): Promise<UnverifiedItem[]> {
  return ticketItems(db, "unverified", { assigneeId: null, projectIds });
}

/** The Discovered Tickets with no Assignee waiting in the Projects `projectIds`, which any User with Write there may take. */
function discovered(db: Queryable, projectIds: string[]): Promise<DiscoveredItem[]> {
  return ticketItems(db, "discovered", { assigneeId: null, projectIds });
}

/**
 * The unattended Tickets in the Projects `projectIds`: open, delegated or In Review, with an Assignee who is deactivated or
 * has no access to the Project (see `noAccessSql`). `at` is when it entered its Status.
 */
async function unattended(db: Queryable, projectIds: string[]): Promise<UnattendedItem[]> {
  const { rows } = await db.query<{ id: string; at: Date; reason: UnattendedReason }>(
    `SELECT t.id, ${ENTERED_STATUS_AT} AS at, CASE WHEN u.deactivated_at IS NOT NULL THEN 'deactivated' ELSE 'no_access' END AS reason
     FROM tickets t JOIN statuses s ON s.id = t.status_id JOIN projects p ON p.id = t.project_id JOIN users u ON u.id = t.assignee_id
     WHERE t.project_id = ANY($1::uuid[]) AND s.category NOT IN ('completed', 'canceled')
       AND (t.delegate_id IS NOT NULL OR s.category = 'in_review')
       AND (u.deactivated_at IS NOT NULL OR ${noAccessSql("u", "p")})
     ORDER BY at, p.key, t.number`,
    [projectIds],
  );
  return asTicketItems(db, "unattended", rows);
}

/**
 * The open Suggestions nobody reviews (see `reviewerSql`): on Workspace items, which every User may change
 * but only an Admin the Workspace's Guidance, with `inWorkspace`; and on items of the Projects `projectIds`.
 */
async function suggestions(db: Queryable, user: User, projectIds: string[], inWorkspace: boolean): Promise<SuggestionInboxItem[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT s.id FROM suggestions s LEFT JOIN tickets t ON t.id = s.source_ticket_id
     WHERE s.workspace_id = $1 AND s.state = 'open' AND (${reviewerSql("s", "t")}) IS NULL
       AND (s.project_id = ANY($2::uuid[]) OR (s.project_id IS NULL AND $3 AND (s.kind <> 'guidance' OR $4)))
     ORDER BY s.at, s.id`,
    [user.workspaceId, projectIds, inWorkspace, user.role === "admin"],
  );
  return (await findSuggestionsByIds(db, rows.map((r) => r.id))).map((suggestion) => ({ kind: "suggestion", at: suggestion.at, suggestion }));
}

/** Ids of the Projects, archived or not, `user` has Write in; only those with one of `keys`, if given. */
async function writableProjectIds(db: Queryable, user: User, keys?: string[]): Promise<string[]> {
  const wanted = keys?.length ? new Set(keys.map((k) => k.toUpperCase())) : undefined;
  const projects = (await listAllProjects(db, user.workspaceId)).filter((p) => !wanted || wanted.has(p.key));
  return (await visibleProjects(db, userActor(user), projects)).filter((p) => p.access === "write").map((p) => p.id);
}
