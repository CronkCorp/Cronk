import type { Queryable } from "../db/database.js";
import { STATUS_CATEGORIES } from "../../shared/values.js";
import type { Folder } from "./archive.js";
import { writeFrontmatter } from "./frontmatter.js";
import { FORMAT, README, slug, type ActorRef } from "./format.js";

/**
 * Exporting the Workspace or one Project as a folder of Markdown files with YAML frontmatter
 * (ADR 0003). `format.ts` describes the layout; `import.ts` reads it back.
 */

export interface ExportScope {
  workspaceId: string;
  /** The one Project to export; the whole Workspace when null. */
  projectId: string | null;
  /** Whether to include every Version of Documents, Reports and Guidance, not only the current one. */
  versions: boolean;
  now: Date;
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** The actor columns history rows share. */
interface ActorColumns {
  actor_user_id: string;
  actor_agent_id: string | null;
  actor_session_id: string | null;
}

/** Builds the export's files. Run inside a read-only, repeatable-read transaction so they agree with each other. */
export async function exportFolder(db: Queryable, scope: ExportScope): Promise<Folder> {
  const folder: Folder = new Map();
  const add = (path: string, data: Record<string, unknown>, body = "") => folder.set(path, writeFrontmatter(data, body));

  const { rows: users } = await db.query<{ id: string; email: string; name: string; role: string; deactivated_at: Date | null }>(
    "SELECT id, email, name, role, deactivated_at FROM users WHERE workspace_id = $1 ORDER BY lower(name), lower(email)",
    [scope.workspaceId],
  );
  const emailOf = new Map(users.map((u) => [u.id, u.email]));
  const usedUsers = new Set<string>();
  const usedAgents = new Set<string>();
  const usedSessions = new Set<string>();
  const user = (id: string | null): string | null => {
    if (id === null) return null;
    usedUsers.add(id);
    return emailOf.get(id)!;
  };
  const actor = (row: ActorColumns): ActorRef => {
    usedUsers.add(row.actor_user_id);
    if (row.actor_agent_id === null) return user(row.actor_user_id)!;
    usedAgents.add(row.actor_agent_id);
    if (row.actor_session_id !== null) usedSessions.add(row.actor_session_id);
    return { agent: row.actor_agent_id, session: row.actor_session_id };
  };

  /** Writes Comments on a Ticket or Document into `dir`, numbered from 1; returns their numbers by id. */
  const writeComments = async (dir: string, on: "ticket_id" | "document_id", id: string, activityNumbers = new Map<string, number>()) => {
    const { rows } = await db.query<
      ActorColumns & { id: string; reply_to_comment_id: string | null; reply_to_activity_id: string | null; anchor_passage: string | null; anchor_version: number | null; body: string; at: Date }
    >(`SELECT * FROM comments WHERE ${on} = $1 ORDER BY seq`, [id]);
    const numbers = new Map(rows.map((c, i) => [c.id, i + 1]));
    for (const c of rows) {
      add(
        `${dir}/${numbers.get(c.id)}.md`,
        {
          at: iso(c.at),
          by: actor(c),
          replyToComment: c.reply_to_comment_id === null ? undefined : numbers.get(c.reply_to_comment_id),
          replyToActivity: c.reply_to_activity_id === null ? undefined : activityNumbers.get(c.reply_to_activity_id),
          anchor: c.anchor_passage === null ? undefined : { passage: c.anchor_passage, version: c.anchor_version },
        },
        c.body,
      );
    }
    return numbers;
  };

  /** Writes a Document at `${base}.md`, with its Versions and Comments beside it. */
  const writeDocument = async (
    base: string,
    d: { id: string; title: string; body: string; version: number; created_at: Date; updated_at: Date; claim_id?: string | null },
  ) => {
    const { rows: versions } = await db.query<ActorColumns & { number: number; title: string; body: string; at: Date; restored_from: number | null }>(
      "SELECT * FROM document_versions WHERE document_id = $1 ORDER BY number",
      [d.id],
    );
    const first = versions[0]!;
    const current = versions.find((v) => v.number === d.version)!;
    add(
      `${base}.md`,
      {
        title: d.title,
        claim: d.claim_id ?? undefined,
        version: d.version,
        createdAt: iso(d.created_at),
        createdBy: actor(first),
        updatedAt: iso(d.updated_at),
        updatedBy: actor(current),
      },
      d.body,
    );
    if (scope.versions) {
      for (const v of versions) {
        add(`${base}.versions/${v.number}.md`, { title: v.title, at: iso(v.at), by: actor(v), restoredFrom: v.restored_from ?? undefined }, v.body);
      }
    }
    await writeComments(`${base}.comments`, "document_id", d.id);
  };

  /** Writes the page tree of the Workspace (projectId null) or a Project into `dir`. */
  const writeTree = async (dir: string, projectId: string | null) => {
    const { rows } = await db.query<{ id: string; parent_id: string | null; title: string; body: string; version: number; created_at: Date; updated_at: Date }>(
      `SELECT * FROM documents WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND ticket_id IS NULL ORDER BY position, created_at, id`,
      [scope.workspaceId, projectId],
    );
    const write = async (parentId: string | null, path: string) => {
      const siblings = rows.filter((d) => d.parent_id === parentId);
      for (const [i, d] of siblings.entries()) {
        const base = `${path}/${i + 1}-${slug(d.title)}`;
        await writeDocument(base, d);
        await write(d.id, base);
      }
    };
    await write(null, dir);
  };

  /** Writes Guidance at `${base}.md`, with its Versions beside it, if anyone has written it. */
  const writeGuidance = async (base: string, projectId: string | null) => {
    const { rows } = await db.query<{ version: number; markdown: string; at: Date; actor_user_id: string }>(
      "SELECT version, markdown, at, actor_user_id FROM guidance_versions WHERE workspace_id = $1 AND project_id IS NOT DISTINCT FROM $2 ORDER BY version",
      [scope.workspaceId, projectId],
    );
    const current = rows.at(-1);
    if (!current) return;
    add(`${base}.md`, { version: current.version, at: iso(current.at), by: user(current.actor_user_id) }, current.markdown);
    if (scope.versions) for (const v of rows) add(`${base}.versions/${v.version}.md`, { at: iso(v.at), by: user(v.actor_user_id) }, v.markdown);
  };

  if (scope.projectId === null) {
    const { rows } = await db.query<{ name: string; agent_access: string; silence_threshold_seconds: number }>("SELECT * FROM workspaces WHERE id = $1", [
      scope.workspaceId,
    ]);
    const w = rows[0]!;
    add("workspace.md", { name: w.name, agentAccess: w.agent_access, silenceThresholdSeconds: w.silence_threshold_seconds });
    await writeGuidance("guidance", null);
    await writeTree("documents", null);
  }

  const { rows: projects } = await db.query<{
    id: string;
    key: string;
    name: string;
    visibility: string;
    agent_access: string;
    archived_at: Date | null;
    created_at: Date;
    next_ticket_number: number;
  }>("SELECT * FROM projects WHERE workspace_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY key", [scope.workspaceId, scope.projectId]);

  for (const p of projects) {
    const dir = `projects/${p.key}`;
    const { rows: statuses } = await db.query<{ name: string; category: string }>(
      `SELECT name, category FROM statuses WHERE project_id = $1 ORDER BY array_position($2::text[], category), position`,
      [p.id, STATUS_CATEGORIES],
    );
    const { rows: members } = await db.query<{ user_id: string; access: string }>(
      "SELECT m.user_id, m.access FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY lower(u.email)",
      [p.id],
    );
    add(`${dir}/project.md`, {
      key: p.key,
      name: p.name,
      visibility: p.visibility,
      agentAccess: p.agent_access,
      archivedAt: iso(p.archived_at),
      createdAt: iso(p.created_at),
      nextTicketNumber: p.next_ticket_number,
      statuses,
      members: members.map((m) => ({ user: user(m.user_id), access: m.access })),
    });
    await writeGuidance(`${dir}/guidance`, p.id);
    await writeTree(`${dir}/documents`, p.id);

    const { rows: tickets } = await db.query<{
      id: string;
      number: number;
      title: string;
      description: string;
      status: string;
      priority: string;
      labels: string[];
      assignee_id: string | null;
      delegate_id: string | null;
      parent_number: number | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT t.*, s.name AS status, pt.number AS parent_number
       FROM tickets t JOIN statuses s ON s.id = t.status_id LEFT JOIN tickets pt ON pt.id = t.parent_id
       WHERE t.project_id = $1 ORDER BY t.number`,
      [p.id],
    );
    const { rows: relations } = await db.query<{ kind: string; from_id: string; from_key: string; to_id: string; to_key: string }>(
      `SELECT r.kind, r.from_ticket_id AS from_id, fp.key || '-' || f.number AS from_key, r.to_ticket_id AS to_id, tp.key || '-' || t.number AS to_key
       FROM ticket_relations r
         JOIN tickets f ON f.id = r.from_ticket_id JOIN projects fp ON fp.id = f.project_id
         JOIN tickets t ON t.id = r.to_ticket_id JOIN projects tp ON tp.id = t.project_id
       WHERE f.project_id = $1 OR t.project_id = $1`,
      [p.id],
    );
    const keyOrder = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    const related = (ticketId: string, kind: string, side: "from" | "to") => {
      const other = side === "from" ? "to" : "from";
      const keys = relations.filter((r) => r.kind === kind && r[`${side}_id`] === ticketId).map((r) => r[`${other}_key`]);
      return keys.length > 0 ? keys.sort(keyOrder) : undefined;
    };

    for (const t of tickets) {
      const key = `${p.key}-${t.number}`;
      const base = `${dir}/tickets/${key}`;
      const relatesTo = [...(related(t.id, "relates_to", "from") ?? []), ...(related(t.id, "relates_to", "to") ?? [])].sort(keyOrder);
      if (t.delegate_id !== null) usedAgents.add(t.delegate_id);
      add(
        `${base}.md`,
        {
          key,
          title: t.title,
          status: t.status,
          priority: t.priority,
          labels: t.labels,
          assignee: user(t.assignee_id),
          delegate: t.delegate_id,
          parent: t.parent_number === null ? null : `${p.key}-${t.parent_number}`,
          blocks: related(t.id, "blocks", "from"),
          blockedBy: related(t.id, "blocks", "to"),
          relatesTo: relatesTo.length > 0 ? relatesTo : undefined,
          createdAt: iso(t.created_at),
          updatedAt: iso(t.updated_at),
        },
        t.description,
      );

      const { rows: activities } = await db.query<ActorColumns & { id: string; kind: string; body: string; blocking: boolean; at: Date; answer_comment_id: string | null }>(
        "SELECT * FROM activities WHERE ticket_id = $1 ORDER BY seq",
        [t.id],
      );
      const activityNumbers = new Map(activities.map((a, i) => [a.id, i + 1]));
      const commentNumbers = await writeComments(`${base}.comments`, "ticket_id", t.id, activityNumbers);
      for (const a of activities) {
        const by = actor(a) as Exclude<ActorRef, string>;
        add(
          `${base}.activities/${activityNumbers.get(a.id)}.md`,
          {
            kind: a.kind,
            blocking: a.blocking || undefined,
            at: iso(a.at),
            agent: by.agent,
            session: by.session,
            answer: a.answer_comment_id === null ? undefined : commentNumbers.get(a.answer_comment_id),
          },
          a.body,
        );
      }

      const { rows: reports } = await db.query<{ id: string; title: string; body: string; version: number; created_at: Date; updated_at: Date; claim_id: string }>(
        "SELECT * FROM documents WHERE ticket_id = $1 ORDER BY created_at, id",
        [t.id],
      );
      for (const [i, r] of reports.entries()) await writeDocument(`${base}.reports/${i + 1}`, r);
    }
  }

  // Who the files name: every User and Agent of a Workspace export, only those named in a Project export.
  const whole = scope.projectId === null;
  const { rows: agents } = await db.query<{ id: string; name: string; owner_id: string; created_at: Date; removed_at: Date | null }>(
    "SELECT * FROM agents WHERE workspace_id = $1 ORDER BY created_at, id",
    [scope.workspaceId],
  );
  const exportedAgents = agents.filter((a) => whole || usedAgents.has(a.id));
  for (const a of exportedAgents) usedUsers.add(a.owner_id);
  const { rows: sessions } = await db.query<{ id: string; agent_id: string; started_at: Date; last_seen_at: Date; ended_at: Date | null }>(
    "SELECT * FROM agent_sessions WHERE id = ANY($1::uuid[]) ORDER BY started_at, id",
    [[...usedSessions]],
  );
  add(
    "people.md",
    {
      users: users
        .filter((u) => whole || usedUsers.has(u.id))
        .map((u) => ({ email: u.email, name: u.name, role: u.role, active: u.deactivated_at === null })),
      agents: exportedAgents.map((a) => ({ id: a.id, name: a.name, owner: emailOf.get(a.owner_id), createdAt: iso(a.created_at), removedAt: iso(a.removed_at) })),
      sessions: sessions.map((s) => ({ id: s.id, agent: s.agent_id, startedAt: iso(s.started_at), lastSeenAt: iso(s.last_seen_at), endedAt: iso(s.ended_at) })),
    },
    "The Users and Agents this export names. Files name a User by email, and an Agent and its Agent Sessions by the ids listed here.\n",
  );
  add("README.md", { cronk: { format: FORMAT, scope: whole ? "workspace" : "project", exportedAt: iso(scope.now), versions: scope.versions } }, README);

  // README first, then people, so someone opening the archive reads them first.
  return new Map([...folder].sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0)));
}

const rank = (path: string) => (path === "README.md" ? 0 : path === "people.md" ? 1 : 2);
