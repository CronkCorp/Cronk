import type { StoredActor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { bytesOf, isStored, textOf, type StoredFile, type StoredFolder } from "./archive.js";
import type { FileStore } from "../files/store.js";
import { natural, refuse, type File } from "./fields.js";
import { readFrontmatter } from "./frontmatter.js";
import { recordRenamedId, type RenamedId } from "./renamed-ids.js";
import { getWorkspace } from "../workspace/workspaces.js";

/** Where an import stores the files of Attachments and Artifacts, and the keys it stored them under so far. */
export interface ImportedFiles {
  store: FileStore;
  stored: string[];
}

/** A Workspace's limits on the files an import brings in. */
export interface FileLimits {
  attachmentMaxBytes: number;
  artifactMaxBytes: number;
  artifactMaxFiles: number;
}

/**
 * What every part of an import shares: the export's files, and the ids the Users, Agents and
 * Agent Sessions of its `people.md` have here, so other files can name them.
 */
export class ImportContext {
  /** Users by lower-case email. */
  readonly userIds = new Map<string, string>();
  /** Agents by their id in the export. */
  readonly agentIds = new Map<string, { id: string; ownerId: string }>();
  /** Agent Sessions by their id in the export. */
  readonly sessionIds = new Map<string, string>();
  /** The Agents and Agent Sessions that got a new id here, because theirs was taken. */
  readonly renamedIds: RenamedId[] = [];
  /** Documents and Reports imported so far, by the path of their file in the export. */
  readonly documentIds = new Map<string, string>();
  /** Suggestions imported so far that came from a Ticket, by its key, to link once the Tickets are in. */
  readonly suggestionSources: { suggestionId: string; ticketKey: string }[] = [];

  constructor(
    readonly db: Queryable,
    readonly workspaceId: string,
    /** The export, unwrapped: its Markdown files in memory, and its other files in the file store under temporary keys. */
    readonly folder: StoredFolder,
    readonly now: Date,
    /** Where the files of Attachments go. */
    readonly files: ImportedFiles,
  ) {}

  /** Records that the Agent or Agent Session with id `from` in the export has the id `to` here, if they differ. */
  async keepRenamedId(kind: RenamedId["kind"], from: string, to: string): Promise<void> {
    if (from === to) return;
    const renamed = { kind, from, to, at: this.now };
    this.renamedIds.push(renamed);
    await recordRenamedId(this.db, this.workspaceId, renamed);
  }

  /** Where each file of the export already moved to its place went, by its temporary key. */
  private readonly moved = new Map<string, string>();

  /**
   * Puts `contents`, a file of the export, under `key` in the file store, noting the key so a failed import can remove it
   * again, and answers its size. A file the import streamed into the store is moved there from its temporary key; one
   * the export names twice is copied from where it went the first time.
   */
  async storeFile(key: string, contents: string | Buffer | StoredFile): Promise<number> {
    this.files.stored.push(key);
    const { store } = this.files;
    if (!isStored(contents)) return store.put(key, bytesOf(contents));
    const earlier = this.moved.get(contents.key);
    if (earlier !== undefined) return store.put(key, store.get(earlier));
    await store.move(contents.key, key);
    this.moved.set(contents.key, key);
    return contents.size;
  }

  /** The size of `contents`, a file of the export, in bytes. */
  sizeOf(contents: string | Buffer | StoredFile): number {
    return isStored(contents) ? contents.size : bytesOf(contents).length;
  }

  /** The Workspace's limits on files, as its own settings or, once imported, the export's `workspace.md` set them. */
  fileLimits(): Promise<FileLimits> {
    return getWorkspace(this.db, this.workspaceId);
  }

  /** The text of the file at `path`, which the export must hold in memory as it holds Markdown files. */
  text(path: string): string | undefined {
    const contents = this.folder.get(path);
    if (contents === undefined) return undefined;
    if (isStored(contents)) refuse(`${path} must be a Markdown file`);
    return textOf(contents);
  }

  /** The file at `path`, read, if the export has it. */
  read(path: string): File | undefined {
    const contents = this.text(path);
    if (contents === undefined) return undefined;
    try {
      return { path, ...readFrontmatter(contents) };
    } catch (err) {
      refuse(`${path} can't be read: ${(err as Error).message}`);
    }
  }

  /** The file at `path`, read; refuses the import if the export lacks it. */
  need(path: string): File {
    return this.read(path) ?? refuse(`The export has no ${path}`);
  }

  /** The Markdown files directly in `dir`, in natural name order. */
  filesIn(dir: string): string[] {
    return [...this.folder.keys()]
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/") && p.endsWith(".md"))
      .sort(natural);
  }

  /** The numbered files (`1.md`, `2.md`, …) in `dir`, in number order. */
  numbered(dir: string): [number, File][] {
    return this.filesIn(dir)
      .map((p) => [Number(/\/(\d+)\.md$/.exec(p)?.[1]), p] as const)
      .filter(([n]) => Number.isInteger(n) && n > 0)
      .sort(([a], [b]) => a - b)
      .map(([n, p]) => [n, this.need(p)]);
  }

  /** The User with `email` in the export or this Workspace, if there is one. */
  async findUser(email: string): Promise<string | undefined> {
    const known = this.userIds.get(email.toLowerCase());
    if (known) return known;
    const { rows } = await this.db.query<{ id: string }>("SELECT id FROM users WHERE workspace_id = $1 AND lower(email) = lower($2)", [
      this.workspaceId,
      email,
    ]);
    if (rows[0]) this.userIds.set(email.toLowerCase(), rows[0].id);
    return rows[0]?.id;
  }

  /** The id of the User `email` names, who must be in `people.md` (or already here). */
  async userId(email: unknown, where: string): Promise<string> {
    if (typeof email !== "string" || email.trim() === "") refuse(`${where} must name a User by email`);
    return (await this.findUser(email)) ?? refuse(`${where} names ${email}, who isn't in people.md`);
  }

  /** The Agent `ref`, its id in the export, names. */
  agent(ref: unknown, where: string): { id: string; ownerId: string } {
    return this.agentIds.get(String(ref)) ?? refuse(`${where} names an Agent that isn't in people.md`);
  }

  /** The Actor `ref` names: a User by email, or `{ agent, session }` by their ids in the export. */
  async actor(ref: unknown, where: string): Promise<StoredActor> {
    if (typeof ref === "string") return { kind: "user", userId: await this.userId(ref, where), agentId: null, sessionId: null };
    if (ref === null || typeof ref !== "object") refuse(`${where} must name a User by email or an Agent`);
    const { agent, session } = ref as { agent?: unknown; session?: unknown };
    const found = this.agent(agent, where);
    const sessionId =
      session === null || session === undefined
        ? null
        : (this.sessionIds.get(String(session)) ?? refuse(`${where} names an Agent Session that isn't in people.md`));
    return { kind: "agent", userId: found.ownerId, agentId: found.id, sessionId };
  }
}
