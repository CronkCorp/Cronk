import type { Queryable } from "../db/database.js";
import type { StoredFolder } from "./archive.js";
import type { ActorRef } from "./format.js";
import { writeFrontmatter } from "./frontmatter.js";

export interface ExportScope {
  workspaceId: string;
  /** The one Project to export; the whole Workspace when null. */
  projectId: string | null;
  /** Whether to include every Version of Documents, Reports, Guidance and Terms, not only the current one. */
  versions: boolean;
  now: Date;
}

/** The actor columns history rows share. */
export interface ActorColumns {
  actor_user_id: string;
  actor_agent_id: string | null;
  actor_session_id: string | null;
}

export const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** A User of the Workspace, as `people.md` lists them. */
export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  deactivated_at: Date | null;
  diff_view: string;
}

/**
 * What every part of an export shares: the files written so far, and who they name, so a
 * Project export's `people.md` lists only those.
 */
export class ExportContext {
  readonly folder: StoredFolder = new Map();
  readonly usedUsers = new Set<string>();
  readonly usedAgents = new Set<string>();
  readonly usedSessions = new Set<string>();
  /** Users' emails by id. */
  readonly emailOf: Map<string, string>;
  /** The path of each Document and Report written so far, by id. */
  readonly documentPaths = new Map<string, string>();
  private readonly pending: (() => void)[] = [];

  private constructor(
    readonly db: Queryable,
    readonly scope: ExportScope,
    /** Every User of the Workspace. */
    readonly users: UserRow[],
  ) {
    this.emailOf = new Map(users.map((u) => [u.id, u.email]));
  }

  static async start(db: Queryable, scope: ExportScope): Promise<ExportContext> {
    const { rows } = await db.query<UserRow>(
      "SELECT id, email, name, role, deactivated_at, diff_view FROM users WHERE workspace_id = $1 ORDER BY lower(name), lower(email)",
      [scope.workspaceId],
    );
    return new ExportContext(db, scope, rows);
  }

  /** Writes the file at `path` as the `size` bytes stored under `key` in the file store, which are read only as the archive is packed. */
  addStoredFile(path: string, key: string, size: number): void {
    this.folder.set(path, { key, size });
  }

  /** Writes the file at `path`: `data` as frontmatter, then `body`. */
  add(path: string, data: Record<string, unknown>, body = ""): void {
    this.folder.set(path, writeFrontmatter(data, body));
  }

  /** Writes a file once every Document is written, by `write`, so it can name Documents by path. */
  afterDocuments(write: () => void): void {
    this.pending.push(write);
  }

  /** Writes the files waiting for every Document to be written. */
  writePending(): void {
    for (const write of this.pending.splice(0)) write();
  }

  /** The email of User `id`, or null for none. */
  user(id: string | null): string | null {
    if (id === null) return null;
    this.usedUsers.add(id);
    return this.emailOf.get(id)!;
  }

  /** The Agent `id`, as files name it. */
  agent(id: string | null): string | null {
    if (id !== null) this.usedAgents.add(id);
    return id;
  }

  /** The Actor a history row records, as files name it. */
  actor(row: ActorColumns): ActorRef {
    if (row.actor_agent_id === null) return this.user(row.actor_user_id)!;
    return this.agentActor({ ...row, actor_agent_id: row.actor_agent_id });
  }

  /** The Agent, and its Agent Session if any, that a history row records an Agent's act by. */
  agentActor(row: ActorColumns & { actor_agent_id: string }): { agent: string; session: string | null } {
    this.usedUsers.add(row.actor_user_id);
    this.usedAgents.add(row.actor_agent_id);
    if (row.actor_session_id !== null) this.usedSessions.add(row.actor_session_id);
    return { agent: row.actor_agent_id, session: row.actor_session_id };
  }
}
