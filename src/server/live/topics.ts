/** The live-update topics routes publish on and streams watch (see LiveUpdates). */

/** The topic of one Ticket's changes: its new Activities and Comments. */
export const ticketTopic = (ticketId: string) => `ticket:${ticketId}`;

/** The topic of changes to one User's Inbox. */
export const inboxTopic = (userId: string) => `inbox:${userId}`;

/** The topic of changes to Triage, which every signed-in User's Inbox stream also carries; each User's Triage filters for themselves. */
export const TRIAGE_TOPIC = "triage";

/** The topic of the work starting to wait for one Agent, which each of its live Agent Sessions may watch. */
export const agentTopic = (agentId: string) => `agent:${agentId}`;

/** The topic of changes to one User's Agents' live Agent Sessions, which their Agents page watches. */
export const agentsTopic = (ownerId: string) => `agents:${ownerId}`;

/** The topic of changes to one Project's Tickets, which its list and board watch. */
export const projectTopic = (projectId: string) => `project:${projectId}`;

/** The topic of one Document's changes: its new Comments and Versions. */
export const documentTopic = (documentId: string) => `document:${documentId}`;

/** The topic of one Artifact's changes: its new Comments. */
export const artifactTopic = (artifactId: string) => `artifact:${artifactId}`;

/**
 * The topic of changes to one place's own Terms: the Workspace's when `projectId` is null, or one Project's.
 * A Project's Terms stream also watches the Workspace's, for a caller who can read it, as a Project lists the Workspace's Terms it doesn't override.
 */
export const termsTopic = (workspaceId: string, projectId: string | null) => `terms:${workspaceId}:${projectId ?? "workspace"}`;

/** The topic of changes to any Project's Terms in one Workspace, which the Workspace's Terms stream watches, as its Terms are answered with their overrides. */
export const projectTermsTopic = (workspaceId: string) => `project-terms:${workspaceId}`;
