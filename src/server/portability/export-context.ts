import type { Queryable } from "../db/database.js";
import type { Folder } from "./archive.js";
import type { ActorRef } from "./format.js";
import { writeFrontmatter } from "./frontmatter.js";

export interface ExportScope {
  workspaceId: string;
  /** The one Project to export; the whole Workspace when null. */
  projectId: string | null;
  /** Whether to include every Version of Documents, Reports and Guidance, not only the current one. */
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
}

/**
 * What every part of an export shares: the files written so far, and who they name, so a
 * Project export's `people.md` lists only those.
 */
export class ExportContext {
  readonly folder: Folder = new Map();
  readonly usedUsers = new Set<string>();
  readonly usedAgents = new Set<string>();
  readonly usedSessions = new Set<string>();
  /** Users' emails by id. */
  readonly emailOf: Map<string, string>;

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
      "SELECT id, email, name, role, deactivated_at FROM users WHERE workspace_id = $1 ORDER BY lower(name), lower(email)",
      [scope.workspaceId],
    );
    return new ExportContext(db, scope, rows);
  }

  /** Writes the file at `path`: `data` as frontmatter, then `body`. */
  add(path: string, data: Record<string, unknown>, body = ""): void {
    this.folder.set(path, writeFrontmatter(data, body));
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
    this.usedUsers.add(row.actor_user_id);
    if (row.actor_agent_id === null) return this.user(row.actor_user_id)!;
    this.usedAgents.add(row.actor_agent_id);
    if (row.actor_session_id !== null) this.usedSessions.add(row.actor_session_id);
    return { agent: row.actor_agent_id, session: row.actor_session_id };
  }
}
