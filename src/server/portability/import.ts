import { randomUUID } from "node:crypto";
import { HttpError } from "../context.js";
import { lockUntilCommit, type Queryable } from "../db/database.js";
import { ACTIVITY_KINDS, PRIORITIES, RELATION_KINDS, STATUS_CATEGORIES } from "../../shared/values.js";
import { unwrapFolder, type Folder } from "./archive.js";
import { CHANGE_FIELDS, FORMAT, isRecord } from "./format.js";
import { accessSchema, agentAccessSchema, roleSchema } from "../schemas.js";
import { PROJECT_KEY_PATTERN, VISIBILITIES } from "../work/projects.js";
import { readFrontmatter } from "./frontmatter.js";
import type { TicketChange } from "../work/tickets.js";

/**
 * Importing an export (see `format.ts`) back: a Workspace export into a Workspace that holds
 * nothing yet, or a Project export as a new Project. Users are matched by email and Agents by
 * Owner and name; those not found are created, Users deactivated since they have no password here.
 */

/** What an import brought in. */
export interface Imported {
  scope: "workspace" | "project";
  /** The keys of the Projects it created. */
  projects: string[];
}

/** A file of the export, read: its frontmatter and body, and its path for naming it in refusals. */
interface File {
  path: string;
  data: Record<string, unknown>;
  body: string;
}

/** An Actor as rows record one: the acting User (an Agent's Owner), and the Agent and Agent Session if an Agent acted. */
interface ActorIds {
  kind: "user" | "agent";
  userId: string;
  agentId: string | null;
  sessionId: string | null;
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Imports `archived`, an export, into the Workspace `workspaceId`, all of it or nothing. Run inside a transaction. */
export async function importExport(db: Queryable, workspaceId: string, archived: Folder, now: Date): Promise<Imported> {
  const folder = unwrapFolder(archived);
  const read = (path: string): File | undefined => {
    const text = folder.get(path);
    if (text === undefined) return undefined;
    try {
      return { path, ...readFrontmatter(text) };
    } catch (err) {
      throw new HttpError(400, `${path} can't be read: ${(err as Error).message}`);
    }
  };
  const need = (path: string): File => read(path) ?? refuse(`The export has no ${path}`);
  /** The Markdown files directly in `dir`, in natural name order. */
  const filesIn = (dir: string): string[] =>
    [...folder.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/") && p.endsWith(".md")).sort(natural);
  /** The numbered files (`1.md`, `2.md`, …) in `dir`, in number order. */
  const numbered = (dir: string): [number, File][] =>
    filesIn(dir)
      .map((p) => [Number(/\/(\d+)\.md$/.exec(p)?.[1]), p] as const)
      .filter(([n]) => Number.isInteger(n) && n > 0)
      .sort(([a], [b]) => a - b)
      .map(([n, p]) => [n, need(p)]);

  const readme = read("README.md");
  const manifest = readme?.data.cronk as { format?: unknown; scope?: unknown } | undefined;
  if (!manifest || typeof manifest !== "object") {
    refuse("This isn't a Cronk export: it has no README.md saying so. To import plain Markdown files, import them as Documents instead");
  }
  if (manifest.format !== FORMAT) refuse(`This export is in format ${String(manifest.format)}; this Cronk reads format ${FORMAT}`);
  if (manifest.scope !== "workspace" && manifest.scope !== "project") refuse("README.md's cronk.scope must be workspace or project");
  const scope = manifest.scope;

  // One import at a time per Workspace, so two can't both find it empty or a key free.
  await lockUntilCommit(db, `import:${workspaceId}`);
  const projectKeys = [...folder.keys()]
    .map((p) => /^projects\/([^/]+)\/project\.md$/.exec(p)?.[1])
    .filter((k): k is string => k !== undefined)
    .sort(natural);
  if (scope === "workspace") {
    const { rows } = await db.query(
      `SELECT 1 FROM projects WHERE workspace_id = $1
       UNION ALL SELECT 1 FROM documents WHERE workspace_id = $1
       UNION ALL SELECT 1 FROM guidance_versions WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    );
    if (rows.length > 0) throw new HttpError(409, "A Workspace export goes into a Workspace with no Projects, Documents or Guidance yet; import Projects one at a time instead");
  } else if (projectKeys.length !== 1) {
    refuse("A Project export holds exactly one projects/<KEY>/project.md");
  }
  const { rows: taken } = await db.query<{ key: string }>("SELECT key FROM projects WHERE workspace_id = $1 AND key = ANY($2::text[])", [
    workspaceId,
    projectKeys.map((k) => k.toUpperCase()),
  ]);
  if (taken.length > 0) throw new HttpError(409, `This Workspace already has a Project with the key ${taken[0]!.key}`);

  // People: Users by email, Agents by Owner and name, and the Agent Sessions they worked in.
  const people = need("people.md");
  const userIds = new Map<string, string>();
  /** The User with `email` in the export or this Workspace, if there is one. */
  const findUser = async (email: string): Promise<string | undefined> => {
    const known = userIds.get(email.toLowerCase());
    if (known) return known;
    const { rows } = await db.query<{ id: string }>("SELECT id FROM users WHERE workspace_id = $1 AND lower(email) = lower($2)", [workspaceId, email]);
    if (rows[0]) userIds.set(email.toLowerCase(), rows[0].id);
    return rows[0]?.id;
  };
  const userId = async (email: unknown, where: string): Promise<string> => {
    if (typeof email !== "string" || email.trim() === "") refuse(`${where} must name a User by email`);
    return (await findUser(email)) ?? refuse(`${where} names ${email}, who isn't in people.md`);
  };
  for (const [i, u] of list(people, "users").entries()) {
    const where = `people.md users[${i}]`;
    const email = text(u.email, `${where}.email`);
    const { rows } = await db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM users WHERE lower(email) = lower($1)", [email]);
    if (rows[0] && rows[0].workspace_id !== workspaceId) refuse(`${email} is a User of another Workspace`);
    if (rows[0]) {
      userIds.set(email.toLowerCase(), rows[0].id);
      continue;
    }
    // No password hash matches "!", so the User can't sign in until one is set.
    const { rows: inserted } = await db.query<{ id: string }>(
      `INSERT INTO users (workspace_id, email, name, password_hash, role, created_at, deactivated_at) VALUES ($1, $2, $3, '!', $4, $5, $5) RETURNING id`,
      [workspaceId, email, text(u.name, `${where}.name`), oneOf(u.role, roleSchema.enum, `${where}.role`), now],
    );
    userIds.set(email.toLowerCase(), inserted[0]!.id);
  }

  const agentIds = new Map<string, { id: string; ownerId: string }>();
  for (const [i, a] of list(people, "agents").entries()) {
    const where = `people.md agents[${i}]`;
    const ownerId = await userId(a.owner, `${where}.owner`);
    const name = text(a.name, `${where}.name`);
    const removedAt = optionalDate(a.removedAt, `${where}.removedAt`);
    const { rows: existing } =
      removedAt === null
        ? await db.query<{ id: string }>("SELECT id FROM agents WHERE owner_id = $1 AND lower(name) = lower($2) AND removed_at IS NULL", [ownerId, name])
        : { rows: [] };
    const id =
      existing[0]?.id ??
      (
        await db.query<{ id: string }>("INSERT INTO agents (workspace_id, owner_id, name, created_at, removed_at) VALUES ($1, $2, $3, $4, $5) RETURNING id", [
          workspaceId,
          ownerId,
          name,
          date(a.createdAt, `${where}.createdAt`),
          removedAt,
        ])
      ).rows[0]!.id;
    agentIds.set(text(a.id, `${where}.id`), { id, ownerId });
  }
  const agent = (ref: unknown, where: string) => agentIds.get(String(ref)) ?? refuse(`${where} names an Agent that isn't in people.md`);

  const sessionIds = new Map<string, string>();
  for (const [i, s] of list(people, "sessions").entries()) {
    const where = `people.md sessions[${i}]`;
    const lastSeenAt = date(s.lastSeenAt, `${where}.lastSeenAt`);
    // An Agent Session live at export has no connection here, so it ends when it was last seen.
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO agent_sessions (agent_id, started_at, last_seen_at, ended_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [agent(s.agent, `${where}.agent`).id, date(s.startedAt, `${where}.startedAt`), lastSeenAt, optionalDate(s.endedAt, `${where}.endedAt`) ?? lastSeenAt],
    );
    sessionIds.set(text(s.id, `${where}.id`), rows[0]!.id);
  }

  const actor = async (ref: unknown, where: string): Promise<ActorIds> => {
    if (typeof ref === "string") return { kind: "user", userId: await userId(ref, where), agentId: null, sessionId: null };
    if (ref === null || typeof ref !== "object") refuse(`${where} must name a User by email or an Agent`);
    const { agent: agentRef, session } = ref as { agent?: unknown; session?: unknown };
    const found = agent(agentRef, where);
    const sessionId = session === null || session === undefined ? null : (sessionIds.get(String(session)) ?? refuse(`${where} names an Agent Session that isn't in people.md`));
    return { kind: "agent", userId: found.ownerId, agentId: found.id, sessionId };
  };
  const actorValues = (a: ActorIds) => [a.kind, a.userId, a.agentId, a.sessionId];

  /** Imports the Comments in `dir` onto a Ticket or Document; returns their ids by number. */
  const importComments = async (dir: string, target: { ticketId: string } | { documentId: string }, activities = new Map<number, string>(), documentVersion?: number) => {
    const ids = new Map<number, string>();
    for (const [n, c] of numbered(dir)) {
      const replyToComment = c.data.replyToComment === undefined ? null : (ids.get(Number(c.data.replyToComment)) ?? refuse(`${c.path} replies to a Comment that isn't before it`));
      const replyToActivity =
        c.data.replyToActivity === undefined ? null : (activities.get(Number(c.data.replyToActivity)) ?? refuse(`${c.path} replies to an Activity that isn't on its Ticket`));
      const anchor = c.data.anchor as { passage?: unknown; version?: unknown } | undefined;
      const anchorVersion = anchor ? Math.min(integer(anchor.version, `${c.path} anchor.version`), documentVersion ?? Infinity) : null;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO comments (ticket_id, document_id, reply_to_comment_id, reply_to_activity_id, anchor_passage, anchor_version, body, at,
           actor_kind, actor_user_id, actor_agent_id, actor_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          "ticketId" in target ? target.ticketId : null,
          "documentId" in target ? target.documentId : null,
          replyToComment,
          replyToActivity,
          anchor ? text(anchor.passage, `${c.path} anchor.passage`) : null,
          anchorVersion,
          c.body,
          date(c.data.at, `${c.path} at`),
          ...actorValues(await actor(c.data.by, `${c.path} by`)),
        ],
      );
      ids.set(n, rows[0]!.id);
    }
    return ids;
  };

  /**
   * Imports the Document at `${base}.md` with its Versions and Comments: one Version per file in
   * `${base}.versions/`, or without them a single Version holding what it says now.
   */
  const importDocument = async (base: string, columns: { projectId: string | null; parentId: string | null; position: number; ticketId: string | null }) => {
    const d = need(`${base}.md`);
    const title = text(d.data.title, `${d.path} title`);
    const versions = numbered(`${base}.versions`);
    const version = versions.length > 0 ? integer(d.data.version, `${d.path} version`) : 1;
    if (versions.length > 0 && !versions.some(([n]) => n === version)) refuse(`${d.path} is at Version ${version}, which ${base}.versions/ doesn't hold`);
    const claimId = columns.ticketId === null ? null : isUuid(d.data.claim) ? d.data.claim : randomUUID();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, project_id, parent_id, position, title, body, version, created_at, updated_at, ticket_id, claim_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        workspaceId,
        columns.projectId,
        columns.parentId,
        columns.position,
        title,
        d.body,
        version,
        date(d.data.createdAt, `${d.path} createdAt`),
        date(d.data.updatedAt, `${d.path} updatedAt`),
        columns.ticketId,
        claimId,
      ],
    );
    const id = rows[0]!.id;
    const insertVersion = async (number: number, v: { title: string; body: string; at: Date; by: ActorIds; restoredFrom: number | null }) =>
      db.query(
        `INSERT INTO document_versions (document_id, number, title, body, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id, restored_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, number, v.title, v.body, v.at, ...actorValues(v.by), v.restoredFrom],
      );
    if (versions.length === 0) {
      // Without its Versions, it starts at Version 1 by whoever first wrote it, so a Report keeps its Agent.
      await insertVersion(1, { title, body: d.body, at: date(d.data.updatedAt, `${d.path} updatedAt`), by: await actor(d.data.createdBy, `${d.path} createdBy`), restoredFrom: null });
    }
    for (const [n, v] of versions) {
      const restoredFrom = v.data.restoredFrom === undefined || v.data.restoredFrom === null ? null : integer(v.data.restoredFrom, `${v.path} restoredFrom`);
      await insertVersion(n, { title: text(v.data.title, `${v.path} title`), body: v.body, at: date(v.data.at, `${v.path} at`), by: await actor(v.data.by, `${v.path} by`), restoredFrom });
    }
    await importComments(`${base}.comments`, { documentId: id }, undefined, version);
    return id;
  };

  /** Imports the page tree in `dir`: each `<name>.md` with the Documents under it in `<name>/`. */
  const importTree = async (dir: string, projectId: string | null, parentId: string | null = null) => {
    for (const [position, path] of filesIn(dir).entries()) {
      const base = path.slice(0, -".md".length);
      const id = await importDocument(base, { projectId, parentId, position, ticketId: null });
      await importTree(base, projectId, id);
    }
  };

  /** Imports Guidance from `${base}.md`, with its Versions from `${base}.versions/` if the export has them. */
  const importGuidance = async (base: string, projectId: string | null) => {
    const current = read(`${base}.md`);
    if (!current) return;
    const versions = numbered(`${base}.versions`);
    const saved: [number, File][] = versions.length > 0 ? versions : [[1, current]];
    for (const [n, v] of saved) {
      const by = await actor(v.data.by, `${v.path} by`);
      if (by.kind !== "user") refuse(`${v.path} by must name a User: only Users write Guidance`);
      await db.query("INSERT INTO guidance_versions (workspace_id, project_id, version, markdown, at, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6)", [
        workspaceId,
        projectId,
        n,
        v.body,
        date(v.data.at, `${v.path} at`),
        by.userId,
      ]);
    }
  };

  if (scope === "workspace") {
    const w = need("workspace.md");
    await db.query("UPDATE workspaces SET name = $2, agent_access = $3, silence_threshold_seconds = $4 WHERE id = $1", [
      workspaceId,
      text(w.data.name, "workspace.md name"),
      oneOf(w.data.agentAccess, agentAccessSchema.enum, "workspace.md agentAccess"),
      integer(w.data.silenceThresholdSeconds, "workspace.md silenceThresholdSeconds"),
    ]);
    await importGuidance("guidance", null);
    await importTree("documents", null);
  }

  // Tickets by key across the imported Projects, for parents and relations.
  const ticketIds = new Map<string, string>();
  const relations: { from: string; kind: string; to: string; path: string }[] = [];
  const histories: { ticketId: string; statusIds: Map<string, string>; file: File }[] = [];
  const created: string[] = [];
  for (const key of projectKeys) {
    const dir = `projects/${key}`;
    const p = need(`${dir}/project.md`);
    const projectKey = text(p.data.key, `${p.path} key`).toUpperCase();
    if (projectKey !== key.toUpperCase()) refuse(`${p.path} says its key is ${projectKey}, but it is in projects/${key}`);
    if (!new RegExp(`^${PROJECT_KEY_PATTERN}$`).test(projectKey)) refuse(`${p.path} key must be a letter then 1 to 9 letters or digits`);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, key, visibility, agent_access, archived_at, created_at, next_ticket_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        workspaceId,
        text(p.data.name, `${p.path} name`),
        projectKey,
        oneOf(p.data.visibility, VISIBILITIES, `${p.path} visibility`),
        oneOf(p.data.agentAccess, agentAccessSchema.enum, `${p.path} agentAccess`),
        optionalDate(p.data.archivedAt, `${p.path} archivedAt`),
        date(p.data.createdAt, `${p.path} createdAt`),
        integer(p.data.nextTicketNumber, `${p.path} nextTicketNumber`),
      ],
    );
    const projectId = rows[0]!.id;
    created.push(projectKey);

    const statusIds = new Map<string, string>();
    const positions = new Map<string, number>();
    for (const [i, s] of list(p, "statuses").entries()) {
      const name = text(s.name, `${p.path} statuses[${i}].name`);
      const category = oneOf(s.category, STATUS_CATEGORIES, `${p.path} statuses[${i}].category`);
      const position = positions.get(category) ?? 0;
      positions.set(category, position + 1);
      if (statusIds.has(name.toLowerCase())) refuse(`${p.path} has two Statuses named ${name}`);
      const { rows: status } = await db.query<{ id: string }>("INSERT INTO statuses (project_id, name, category, position) VALUES ($1, $2, $3, $4) RETURNING id", [
        projectId,
        name,
        category,
        position,
      ]);
      statusIds.set(name.toLowerCase(), status[0]!.id);
    }
    if (statusIds.size === 0) refuse(`${p.path} has no statuses`);
    for (const [i, m] of list(p, "members").entries()) {
      await db.query("INSERT INTO project_members (project_id, user_id, access) VALUES ($1, $2, $3)", [
        projectId,
        await userId(m.user, `${p.path} members[${i}].user`),
        oneOf(m.access, accessSchema.enum, `${p.path} members[${i}].access`),
      ]);
    }
    await importGuidance(`${dir}/guidance`, projectId);
    await importTree(`${dir}/documents`, projectId);

    const parents: { ticketId: string; parent: string; path: string }[] = [];
    for (const path of filesIn(`${dir}/tickets`).filter((p) => !p.endsWith(".history.md"))) {
      const t = need(path);
      const ticketKey = text(t.data.key, `${path} key`).toUpperCase();
      const number = Number(new RegExp(`^${projectKey}-([1-9][0-9]{0,8})$`).exec(ticketKey)?.[1]);
      if (!number) refuse(`${path} key must be a key of ${projectKey}, such as ${projectKey}-1`);
      const statusId = statusIds.get(text(t.data.status, `${path} status`).toLowerCase()) ?? refuse(`${path} is in a Status ${p.path} doesn't list`);
      const delegate = t.data.delegate === null || t.data.delegate === undefined ? null : agent(t.data.delegate, `${path} delegate`).id;
      const labels = t.data.labels ?? [];
      if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) refuse(`${path} labels must be a list of text`);
      const { rows: ticket } = await db.query<{ id: string }>(
        `INSERT INTO tickets (project_id, number, title, description, status_id, priority, labels, assignee_id, delegate_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          projectId,
          number,
          text(t.data.title, `${path} title`),
          t.body,
          statusId,
          oneOf(t.data.priority ?? "none", PRIORITIES, `${path} priority`),
          labels,
          t.data.assignee === null || t.data.assignee === undefined ? null : await userId(t.data.assignee, `${path} assignee`),
          delegate,
          date(t.data.createdAt, `${path} createdAt`),
          date(t.data.updatedAt, `${path} updatedAt`),
        ],
      );
      const ticketId = ticket[0]!.id;
      if (ticketIds.has(ticketKey)) refuse(`Two Tickets have the key ${ticketKey}`);
      ticketIds.set(ticketKey, ticketId);
      if (typeof t.data.parent === "string") parents.push({ ticketId, parent: t.data.parent.toUpperCase(), path });
      for (const [field, kind, forward] of [["blocks", "blocks", true], ["blockedBy", "blocks", false], ["relatesTo", "relates_to", true]] as const) {
        const keys = t.data[field] ?? [];
        if (!Array.isArray(keys)) refuse(`${path} ${field} must be a list of Ticket keys`);
        for (const other of keys) {
          const otherKey = String(other).toUpperCase();
          relations.push(forward ? { from: ticketKey, kind, to: otherKey, path } : { from: otherKey, kind, to: ticketKey, path });
        }
      }

      const base = path.slice(0, -".md".length);
      const history = read(`${base}.history.md`);
      if (history) histories.push({ ticketId, statusIds, file: history });
      const activities = numbered(`${base}.activities`);
      const activityIds = new Map<number, string>();
      for (const [n, a] of activities) {
        const by = await actor({ agent: a.data.agent, session: a.data.session }, `${a.path} agent`);
        if (by.sessionId === null) refuse(`${a.path} must name the Agent Session that wrote it`);
        const { rows: activity } = await db.query<{ id: string }>(
          `INSERT INTO activities (ticket_id, kind, body, blocking, at, actor_user_id, actor_agent_id, actor_session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [ticketId, oneOf(a.data.kind, ACTIVITY_KINDS, `${a.path} kind`), a.body, a.data.blocking === true, date(a.data.at, `${a.path} at`), by.userId, by.agentId, by.sessionId],
        );
        activityIds.set(n, activity[0]!.id);
      }
      const commentIds = await importComments(`${base}.comments`, { ticketId }, activityIds);
      for (const [n, a] of activities) {
        if (a.data.answer === undefined || a.data.answer === null) continue;
        const answer = commentIds.get(Number(a.data.answer)) ?? refuse(`${a.path} answer names a Comment that isn't on its Ticket`);
        await db.query("UPDATE activities SET answer_comment_id = $2 WHERE id = $1", [activityIds.get(n), answer]);
      }
      for (const report of filesIn(`${base}.reports`)) {
        await importDocument(report.slice(0, -".md".length), { projectId, parentId: null, position: 0, ticketId });
      }
    }
    for (const { ticketId, parent, path } of parents) {
      const parentId = ticketIds.get(parent);
      if (!parentId || !parent.startsWith(`${projectKey}-`)) refuse(`${path} parent must be a Ticket of ${projectKey} in the export`);
      await db.query("UPDATE tickets SET parent_id = $2 WHERE id = $1", [ticketId, parentId]);
    }
  }

  // Relations link only Tickets this import brings in: a key elsewhere may name another Ticket here.
  for (const r of relations) {
    const from = ticketIds.get(r.from);
    const to = ticketIds.get(r.to);
    if (!from || !to || from === to) continue;
    const [a, b] = r.kind === "relates_to" && to < from ? [to, from] : [from, to];
    await db.query("INSERT INTO ticket_relations (kind, from_ticket_id, to_ticket_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [r.kind, a, b]);
  }

  // History once every Ticket is in, naming records by what this installation calls them.
  for (const { ticketId, statusIds, file } of histories) {
    const find: Finders = {
      user: findUser,
      agent: async (id) => agentIds.get(id)?.id,
      status: async (name) => statusIds.get(name.toLowerCase()),
    };
    for (const [i, entry] of list(file, "changes").entries()) {
      const where = `${file.path} changes[${i}]`;
      const { at, by, change, ...fields } = entry;
      const kind = oneOf(change, Object.keys(CHANGE_FIELDS) as TicketChange["change"][], `${where}.change`);
      await db.query(
        `INSERT INTO ticket_changes (ticket_id, at, actor_kind, actor_user_id, actor_agent_id, actor_session_id, change, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ticketId,
          date(at, `${where}.at`),
          ...actorValues(await actor(by, `${where}.by`)),
          kind,
          await importedChange(kind, fields, find, where),
        ],
      );
    }
  }
  return { scope, projects: created };
}

/** Finds a record in this installation by what an export names it by, if it is here. */
type Finder = (name: string) => Promise<string | undefined>;
interface Finders {
  user: Finder;
  agent: Finder;
  status: Finder;
}

/**
 * A Ticket change's fields as Cronk records them, from those the export wrote (see `CHANGE_FIELDS`), refusing any
 * that isn't what its kind holds. Users, Agents and Statuses get the id they have here, keeping the names recorded
 * at the time; one with nothing here to map to keeps the id it was written with.
 */
async function importedChange(change: TicketChange["change"], fields: Record<string, unknown>, find: Finders, where: string): Promise<Record<string, unknown>> {
  const recorded: Record<string, unknown> = {};
  for (const [field, { holds, nullable }] of Object.entries(CHANGE_FIELDS[change])) {
    const value = fields[field];
    const at = `${where}.${field}`;
    if (nullable && value === null) recorded[field] = null;
    else if (holds === "title") recorded[field] = text(value, at);
    else if (holds === "text") recorded[field] = typeof value === "string" ? value : refuse(`${at} must be text`);
    else if (holds === "priority") recorded[field] = oneOf(value, PRIORITIES, at);
    else if (holds === "relation kind") recorded[field] = oneOf(value, RELATION_KINDS, at);
    else if (holds === "labels") {
      if (!Array.isArray(value) || !value.every((l) => typeof l === "string")) refuse(`${at} must be a list of text`);
      recorded[field] = value;
    } else {
      if (!isRecord(value)) refuse(`${at} must be a mapping${nullable ? " or null" : ""}`);
      if (holds === "ticket") recorded[field] = { key: text(value.key, `${at}.key`), title: text(value.title, `${at}.title`) };
      else {
        const foundBy = { user: value.email, agent: value.id, status: value.current }[holds];
        const id = (typeof foundBy === "string" ? await find[holds](foundBy) : undefined) ?? (isUuid(value.id) ? value.id : refuse(`${at} names no record here and has no id`));
        const named = { id, name: text(value.name, `${at}.name`) };
        recorded[field] = holds === "status" ? { ...named, category: oneOf(value.category, STATUS_CATEGORIES, `${at}.category`) } : named;
      }
    }
  }
  return recorded;
}

function refuse(message: string): never {
  throw new HttpError(400, message);
}

/** A frontmatter list of mappings, empty if the field is left out. */
function list(file: File, field: string): Record<string, unknown>[] {
  const value = file.data[field] ?? [];
  if (!Array.isArray(value) || !value.every((v) => v !== null && typeof v === "object")) refuse(`${file.path} ${field} must be a list`);
  return value as Record<string, unknown>[];
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") refuse(`${where} must be text`);
  return value;
}

function integer(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) refuse(`${where} must be a whole number`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (!allowed.includes(value as T)) refuse(`${where} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function date(value: unknown, where: string): Date {
  const parsed = typeof value === "string" ? new Date(value) : value instanceof Date ? value : undefined;
  if (!parsed || Number.isNaN(parsed.getTime())) refuse(`${where} must be a date and time, such as 2026-01-01T09:00:00Z`);
  return parsed;
}

function optionalDate(value: unknown, where: string): Date | null {
  return value === null || value === undefined ? null : date(value, where);
}
