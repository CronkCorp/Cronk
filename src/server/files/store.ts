import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
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
  /** Removes the file under `key`; removing one that isn't there does nothing. */
  delete(key: string): Promise<void>;
  /** The keys of every file under the folder `prefix`, however deep, in order. */
  list(prefix: string): Promise<string[]>;
}

/** A file refused for growing past the most a store was told to take. */
export class FileTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`The file is larger than ${maxBytes} bytes`);
  }
}

/** Keys are `/`-separated paths of letters, digits, `-`, `_` and `.`, never climbing out with `..`. */
export const KEY = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Ends the name of a file still being written beside its place; never one of a key, which takes no `~`. */
const PARTIAL_SUFFIX = "~partial";
const PARTIAL = /~partial$/;

/** A `FileStore` on local disk, under the directory `root`. A file is written beside its place first and moved in, so a reader never sees half of one. */
export class LocalDiskStore implements FileStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    if (!KEY.test(key)) throw new Error(`Not a file key: ${key}`);
    return join(this.root, ...key.split("/"));
  }

  async put(key: string, bytes: Readable | Buffer, opts: { maxBytes?: number } = {}): Promise<number> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${randomBytes(6).toString("hex")}${PARTIAL_SUFFIX}`;
    let size = 0;
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (opts.maxBytes !== undefined && size > opts.maxBytes) done(new FileTooLarge(opts.maxBytes));
        else done(null, chunk);
      },
    });
    try {
      const source = Buffer.isBuffer(bytes) ? [bytes] : bytes;
      await pipeline(source, counting, createWriteStream(partial));
      await rename(partial, path);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    return size;
  }

  get(key: string, range?: ByteRange): Readable {
    return createReadStream(this.path(key), range ? { start: range.start, end: range.end } : {});
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
      .filter((entry) => entry.isFile() && !PARTIAL.test(entry.name))
      .map((entry) => relative(this.root, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .sort();
  }

}
