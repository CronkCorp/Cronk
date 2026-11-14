/** The live-update topics routes publish on and streams watch (see LiveUpdates). */

/** The topic of one Ticket's changes: its new Activities and Comments. */
export const ticketTopic = (ticketId: string) => `ticket:${ticketId}`;

/** The topic of changes to one User's Inbox. */
export const inboxTopic = (userId: string) => `inbox:${userId}`;

/** The topic of the work starting to wait for one Agent, which each of its live Agent Sessions may watch. */
export const agentTopic = (agentId: string) => `agent:${agentId}`;
