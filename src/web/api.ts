/** A thin client for the Cronk HTTP API. The UI holds no rules; the API decides. */

import type {
  Access,
  Agent,
  AgentAccess,
  AgentSession,
  AgentToken,
  Document,
  DocumentTreeEntry,
  IssuedAgentToken,
  Invitation,
  Member,
  Priority,
  Project,
  RecordedActor,
  RecordedChange,
  RelationKind,
  Relations,
  Role,
  Status,
  StatusCategory,
  Ticket,
  TicketChanges,
  TicketDetail,
  TicketName,
  TicketRef,
  User,
  UserRef,
  Version,
  VersionSummary,
  Visibility,
  Workspace,
} from "../server/api-types.js";

// The API's types are declared once, by the server; the UI's modules take them from here.
export type {
  Access,
  Agent,
  AgentAccess,
  AgentSession,
  AgentToken,
  Document,
  DocumentTreeEntry,
  IssuedAgentToken,
  Invitation,
  Member,
  Priority,
  Project,
  RecordedActor,
  RecordedChange,
  RelationKind,
  Relations,
  Role,
  Status,
  StatusCategory,
  Ticket,
  TicketChanges,
  TicketDetail,
  TicketName,
  TicketRef,
  User,
  UserRef,
  Version,
  VersionSummary,
  Visibility,
  Workspace,
};

/** How the UI names an Agent Session: by the start of its id, e.g. "session a3f2". */
export const sessionName = (id: string) => `session ${id.slice(0, 4)}`;

/** Narrows a Project's Ticket list; `assignee` takes a User id or `none`. */
export interface TicketFilter {
  status?: string;
  category?: StatusCategory;
  assignee?: string;
  priority?: Priority;
  label?: string;
}

export class ApiError extends Error {
  /** `body` is the whole error answer, such as `{ error, current }` for a stale save. */
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The current Version a save was refused for, if it was refused for being based on an outdated one. */
export const staleVersionOf = (err: unknown): Version | undefined =>
  err instanceof ApiError && err.status === 409 && err.body.current ? (err.body.current as Version) : undefined;

/** Where a page tree's API lives: a Project's, or the Workspace's without a Project key. */
const treePath = (projectKey?: string) => (projectKey ? `/api/projects/${encodeURIComponent(projectKey)}` : "/api/workspace");
const documentPath = (id: string) => `/api/documents/${encodeURIComponent(id)}`;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data ?? {});
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
    request<IssuedAgentToken>("POST", `/api/agents/${encodeURIComponent(id)}/tokens`, { readOnly }),
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
  documentTree: (projectKey?: string) =>
    request<{ documents: DocumentTreeEntry[] }>("GET", `${treePath(projectKey)}/documents`).then((r) => r.documents),
  createDocument: (projectKey: string | undefined, input: { title: string; body?: string; parentId?: string }) =>
    request<{ document: Document }>("POST", `${treePath(projectKey)}/documents`, input).then((r) => r.document),
  document: (id: string) => request<{ document: Document }>("GET", documentPath(id)).then((r) => r.document),
  /** Refused with the current Version (see `staleVersionOf`) if `baseVersion` is no longer current. */
  saveDocument: (id: string, input: { baseVersion: number; title?: string; body?: string }) =>
    request<{ document: Document }>("PATCH", documentPath(id), input).then((r) => r.document),
  moveDocument: (id: string, parentId: string | null) =>
    request<{ document: Document }>("POST", `${documentPath(id)}/move`, { parentId }).then((r) => r.document),
  deleteDocument: (id: string) => request<void>("DELETE", documentPath(id)),
  versions: (id: string) => request<{ versions: VersionSummary[] }>("GET", `${documentPath(id)}/versions`).then((r) => r.versions),
  version: (id: string, number: number) =>
    request<{ version: Version }>("GET", `${documentPath(id)}/versions/${number}`).then((r) => r.version),
  restoreVersion: (id: string, number: number, baseVersion: number) =>
    request<{ document: Document }>("POST", `${documentPath(id)}/versions/${number}/restore`, { baseVersion }).then((r) => r.document),

  ticketHistory: (key: string) =>
    request<{ changes: RecordedChange[] }>("GET", `/api/tickets/${encodeURIComponent(key)}/history`).then((r) => r.changes),
};
