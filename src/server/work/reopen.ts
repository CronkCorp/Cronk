import { actingUser, type Actor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { visibleProjects, type Access } from "../identity/access.js";
import { ticketsBlockedBy } from "../coordination/ready.js";
import { listAllProjects } from "./projects.js";
import { lockTicketsByIds, type Ticket } from "./tickets.js";

/**
 * Reopening an Agent's Unverified completion reaches the Tickets it blocks: each one that already continued on the
 * work takes the User's choice, and every one with a Delegate is told, through a Comment that waits for its Agent.
 */

/** What a Reopen does to a Ticket it blocks that already continued on the work. */
export const REOPEN_CHOICES = ["keep", "pause", "reopen"] as const;
export type ReopenChoice = (typeof REOPEN_CHOICES)[number];

/** A Ticket the Reopened one blocks, locked, with the caller's access to its Project. */
export interface Dependent {
  ticket: Ticket;
  access: Access;
}

/**
 * The Tickets `ticket` blocks that `actor` can see, locked in id order, with the caller's access to each. Those they
 * can't see take no choice and aren't told: the caller can't know of them.
 */
export async function dependentsOf(db: Queryable, actor: Actor, ticket: Ticket): Promise<Dependent[]> {
  const blocked = await lockTicketsByIds(db, await ticketsBlockedBy(db, [ticket.id]));
  const projects = await visibleProjects(db, actor, await listAllProjects(db, actingUser(actor).workspaceId));
  const access = new Map(projects.map((p) => [p.id, p.access]));
  return blocked.flatMap((t) => (access.has(t.projectId) ? [{ ticket: t, access: access.get(t.projectId)! }] : []));
}

/** The choices a dependent takes: `pause` or keep for Started work, `reopen` or keep for an Unverified completion, none otherwise. */
function choicesFor(ticket: Ticket): readonly ReopenChoice[] {
  if (ticket.status.category === "started") return ["keep", "pause"];
  if (ticket.verification === "unverified") return ["keep", "reopen"];
  return [];
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
