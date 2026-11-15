import type { LiveUpdates } from "../live/live-updates.js";
import { projectTopic, ticketTopic } from "../live/topics.js";

/** A Ticket, as far as telling its watchers it changed needs it. */
export interface ChangedTicket {
  id: string;
  key: string;
  projectId: string;
}

/**
 * Tells the watchers of each Ticket, and of its Project's list and board, that it changed: a
 * `changed` event naming its key. Call once the change is committed. Repeats are sent once.
 */
export function ticketsChanged(live: LiveUpdates, tickets: (ChangedTicket | null | undefined)[]): void {
  const seen = new Set<string>();
  for (const ticket of tickets) {
    if (!ticket || seen.has(ticket.id)) continue;
    seen.add(ticket.id);
    const event = { event: "changed", data: { ticket: ticket.key } };
    live.publish(ticketTopic(ticket.id), event);
    live.publish(projectTopic(ticket.projectId), event);
  }
}

/** Tells the watchers of a Project's list and board that its Statuses changed: a `changed` event naming no Ticket. */
export function statusesChanged(live: LiveUpdates, projectId: string): void {
  live.publish(projectTopic(projectId), { event: "changed", data: { ticket: null } });
}
