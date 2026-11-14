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
}

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

export type StatusCategory = "backlog" | "unstarted" | "started" | "in_review" | "completed" | "canceled";

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

export interface Ticket {
  key: string;
  projectKey: string;
  title: string;
  description: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
}

/** Who made a change: a User, or an Agent with the Owner it acted for. */
export type RecordedActor =
  | { kind: "user"; id: string; name: string }
  | { kind: "agent"; id: string; name: string; owner: { id: string; name: string } };

export type RecordedChange = { at: string; actor: RecordedActor } & (
  | { change: "created"; title: string; description: string; status: Status }
  | { change: "title"; from: string; to: string }
  | { change: "description"; from: string; to: string }
  | { change: "status"; from: Status; to: Status }
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

  tickets: (projectKey: string) =>
    request<{ tickets: Ticket[] }>("GET", `/api/projects/${encodeURIComponent(projectKey)}/tickets`).then((r) => r.tickets),
  createTicket: (projectKey: string, input: { title: string; description?: string }) =>
    request<{ ticket: Ticket }>("POST", `/api/projects/${encodeURIComponent(projectKey)}/tickets`, input).then((r) => r.ticket),
  ticket: (key: string) => request<{ ticket: Ticket }>("GET", `/api/tickets/${encodeURIComponent(key)}`).then((r) => r.ticket),
  updateTicket: (key: string, changes: { title?: string; description?: string; statusId?: string }) =>
    request<{ ticket: Ticket }>("PATCH", `/api/tickets/${encodeURIComponent(key)}`, changes).then((r) => r.ticket),
  ticketHistory: (key: string) =>
    request<{ changes: RecordedChange[] }>("GET", `/api/tickets/${encodeURIComponent(key)}/history`).then((r) => r.changes),
};
