import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Files: the one storage interface Attachments (and later Artifacts) keep their bytes behind. Records
 * live in Postgres; the store holds only bytes, by key. Local disk is the default backend.
 */

/** A file's bytes `start` to `end`, both included, as an HTTP range names them. */
export interface ByteRange {
  start: number;
  end: number;
}

/** Where files' bytes are kept, by key: local disk by default. Every backend behaves the same, ranges included. */
export interface FileStore {
  /**
   * Stores `bytes` under `key`, replacing any file there, and answers how many bytes it stored. With `maxBytes`,
   * stops reading once the file grows past it, stores nothing and throws `FileTooLarge`.
   */
  put(key: string, bytes: Readable | Buffer, opts?: { maxBytes?: number }): Promise<number>;
  /** The bytes stored under `key`, or only `range` of them; a key with no file throws. */
  get(key: string, range?: ByteRange): Readable;
  /** How many bytes the file under `key` holds, or null when there is no file there; asks only for its metadata, never its bytes. */
  size(key: string): Promise<number | null>;
  /** Moves the file under `from` to `to`, replacing any file there; moving a key with no file throws. */
  move(from: string, to: string): Promise<void>;
  /** Removes the file under `key`; removing one that isn't there does nothing. */
  delete(key: string): Promise<void>;
  /** The keys of every file under the folder `prefix`, however deep, in order. */
  list(prefix: string): Promise<string[]>;
  /** Lets go of what the store holds open, such as connections; called once the server has stopped. */
  close(): Promise<void>;
}

/** A file refused for growing past the most a store was told to take. */
export class FileTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`The file is larger than ${maxBytes} bytes`);
  }
}

/**
 * A stream passing bytes through while counting them, failing with `FileTooLarge` once they grow past `maxBytes`,
 * if given. `size()` answers how many have passed so far.
 */
export function countingBytes(maxBytes: number | undefined): { stream: Transform; size: () => number } {
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (maxBytes !== undefined && size > maxBytes) done(new FileTooLarge(maxBytes));
      else done(null, chunk);
    },
  });
  return { stream, size: () => size };
}

/** Keys are `/`-separated paths of letters, digits, `-`, `_` and `.`, never climbing out with `..`. */
const KEY = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Answers `key`, throwing if it isn't a file key. */
export function checkKey(key: string): string {
  if (!KEY.test(key)) throw new Error(`Not a file key: ${key}`);
  return key;
}

/** Ends the name of a file still being written beside its place; never one of a key, which takes no `~`. */
const PARTIAL = "~partial";

/** A `FileStore` on local disk, under the directory `root`. A file is written beside its place first and moved in, so a reader never sees half of one. */
export class LocalDiskStore implements FileStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    return join(this.root, ...checkKey(key).split("/"));
  }

  async put(key: string, bytes: Readable | Buffer, opts: { maxBytes?: number } = {}): Promise<number> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${randomBytes(6).toString("hex")}${PARTIAL}`;
    const counting = countingBytes(opts.maxBytes);
    try {
      const source = Buffer.isBuffer(bytes) ? [bytes] : bytes;
      await pipeline(source, counting.stream, createWriteStream(partial));
      await rename(partial, path);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    return counting.size();
  }

  get(key: string, range?: ByteRange): Readable {
    return createReadStream(this.path(key), range ? { start: range.start, end: range.end } : {});
  }

  async size(key: string): Promise<number | null> {
    const stats = await stat(this.path(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
      throw err;
    });
    return stats?.isFile() ? stats.size : null;
  }

  async move(from: string, to: string): Promise<void> {
    const path = this.path(to);
    await mkdir(dirname(path), { recursive: true });
    await rename(this.path(from), path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const entries = await readdir(this.path(prefix), { recursive: true, withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });
    return entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith(PARTIAL))
      .map((entry) => relative(this.root, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .sort();
  }

  async close(): Promise<void> {}
}
