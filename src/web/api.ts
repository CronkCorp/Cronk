/** A thin client for the Cronk HTTP API. The UI holds no rules; the API decides. */

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
}

export type Role = "admin" | "member";
export type Access = "read" | "write";
export type Visibility = "open" | "private";
/** The most a Project (or the Workspace) lets Agents do in it. */
export type AgentAccess = "none" | Access;

export interface Agent {
  id: string;
  name: string;
  owner: { id: string; name: string };
  createdAt: string;
  /** The Agent's live Agent Sessions, oldest first. */
  sessions: AgentSession[];
}

/** One continuous connection of an Agent, from connect to disconnect. */
export interface AgentSession {
  id: string;
  startedAt: string;
  lastSeenAt: string;
  /** When the Session ends if the Agent stays silent until then. */
  endsIfSilentAt: string;
}

/** How the UI names an Agent Session: by the start of its id, e.g. "session a3f2". */
export const sessionName = (id: string) => `session ${id.slice(0, 4)}`;

export interface AgentToken {
  id: string;
  readOnly: boolean;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

export interface Member {
  user: User;
  access: Access;
}

export interface Workspace {
  name: string;
  agentAccess: AgentAccess;
}

/** The fixed Status Categories, in workflow order, with their display names. */
export const STATUS_CATEGORIES = [
  ["backlog", "Backlog"],
  ["unstarted", "Unstarted"],
  ["started", "Started"],
  ["in_review", "In Review"],
  ["completed", "Completed"],
  ["canceled", "Canceled"],
] as const;

export type StatusCategory = (typeof STATUS_CATEGORIES)[number][0];

export interface Status {
  id: string;
  name: string;
  category: StatusCategory;
}

export interface Project {
  id: string;
  name: string;
  key: string;
  archived: boolean;
  visibility: Visibility;
  agentAccess: AgentAccess;
  /** What the signed-in User may do in the Project. */
  access: Access;
}

export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface UserRef {
  id: string;
  name: string;
}

/** Another Ticket as a parent or history entry names it. */
export interface TicketName {
  key: string;
  title: string;
}

/** Another Ticket as a Ticket lists it among its Sub-Tickets or relations. */
export interface TicketRef extends TicketName {
  status: Status;
}

export interface Ticket {
  key: string;
  projectKey: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  labels: string[];
  assignee: UserRef | null;
  parent: TicketName | null;
  createdAt: string;
  updatedAt: string;
}

export type RelationKind = "blocks" | "blocked_by" | "relates_to";

export interface Relations {
  blocks: TicketRef[];
  blockedBy: TicketRef[];
  relatesTo: TicketRef[];
}

/** A Ticket with the Tickets around it, as its page shows it. */
export interface TicketDetail {
  ticket: Ticket;
  subTickets: TicketRef[];
  relations: Relations;
}

/** Narrows a Project's Ticket list; `assignee` takes a User id or `none`. */
export interface TicketFilter {
  status?: string;
  category?: StatusCategory;
  assignee?: string;
  priority?: Priority;
  label?: string;
}

export interface TicketChanges {
  title?: string;
  description?: string;
  statusId?: string;
  priority?: Priority;
  labels?: string[];
  assigneeId?: string | null;
  parentKey?: string | null;
}


/** Who made a change: a User, or an Agent with the Owner it acted for and the Agent Session it was in, if any. */
export type RecordedActor =
  | { kind: "user"; id: string; name: string }
  | { kind: "agent"; id: string; name: string; owner: { id: string; name: string }; session: { id: string } | null };


export type RecordedChange = { at: string; actor: RecordedActor } & (
  | { change: "created"; title: string; description: string; status: Status }
  | { change: "title"; from: string; to: string }
  | { change: "description"; from: string; to: string }
  | { change: "status"; from: Status; to: Status }
  | { change: "priority"; from: Priority; to: Priority }
  | { change: "labels"; from: string[]; to: string[] }
  | { change: "assignee"; from: UserRef | null; to: UserRef | null }
  | { change: "parent"; from: TicketName | null; to: TicketName | null }
  | { change: "relation added" | "relation removed"; kind: RelationKind; ticket: TicketName }
);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

export const api = {
  setupRequired: () => request<{ required: boolean }>("GET", "/api/setup").then((r) => r.required),
  setup: (input: { email: string; password: string; name: string; workspaceName?: string }) =>
    request<{ user: User }>("POST", "/api/setup", input).then((r) => r.user),
  signIn: (email: string, password: string) =>
    request<{ user: User }>("POST", "/api/sign-in", { email, password }).then((r) => r.user),
  signOut: () => request<void>("DELETE", "/api/sign-in"),
  me: () => request<{ user: User }>("GET", "/api/me").then((r) => r.user),
  workspace: () => request<Workspace>("GET", "/api/workspace"),
  updateWorkspace: (changes: { name?: string; agentAccess?: AgentAccess }) => request<Workspace>("PATCH", "/api/workspace", changes),

  agents: (all = false) => request<{ agents: Agent[] }>("GET", `/api/agents${all ? "?all=true" : ""}`).then((r) => r.agents),
  createAgent: (name: string) => request<{ agent: Agent }>("POST", "/api/agents", { name }).then((r) => r.agent),
  renameAgent: (id: string, name: string) =>
    request<{ agent: Agent }>("PATCH", `/api/agents/${encodeURIComponent(id)}`, { name }).then((r) => r.agent),
  removeAgent: (id: string) => request<void>("DELETE", `/api/agents/${encodeURIComponent(id)}`),
  agentTokens: (id: string) =>
    request<{ tokens: AgentToken[] }>("GET", `/api/agents/${encodeURIComponent(id)}/tokens`).then((r) => r.tokens),
  issueAgentToken: (id: string, readOnly: boolean) =>
    request<{ token: AgentToken; secret: string }>("POST", `/api/agents/${encodeURIComponent(id)}/tokens`, { readOnly }),
  revokeAgentToken: (id: string, tokenId: string) =>
    request<void>("DELETE", `/api/agents/${encodeURIComponent(id)}/tokens/${encodeURIComponent(tokenId)}`),

  users: () => request<{ users: User[] }>("GET", "/api/users").then((r) => r.users),
  updateUser: (id: string, changes: { role?: Role; active?: boolean }) =>
    request<{ user: User }>("PATCH", `/api/users/${encodeURIComponent(id)}`, changes).then((r) => r.user),
  invitations: () => request<{ invitations: Invitation[] }>("GET", "/api/invitations").then((r) => r.invitations),
  invite: (input: { email: string; role: Role }) =>
    request<{ invitation: Invitation; token: string }>("POST", "/api/invitations", input),
  withdrawInvitation: (id: string) => request<void>("DELETE", `/api/invitations/${encodeURIComponent(id)}`),
  invitation: (token: string) =>
    request<{ email: string; role: Role; workspaceName: string }>("GET", `/api/invitations/${encodeURIComponent(token)}`),
  acceptInvitation: (token: string, input: { name: string; password: string }) =>
    request<{ user: User }>("POST", `/api/invitations/${encodeURIComponent(token)}/accept`, input).then((r) => r.user),

  projects: (archived = false) =>
    request<{ projects: Project[] }>("GET", `/api/projects${archived ? "?archived=true" : ""}`).then((r) => r.projects),
  createProject: (input: { name: string; key: string }) =>
    request<{ project: Project }>("POST", "/api/projects", input).then((r) => r.project),
  project: (key: string) => request<{ project: Project; statuses: Status[] }>("GET", `/api/projects/${encodeURIComponent(key)}`),
  updateProject: (key: string, changes: { name?: string; archived?: boolean; visibility?: Visibility; agentAccess?: AgentAccess }) =>
    request<{ project: Project }>("PATCH", `/api/projects/${encodeURIComponent(key)}`, changes).then((r) => r.project),
  members: (key: string) =>
    request<{ members: Member[] }>("GET", `/api/projects/${encodeURIComponent(key)}/members`).then((r) => r.members),
  setMember: (key: string, userId: string, access: Access) =>
    request<{ member: Member }>("PUT", `/api/projects/${encodeURIComponent(key)}/members/${encodeURIComponent(userId)}`, { access }),
  removeMember: (key: string, userId: string) =>
    request<void>("DELETE", `/api/projects/${encodeURIComponent(key)}/members/${encodeURIComponent(userId)}`),

  addStatus: (projectKey: string, input: { name: string; category: StatusCategory }) =>
    request<{ status: Status }>("POST", `/api/projects/${encodeURIComponent(projectKey)}/statuses`, input).then((r) => r.status),
  /** `position` counts from 0 among the Statuses of the same Status Category. */
  updateStatus: (projectKey: string, statusId: string, changes: { name?: string; position?: number }) =>
    request<{ status: Status }>("PATCH", `/api/projects/${encodeURIComponent(projectKey)}/statuses/${encodeURIComponent(statusId)}`, changes).then(
      (r) => r.status,
    ),
  /** `moveTo` is where the Status's Tickets go; required while any Ticket is in it. */
  removeStatus: (projectKey: string, statusId: string, moveTo?: string) =>
    request<void>(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectKey)}/statuses/${encodeURIComponent(statusId)}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ""}`,
    ),

  labels: (projectKey: string) =>
    request<{ labels: string[] }>("GET", `/api/projects/${encodeURIComponent(projectKey)}/labels`).then((r) => r.labels),
  tickets: (projectKey: string, filter: TicketFilter = {}) => {
    const query = new URLSearchParams(Object.entries(filter).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const search = query.size ? `?${query}` : "";
    return request<{ tickets: Ticket[] }>("GET", `/api/projects/${encodeURIComponent(projectKey)}/tickets${search}`).then((r) => r.tickets);
  },
  createTicket: (projectKey: string, input: { title: string; description?: string }) =>
    request<{ ticket: Ticket }>("POST", `/api/projects/${encodeURIComponent(projectKey)}/tickets`, input).then((r) => r.ticket),
  ticket: (key: string) => request<TicketDetail>("GET", `/api/tickets/${encodeURIComponent(key)}`),
  updateTicket: (key: string, changes: TicketChanges) =>
    request<{ ticket: Ticket }>("PATCH", `/api/tickets/${encodeURIComponent(key)}`, changes).then((r) => r.ticket),
  addRelation: (key: string, kind: RelationKind, ticketKey: string) =>
    request<{ relations: Relations }>("POST", `/api/tickets/${encodeURIComponent(key)}/relations`, { kind, ticketKey }).then(
      (r) => r.relations,
    ),
  removeRelation: (key: string, kind: RelationKind, otherKey: string) =>
    request<{ relations: Relations }>(
      "DELETE",
      `/api/tickets/${encodeURIComponent(key)}/relations/${kind}/${encodeURIComponent(otherKey)}`,
    ).then((r) => r.relations),
  ticketHistory: (key: string) =>
    request<{ changes: RecordedChange[] }>("GET", `/api/tickets/${encodeURIComponent(key)}/history`).then((r) => r.changes),
};
