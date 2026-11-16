/** A thin client for the Cronk HTTP API. The UI holds no rules; the API decides. */

import type {
  Access,
  Activity,
  ActivityKind,
  Agent,
  AgentAccess,
  AgentSession,
  AgentToken,
  AgentRecordEntry,
  Attachment,
  Comment,
  Decision,
  DecisionStatus,
  DecisionSummary,
  DecisionVersion,
  Document,
  DocumentTreeEntry,
  Guidance,
  GuidanceMerge,
  GuidanceVersion,
  InboxItem,
  InboxKind,
  IssuedAgentToken,
  Invitation,
  LinkedDocument,
  Member,
  Mention,
  Merge,
  MergedSection,
  Conflict,
  Priority,
  Project,
  ProtectionMarking,
  RecordedActor,
  RecordedChange,
  RelationKind,
  Relations,
  Report,
  ReopenChoice,
  Role,
  SearchKind,
  Storage,
  SearchResult,
  Status,
  StatusCategory,
  Term,
  TermVersion,
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
  Activity,
  ActivityKind,
  Agent,
  AgentAccess,
  AgentSession,
  AgentToken,
  AgentRecordEntry,
  Attachment,
  Comment,
  Decision,
  DecisionStatus,
  DecisionSummary,
  DecisionVersion,
  Document,
  DocumentTreeEntry,
  Guidance,
  GuidanceMerge,
  GuidanceVersion,
  InboxItem,
  InboxKind,
  IssuedAgentToken,
  Invitation,
  LinkedDocument,
  Member,
  Mention,
  Merge,
  MergedSection,
  Conflict,
  Priority,
  Project,
  ProtectionMarking,
  RecordedActor,
  RecordedChange,
  RelationKind,
  Relations,
  Report,
  ReopenChoice,
  Role,
  SearchKind,
  Storage,
  SearchResult,
  Status,
  StatusCategory,
  Term,
  TermVersion,
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

/** Narrows a Project's Ticket list; `assignee` takes a User id or `none`. */
export interface TicketFilter {
  status?: string;
  category?: StatusCategory;
  assignee?: string;
  delegate?: string;
  priority?: Priority;
  label?: string;
}

const guidancePath = (projectKey?: string) =>
  projectKey === undefined ? "/api/workspace/guidance" : `/api/projects/${encodeURIComponent(projectKey)}/guidance`;

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

/** Where a Project's API lives, for its page tree or Decisions, or the Workspace's without a Project key. */
const scopePath = (projectKey?: string) => (projectKey ? `/api/projects/${encodeURIComponent(projectKey)}` : "/api/workspace");
const decisionPath = (key: string) => `/api/decisions/${encodeURIComponent(key)}`;
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

/**
 * Sends `file` as the raw request body: typed `contentType`, or as plain bytes, as an archive is (the server tells a zip
 * from a tar, gzipped or not, by its bytes).
 */
async function upload<T>(path: string, file: Blob, contentType = "application/octet-stream"): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": contentType },
    body: file,
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data ?? {});
  return data as T;
}

/** Uploads `file` as an Attachment of the item at `itemPath`, sent as itself with its own media type. */
const attachTo = (itemPath: string, file: File) =>
  upload<{ attachment: Attachment }>(`${itemPath}/attachments?${new URLSearchParams({ name: file.name || "pasted" })}`, file, file.type || undefined).then((r) => r.attachment);

/** Where an Attachment's file is served: shown in the page when it is an image, video, audio or plain text, saved otherwise. */
export const attachmentFileUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/file`;

/** Where the whole Workspace's export downloads from; it holds every Version. */
export const workspaceExportUrl = "/api/export";

/** Where one Project's export downloads from; it holds every Version. */
export const projectExportUrl = (projectKey: string) => `/api/projects/${encodeURIComponent(projectKey)}/export`;

/** The fields of a Term a User writes. */
export interface TermInput {
  name: string;
  definition: string;
  avoid: string[];
  group: string | null;
}

/** Where a place's GLOSSARY.md downloads from: a Project's own Terms, or the Workspace's without a Project key. */
export const glossaryUrl = (projectKey?: string) => `${scopePath(projectKey)}/terms/glossary`;

const termPath = (id: string) => `/api/terms/${encodeURIComponent(id)}`;

export const api = {
  /** The Terms that apply in a Project (its own and the Workspace's it doesn't replace), or the Workspace's without a Project key. */
  terms: (projectKey?: string) => request<{ terms: Term[] }>("GET", `${scopePath(projectKey)}/terms`).then((r) => r.terms),
  term: (id: string) => request<{ term: Term }>("GET", termPath(id)).then((r) => r.term),
  termVersions: (id: string) => request<{ versions: TermVersion[] }>("GET", `${termPath(id)}/versions`).then((r) => r.versions),
  /** What names the Term where it applies, most recently changed first. */
  termMentions: (id: string) => request<{ mentions: Mention[] }>("GET", `${termPath(id)}/mentions`).then((r) => r.mentions),
  createTerm: (projectKey: string | undefined, input: TermInput) =>
    request<{ term: Term }>("POST", `${scopePath(projectKey)}/terms`, input).then((r) => r.term),
  /** Refused with a 409 whose body holds the `current` Version if someone saved since `baseVersion`. */
  saveTerm: (id: string, baseVersion: number, input: TermInput) => request<{ term: Term }>("PATCH", termPath(id), { baseVersion, ...input }).then((r) => r.term),
  protectTerm: (id: string, value: boolean) => request<{ term: Term }>("POST", `${termPath(id)}/protection`, { protected: value }).then((r) => r.term),
  termProtection: (id: string) => request<{ markings: ProtectionMarking[] }>("GET", `${termPath(id)}/protection`).then((r) => r.markings),
  deleteTerm: (id: string, baseVersion: number) => request<void>("DELETE", `${termPath(id)}?baseVersion=${baseVersion}`),
  /** Imports an export of the Workspace or a Project; Admins only. */
  importExport: (file: File) => upload<{ scope: "workspace" | "project"; projects: string[] }>("/api/import", file),
  /** Imports a .zip, .tar.gz or .tar of a folder of Markdown files as Documents of a Project's tree, or the Workspace's. */
  importDocuments: (projectKey: string | undefined, file: Blob) =>
    upload<{ documents: DocumentTreeEntry[] }>(`${scopePath(projectKey)}/documents/import`, file).then((r) => r.documents),
  /** Full-text search across what the signed-in User may read, best match first, optionally of one kind or in one Project. */
  search: (q: string, filter: { kind?: SearchKind | undefined; project?: string | undefined } = {}) =>
    request<{ results: SearchResult[] }>(
      "GET",
      `/api/search?${new URLSearchParams({ q, ...(filter.kind && { kind: filter.kind }), ...(filter.project && { project: filter.project }) })}`,
    ).then((r) => r.results),
  setupRequired: () => request<{ required: boolean }>("GET", "/api/setup").then((r) => r.required),
  setup: (input: { email: string; password: string; name: string; workspaceName?: string }) =>
    request<{ user: User }>("POST", "/api/setup", input).then((r) => r.user),
  signIn: (email: string, password: string) =>
    request<{ user: User }>("POST", "/api/sign-in", { email, password }).then((r) => r.user),
  signOut: () => request<void>("DELETE", "/api/sign-in"),
  me: () => request<{ user: User }>("GET", "/api/me").then((r) => r.user),
  workspace: () => request<Workspace>("GET", "/api/workspace"),
  updateWorkspace: (changes: { name?: string; agentAccess?: AgentAccess; silenceThresholdSeconds?: number; attachmentMaxBytes?: number }) =>
    request<Workspace>("PATCH", "/api/workspace", changes),
  /** How much storage the Workspace's files take; Admins only. */
  storage: () => request<Storage>("GET", "/api/workspace/storage"),
  /** Every Attachment on a Ticket, in its Comments and Reports too, in the order they were attached. */
  attachments: (key: string) =>
    request<{ attachments: Attachment[] }>("GET", `/api/tickets/${encodeURIComponent(key)}/attachments`).then((r) => r.attachments),
  /** Every Attachment on a Document or Report, in its Comments too, in the order they were attached. */
  documentAttachments: (id: string) => request<{ attachments: Attachment[] }>("GET", `${documentPath(id)}/attachments`).then((r) => r.attachments),
  /** Attaches `file` to the Ticket `key`, sent as itself with its own media type. */
  attach: (key: string, file: File) => attachTo(`/api/tickets/${encodeURIComponent(key)}`, file),
  /** Attaches `file` to a Document or Report. */
  attachToDocument: (id: string, file: File) => attachTo(documentPath(id), file),
  /** Attaches `file` to a Comment the signed-in User posted. */
  attachToComment: (id: string, file: File) => attachTo(`/api/comments/${encodeURIComponent(id)}`, file),
  deleteAttachment: (id: string) => request<void>("DELETE", `/api/attachments/${encodeURIComponent(id)}`),

  /** A Project's Decisions, or the Workspace's without a Project key, newest first. */
  decisions: (projectKey?: string) => request<{ decisions: DecisionSummary[] }>("GET", `${scopePath(projectKey)}/decisions`).then((r) => r.decisions),
  decision: (key: string) => request<{ decision: Decision }>("GET", decisionPath(key)).then((r) => r.decision),
  createDecision: (projectKey: string | undefined, input: { title: string; group?: string | null; supersedes?: string[] }) =>
    request<{ decision: Decision }>("POST", `${scopePath(projectKey)}/decisions`, input).then((r) => r.decision),
  /** Refused with a 409 whose body holds the `current` Version if someone saved since `baseVersion`. */
  saveDecision: (key: string, input: { baseVersion: number; title?: string; body?: string; group?: string | null; supersedes?: string[] }) =>
    request<{ decision: Decision }>("PATCH", decisionPath(key), input).then((r) => r.decision),
  /** Changes a Decision's status; rejecting needs a `reason`, which reaches the Agent that proposed it. */
  setDecisionStatus: (key: string, status: DecisionStatus, reason?: string) =>
    request<{ decision: Decision }>("POST", `${decisionPath(key)}/status`, { status, ...(reason === undefined ? {} : { reason }) }).then((r) => r.decision),
  /** What names the Decision's key, most recently changed first. */
  decisionMentions: (key: string) => request<{ mentions: Mention[] }>("GET", `${decisionPath(key)}/mentions`).then((r) => r.mentions),
  protectDecision: (key: string, value: boolean) =>
    request<{ decision: Decision }>("POST", `${decisionPath(key)}/protection`, { protected: value }).then((r) => r.decision),
  decisionProtection: (key: string) => request<{ markings: ProtectionMarking[] }>("GET", `${decisionPath(key)}/protection`).then((r) => r.markings),
  decisionVersions: (key: string) =>
    request<{ versions: Omit<DecisionVersion, "body">[] }>("GET", `${decisionPath(key)}/versions`).then((r) => r.versions),

  /** The Workspace's Guidance, or with `projectKey` that Project's. */
  guidance: (projectKey?: string) => request<{ guidance: Guidance }>("GET", guidancePath(projectKey)).then((r) => r.guidance),
  guidanceVersions: (projectKey?: string) =>
    request<{ versions: GuidanceVersion[] }>("GET", `${guidancePath(projectKey)}/versions`).then((r) => r.versions),
  /** Refused with a 409 whose body holds the `current` Guidance if someone saved since `baseVersion`. */
  saveGuidance: (projectKey: string | undefined, input: { markdown: string; baseVersion: number }) =>
    request<{ guidance: Guidance }>("PUT", guidancePath(projectKey), input).then((r) => r.guidance),
  /** Merges an edit started from `baseVersion` with the current Guidance, section by section, without saving. */
  mergeGuidance: (projectKey: string | undefined, input: { markdown: string; baseVersion: number }) =>
    request<{ merge: GuidanceMerge }>("POST", `${guidancePath(projectKey)}/merge`, input).then((r) => r.merge),

  agents: (all = false) => request<{ agents: Agent[] }>("GET", `/api/agents${all ? "?all=true" : ""}`).then((r) => r.agents),
  createAgent: (name: string) => request<{ agent: Agent }>("POST", "/api/agents", { name }).then((r) => r.agent),
  renameAgent: (id: string, name: string) =>
    request<{ agent: Agent }>("PATCH", `/api/agents/${encodeURIComponent(id)}`, { name }).then((r) => r.agent),
  removeAgent: (id: string) => request<void>("DELETE", `/api/agents/${encodeURIComponent(id)}`),
  agentTokens: (id: string) =>
    request<{ tokens: AgentToken[] }>("GET", `/api/agents/${encodeURIComponent(id)}/tokens`).then((r) => r.tokens),
  issueAgentToken: (id: string, readOnly: boolean) =>
    request<IssuedAgentToken>("POST", `/api/agents/${encodeURIComponent(id)}/tokens`, { readOnly }),
  /** The Agent Record: what the Agent did, newest first, as far as the signed-in User may read. */
  agentRecord: (id: string) =>
    request<{ record: AgentRecordEntry[] }>("GET", `/api/agents/${encodeURIComponent(id)}/record`).then((r) => r.record),
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
    request<{ email: string; role: Role; workspaceName: string }>("GET", `/api/invitations/by-token/${encodeURIComponent(token)}`),
  acceptInvitation: (token: string, input: { name: string; password: string }) =>
    request<{ user: User }>("POST", `/api/invitations/by-token/${encodeURIComponent(token)}/accept`, input).then((r) => r.user),
  issuePasswordReset: (userId: string) =>
    request<{ token: string; expiresAt: string }>("POST", `/api/users/${encodeURIComponent(userId)}/password-reset`),
  passwordReset: (token: string) =>
    request<{ email: string; name: string; workspaceName: string }>("GET", `/api/password-resets/by-token/${encodeURIComponent(token)}`),
  resetPassword: (token: string, password: string) =>
    request<{ user: User }>("POST", `/api/password-resets/by-token/${encodeURIComponent(token)}`, { password }).then((r) => r.user),
  changePassword: (currentPassword: string, password: string) => request<void>("PUT", "/api/me/password", { currentPassword, password }),

  projects: (archived = false) =>
    request<{ projects: Project[] }>("GET", `/api/projects${archived ? "?archived=true" : ""}`).then((r) => r.projects),
  createProject: (input: { name: string; key: string }) =>
    request<{ project: Project }>("POST", "/api/projects", input).then((r) => r.project),
  project: (key: string) => request<{ project: Project; statuses: Status[] }>("GET", `/api/projects/${encodeURIComponent(key)}`),
  updateProject: (
    key: string,
    changes: { name?: string; archived?: boolean; visibility?: Visibility; agentAccess?: AgentAccess; autonomousByDefault?: boolean },
  ) =>
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
  /** Links a Document to a Ticket; answers the Ticket's Documents. */
  linkDocument: (key: string, documentId: string) =>
    request<{ documents: LinkedDocument[] }>("POST", `/api/tickets/${encodeURIComponent(key)}/documents/${encodeURIComponent(documentId)}`).then(
      (r) => r.documents,
    ),
  /** Unlinks a Document from a Ticket; answers the Ticket's remaining Documents. */
  unlinkDocument: (key: string, documentId: string) =>
    request<{ documents: LinkedDocument[] }>("DELETE", `/api/tickets/${encodeURIComponent(key)}/documents/${encodeURIComponent(documentId)}`).then(
      (r) => r.documents,
    ),
  documentTree: (projectKey?: string) =>
    request<{ documents: DocumentTreeEntry[] }>("GET", `${scopePath(projectKey)}/documents`).then((r) => r.documents),
  createDocument: (projectKey: string | undefined, input: { title: string; body?: string; parentId?: string }) =>
    request<{ document: Document }>("POST", `${scopePath(projectKey)}/documents`, input).then((r) => r.document),
  document: (id: string) => request<{ document: Document }>("GET", documentPath(id)).then((r) => r.document),
  /** Refused with the current Version (see `staleVersionOf`) if `baseVersion` is no longer current. */
  saveDocument: (id: string, input: { baseVersion: number; title?: string; body?: string }) =>
    request<{ document: Document }>("PATCH", documentPath(id), input).then((r) => r.document),
  /** Merges an edit started from `baseVersion` with the current Version, section by section, without saving. */
  mergeDocument: (id: string, input: { baseVersion: number; title: string; body: string }) =>
    request<{ merge: Merge }>("POST", `${documentPath(id)}/merge`, input).then((r) => r.merge),
  moveDocument: (id: string, parentId: string | null) =>
    request<{ document: Document }>("POST", `${documentPath(id)}/move`, { parentId }).then((r) => r.document),
  /** Refused with a 409 whose body holds the `current` Version if someone saved since `baseVersion`. */
  deleteDocument: (id: string, baseVersion: number) => request<void>("DELETE", `${documentPath(id)}?baseVersion=${baseVersion}`),
  protectDocument: (id: string, value: boolean) =>
    request<{ document: Document }>("POST", `${documentPath(id)}/protection`, { protected: value }).then((r) => r.document),
  documentProtection: (id: string) => request<{ markings: ProtectionMarking[] }>("GET", `${documentPath(id)}/protection`).then((r) => r.markings),
  versions: (id: string) => request<{ versions: VersionSummary[] }>("GET", `${documentPath(id)}/versions`).then((r) => r.versions),
  version: (id: string, number: number) =>
    request<{ version: Version }>("GET", `${documentPath(id)}/versions/${number}`).then((r) => r.version),
  restoreVersion: (id: string, number: number, baseVersion: number) =>
    request<{ document: Document }>("POST", `${documentPath(id)}/versions/${number}/restore`, { baseVersion }).then((r) => r.document),

  ticketReports: (key: string) =>
    request<{ reports: Report[] }>("GET", `/api/tickets/${encodeURIComponent(key)}/reports`).then((r) => r.reports),
  projectReports: (projectKey: string) =>
    request<{ reports: Report[] }>("GET", `/api/projects/${encodeURIComponent(projectKey)}/reports`).then((r) => r.reports),

  activities: (key: string) =>
    request<{ activities: Activity[] }>("GET", `/api/tickets/${encodeURIComponent(key)}/activities`).then((r) => r.activities),

  ticketComments: (key: string) =>
    request<{ comments: Comment[] }>("GET", `/api/tickets/${encodeURIComponent(key)}/comments`).then((r) => r.comments),
  /** Posts a Comment on a Ticket; a reply to a question Activity answers it. */
  postTicketComment: (key: string, input: NewComment) =>
    request<{ comment: Comment }>("POST", `/api/tickets/${encodeURIComponent(key)}/comments`, input).then((r) => r.comment),
  documentComments: (id: string) => request<{ comments: Comment[] }>("GET", `${documentPath(id)}/comments`).then((r) => r.comments),
  /** Posts a Comment on a Document, optionally anchored to a passage its current Version holds. */
  postDocumentComment: (id: string, input: NewComment & { anchor?: { passage: string } }) =>
    request<{ comment: Comment }>("POST", `${documentPath(id)}/comments`, input).then((r) => r.comment),

  /** The signed-in User's Inbox, narrowed by any of the filters given. */
  inbox: (filter: InboxFilter = {}) => {
    const query = new URLSearchParams(Object.entries(filter).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return request<{ items: InboxItem[] }>("GET", `/api/inbox${query.size ? `?${query}` : ""}`).then((r) => r.items);
  },
  /** Sends a Ticket under review back to a Started Status (the Project's first, unless named), with a Comment. */
  sendBack: (key: string, input: { comment: string; statusId?: string }) =>
    request<{ ticket: Ticket; comment: Comment }>("POST", `/api/tickets/${encodeURIComponent(key)}/send-back`, input),

  /**
   * Reopens an Agent's Unverified completion back to its Delegate in a Started Status, with a Comment saying why, and a choice
   * for each Ticket it blocks that already continued on the work.
   */
  reopen: (key: string, input: { comment: string; dependents: Record<string, ReopenChoice> }) =>
    request<{ ticket: Ticket; comment: Comment }>("POST", `/api/tickets/${encodeURIComponent(key)}/reopen`, input),

  /** Accepts an Agent's Unverified completion, recording the User's Verification. */
  accept: (key: string) => request<{ ticket: Ticket }>("POST", `/api/tickets/${encodeURIComponent(key)}/accept`).then((r) => r.ticket),

  ticketChanges: (key: string) =>
    request<{ changes: RecordedChange[] }>("GET", `/api/tickets/${encodeURIComponent(key)}/changes`).then((r) => r.changes),
};

/** Narrows the Inbox: an item kind, a Project key, an Agent id. */
export interface InboxFilter {
  kind?: InboxKind;
  project?: string;
  agent?: string;
}

/** A Comment to post: its Markdown, and what it replies to, if anything. */
export interface NewComment {
  body: string;
  replyToCommentId?: string;
  replyToActivityId?: string;
}

/** The events a Ticket's live-update stream pushes, by name, with their data. */
export interface TicketEvents {
  /** A new Activity, or one changed since (a question once answered). */
  activity: { activity: Activity };
  comment: { comment: Comment };
  report: { report: Report };
  /** The Ticket's fields, Claim, Sub-Tickets or relations changed; `ticket` is its key. */
  changed: { ticket: string };
}

/** The events a Project's live-update stream pushes, by name, with their data. */
export interface ProjectEvents {
  /** One of its Tickets was created or changed (`ticket` is its key), or its Statuses changed (`ticket` is null). */
  changed: { ticket: string | null };
}

/** The events a Document's live-update stream pushes, by name, with their data. */
export interface DocumentEvents {
  comment: { comment: Comment };
  /** A new Version was saved or restored; `version` is its number. */
  version: { version: number };
  /** A file was attached to it or one of its Comments, or one was deleted. */
  attachments: Record<string, never>;
}

/** Where a live-update stream is: in place, away and reconnecting, or closed for good. */
export type StreamState = "live" | "away" | "closed";

/**
 * Watches a live-update stream (server-sent events) until the returned function is called.
 * `ready` is called each time the stream (re)connects, so whatever it shows can be loaded
 * again to catch up on what happened while it was away; `on` maps event names to handlers
 * of their JSON data. The browser reconnects by itself after the connection drops; `onLive`
 * hears when the stream is in place, away and reconnecting, or closed for good (such as when refused).
 */
function watch<Events>(
  path: string,
  handlers: { ready: () => void; onLive?: (state: StreamState) => void; on: { [E in keyof Events]?: (data: Events[E]) => void } },
): () => void {
  const source = new EventSource(path, { withCredentials: true });
  source.addEventListener("ready", () => {
    handlers.onLive?.("live");
    handlers.ready();
  });
  source.addEventListener("error", () => handlers.onLive?.(source.readyState === EventSource.CLOSED ? "closed" : "away"));
  for (const [event, handle] of Object.entries(handlers.on) as [string, (data: unknown) => void][]) {
    source.addEventListener(event, (e) => handle(JSON.parse((e as MessageEvent<string>).data)));
  }
  return () => source.close();
}

/** Watches the signed-in User's Inbox; `changed` arrives whenever it may have changed (see `watch`). */
export const watchInbox = (handlers: Parameters<typeof watch<{ changed: object }>>[1]) => watch<{ changed: object }>("/api/inbox/events", handlers);

/** Watches the signed-in User's own Agents; `changed` arrives every few seconds while their live Agent Sessions change (see `watch`). */
export const watchAgents = (handlers: Parameters<typeof watch<{ changed: object }>>[1]) => watch<{ changed: object }>("/api/agents/events", handlers);

/** Watches one Ticket's changes as they happen (see `watch`). */
export const watchTicket = (key: string, handlers: Parameters<typeof watch<TicketEvents>>[1]) =>
  watch<TicketEvents>(`/api/tickets/${encodeURIComponent(key)}/events`, handlers);

/** Watches one Project's Tickets and Statuses as they change, for its list and board (see `watch`). */
export const watchProject = (key: string, handlers: Parameters<typeof watch<ProjectEvents>>[1]) =>
  watch<ProjectEvents>(`/api/projects/${encodeURIComponent(key)}/events`, handlers);

/** Watches one Document's new Comments and Versions as they happen (see `watch`). */
export const watchDocument = (id: string, handlers: Parameters<typeof watch<DocumentEvents>>[1]) =>
  watch<DocumentEvents>(`${documentPath(id)}/events`, handlers);
