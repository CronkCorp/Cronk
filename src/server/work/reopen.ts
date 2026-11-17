import { actingUser, type Actor } from "../actor.js";
import { HttpError } from "../context.js";
import type { ReopenChoice } from "../../shared/values.js";
import type { Queryable } from "../db/database.js";
import { visibleProjects, type Access } from "../identity/access.js";
import { ticketsBlockedBy } from "../coordination/ready.js";
import { findLiveClaim } from "../coordination/claims.js";
import { findStatusToMoveInto, listAllProjects, listStatuses, type Status } from "./projects.js";
import { findTicketsByIds, lockTicketsByIds, type AgentRef, type Ticket } from "./tickets.js";

/**
 * Reopening an Agent's Unverified completion reaches the Tickets it blocks: each one that already continued on the
 * work takes the User's choice, and every one with a Delegate is told, through a Comment that waits for its Agent.
 */

export { REOPEN_CHOICES, type ReopenChoice } from "../../shared/values.js";

/** A Ticket the Reopened one blocks, locked, with the caller's access to its Project. */
export interface Dependent {
  ticket: Ticket;
  access: Access;
}

/**
 * The Tickets `ticket` blocks that `actor` can see, locked in id order unless `lock` is false, with the caller's access
 * to each. Those they can't see take no choice and aren't told: the caller can't know of them.
 */
export async function dependentsOf(db: Queryable, actor: Actor, ticket: Ticket, { lock = true } = {}): Promise<Dependent[]> {
  const ids = await ticketsBlockedBy(db, [ticket.id]);
  const blocked = lock ? await lockTicketsByIds(db, ids) : await findTicketsByIds(db, ids);
  const projects = await visibleProjects(db, actor, await listAllProjects(db, actingUser(actor).workspaceId));
  const access = new Map(projects.map((p) => [p.id, p.access]));
  return blocked.flatMap((t) => (access.has(t.projectId) ? [{ ticket: t, access: access.get(t.projectId)! }] : []));
}

/** The choices a dependent takes: `pause` or keep for Started work, `reopen` or keep for an Unverified completion, none otherwise. */
export function choicesFor(ticket: Ticket): readonly ReopenChoice[] {
  if (ticket.status.category === "started") return ["keep", "pause"];
  if (ticket.verification === "unverified") return ["keep", "reopen"];
  return [];
}

/**
 * The Status a Pause moves `ticket` into: its Project's first Unstarted Status, locked against removal when `lock` is set.
 * Every Status Category keeps at least one Status, so there is always one, unless it is removed meanwhile.
 */
export async function pauseTarget(db: Queryable, ticket: Ticket, { lock = true } = {}): Promise<Status | undefined> {
  const first = (await listStatuses(db, ticket.projectId)).find((s) => s.category === "unstarted");
  return first && (lock ? await findStatusToMoveInto(db, ticket.projectId, first.id) : first);
}

/** A dependent as a Reopen would ask about it: what it is, what it takes, and whether the caller may change it. */
export interface DependentChoice {
  ticket: Pick<Ticket, "key" | "title" | "status" | "verification" | "delegate">;
  /** Its live Claim, if any. */
  claim: { agent: AgentRef } | null;
  /** What the caller may choose for it, the first being the default; `[]` for one that hasn't continued on the work. */
  choices: readonly ReopenChoice[];
  /** Whether the caller has Write in its Project; without it, only `keep` is accepted. */
  canChange: boolean;
  /** Only for a Started one: the Status a Pause moves it into. */
  pausesTo?: Status;
}

/**
 * What a Reopen of `ticket` would ask `actor` about each dependent they can see that isn't Canceled, in key order, with
 * the same rule the Reopen itself checks. Reads only; nothing is locked.
 */
export async function dependentChoices(db: Queryable, actor: Actor, ticket: Ticket, now: Date): Promise<DependentChoice[]> {
  const dependents = (await dependentsOf(db, actor, ticket, { lock: false })).filter((d) => d.ticket.status.category !== "canceled");
  dependents.sort((a, b) => a.ticket.projectKey.localeCompare(b.ticket.projectKey) || a.ticket.number - b.ticket.number);
  return Promise.all(
    dependents.map(async ({ ticket: t, access }) => {
      const claim = await findLiveClaim(db, t.id, now);
      const pausesTo = t.status.category === "started" ? await pauseTarget(db, t, { lock: false }) : undefined;
      return {
        ticket: { key: t.key, title: t.title, status: t.status, verification: t.verification, delegate: t.delegate },
        claim: claim ? { agent: claim.agent } : null,
        choices: choicesFor(t),
        canChange: access === "write",
        ...(pausesTo && { pausesTo }),
      };
    }),
  );
}

/**
 * Each dependent's choice in `asked` (by Ticket key, any case), checked: every dependent that takes one has a fitting
 * one, and no other Ticket has any. A dependent that continued since the caller looked gets a 409, so they choose for it.
 */
export function checkChoices(dependents: Dependent[], asked: Record<string, ReopenChoice>): Map<string, ReopenChoice> {
  const byKey = new Map(dependents.map((d) => [d.ticket.key, d.ticket]));
  const chosen = new Map<string, ReopenChoice>();
  for (const [key, choice] of Object.entries(asked)) {
    const ticket = byKey.get(key.toUpperCase());
    if (!ticket || choicesFor(ticket).length === 0) throw new HttpError(400, `${key} hasn't continued on this work, so it takes no choice`);
    if (chosen.has(ticket.id)) throw new HttpError(400, `${ticket.key} is named twice`);
    if (!choicesFor(ticket).includes(choice)) {
      throw new HttpError(400, `${ticket.key} is ${ticket.status.name}, so it takes ${choicesFor(ticket).map((c) => `\`${c}\``).join(" or ")}, not \`${choice}\``);
    }
    chosen.set(ticket.id, choice);
  }
  const unchosen = dependents.filter((d) => choicesFor(d.ticket).length > 0 && !chosen.has(d.ticket.id)).map((d) => d.ticket.key);
  if (unchosen.length > 0) throw new HttpError(409, `Choose what happens to ${unchosen.join(", ")}, which already continued on this work`);
  // Pausing or Reopening a dependent changes it, which takes Write in its Project.
  const readOnly = dependents.find((d) => (chosen.get(d.ticket.id) ?? "keep") !== "keep" && d.access !== "write");
  if (readOnly) throw new HttpError(403, `You can only read ${readOnly.ticket.key}'s Project, so you can't change it; keep it instead`);
  return chosen;
}

/** `text` as a Markdown block quote. */
const quoted = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

/**
 * The Comment telling a dependent's Agent about the Reopen of `reopened` and what it means for the dependent: kept,
 * paused into `pausedTo`, or Reopened along with it.
 */
export function dependentNote(reopened: Ticket, reason: string, outcome: { kept: Ticket } | { pausedTo: string } | { reopenedToo: true }): string {
  const what = `${reopened.key} was Reopened, and this Ticket builds on it`;
  const then =
    "pausedTo" in outcome
      ? `It is paused: its Claim is released and it is back in ${outcome.pausedTo} until ${reopened.key} is finished.`
      : "reopenedToo" in outcome
        ? "It is Reopened along with it."
        : outcome.kept.status.category === "started"
          ? "You may keep going; check whether your work is affected."
          : "Check whether the work here is affected.";
  return `${what}. ${then}\n\n${quoted(reason)}`;
}
