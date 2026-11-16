import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, createInflateRaw, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import tar from "tar-stream";
import { HttpError } from "../context.js";
import { FileTooLarge, type FileStore } from "../files/store.js";
import { formatBytes } from "../files/sizes.js";

/**
 * Archives: how a folder of files travels over HTTP. Exports are gzipped tar archives; imports
 * take one gzipped or plain, as `tar czf` or `tar cf` makes of a folder, or a zip archive, as a
 * file manager's "Compress" makes of one.
 */

/**
 * A folder's files: path (`/`-separated, relative) to contents, in the order they are packed. Files written as text
 * are strings; files unpacked from an archive, and files such as Attachments that aren't text, are bytes.
 */
export type Folder = Map<string, string | Buffer>;

/** A file of a folder kept in the file store rather than in memory: its key there, and how many bytes it holds. */
export interface StoredFile {
  key: string;
  size: number;
}

/**
 * A folder whose large files, such as Attachments and Artifact files, are kept in the file store and only the
 * small ones in memory: an export as it is written, or one as an import unpacks it.
 */
export type StoredFolder = Map<string, string | Buffer | StoredFile>;

/** Whether `contents` is a file kept in the file store rather than in memory. */
export const isStored = (contents: string | Buffer | StoredFile): contents is StoredFile => typeof contents === "object" && !Buffer.isBuffer(contents);

/** A file's contents as bytes, text as UTF-8. */
export const bytesOf = (contents: string | Buffer): Buffer => (typeof contents === "string" ? Buffer.from(contents, "utf8") : contents);

/** A file's contents read as UTF-8 text. */
export const textOf = (contents: string | Buffer): string => (typeof contents === "string" ? contents : contents.toString("utf8"));

/** The media types an uploaded archive may come as. */
export const ARCHIVE_TYPES = [
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-compressed-tar",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
];

/** The uploaded archive; a body sent as another type, such as JSON, is refused. */
export function archiveBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  throw new HttpError(400, `Send the archive itself as the request body, typed ${ARCHIVE_TYPES.join(", ")}`);
}

/** The most an archive may unpack to, so a small upload can't fill the memory; a streamed import counts only its Markdown files. */
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

/** The most an archive's Markdown files may take packed, in a streamed import: as much as an archive held in memory may take whole. */
export const MAX_PACKED_BYTES = 200 * 1024 * 1024;

/** Packs `folder` into a gzipped tar archive. */
export async function packFolder(folder: Folder): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const read = (async () => {
    for await (const chunk of pack) chunks.push(Buffer.from(chunk as Uint8Array));
  })();
  for (const [name, text] of folder) pack.entry({ name, mode: 0o644 }, text);
  pack.finalize();
  await read;
  return gzipSync(Buffer.concat(chunks));
}

/**
 * The files in a zip archive or a gzipped or plain tar archive, with paths made relative (no
 * leading `./`) and the clutter archivers add left out: hidden files and folders, such as macOS's
 * `._` files and `__MACOSX`. Anything that isn't a readable archive answers 400.
 */
export async function unpackFolder(archive: Buffer): Promise<Folder> {
  if (signedAt(archive, 0, ZIP_LOCAL) || signedAt(archive, 0, ZIP_END)) return unzipFolder(archive);
  let raw = archive;
  if (archive[0] === 0x1f && archive[1] === 0x8b) {
    try {
      raw = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
    } catch (err) {
      throw (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE" ? tooLarge() : notAnArchive();
    }
  }
  const folder: Folder = new Map();
  const extract = tar.extract();
  const done = (async () => {
    for await (const entry of extract) {
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(Buffer.from(chunk as Uint8Array));
      const path = relativePath(entry.header.name);
      if (entry.header.type === "file" && path !== undefined) folder.set(path, Buffer.concat(chunks));
    }
  })();
  extract.end(raw);
  try {
    await done;
  } catch {
    throw notAnArchive();
  }
  // tar-stream reads an archive of anything but tar headers as empty, so an empty result is checked by its first header.
  if (folder.size === 0 && !looksLikeTar(raw)) throw notAnArchive();
  return folder;
}

const tooLarge = () => new HttpError(400, `This archive unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB, more than an import takes`);
const notAnArchive = () => new HttpError(400, "This isn't a zip or tar archive (.zip, .tar or .tar.gz) of a folder");

/** Zip record signatures: a file's local header, a central directory entry, and the end record. */
const ZIP_LOCAL = Buffer.from("PK\x03\x04", "latin1");
const ZIP_CENTRAL = Buffer.from("PK\x01\x02", "latin1");
const ZIP_END = Buffer.from("PK\x05\x06", "latin1");

/** Whether `bytes` holds `signature` at `at`. */
const signedAt = (bytes: Buffer, at: number, signature: Buffer) => bytes.subarray(at, at + 4).equals(signature);

/**
 * The files of a zip archive, read from its central directory: stored or deflated entries only, and
 * none encrypted or in the zip64 format (which only archives past 4 GB or 65,535 entries need).
 */
function unzipFolder(archive: Buffer): Folder {
  try {
    return readZip(archive);
  } catch (err) {
    // Reading past the end of the bytes, or inflating what doesn't inflate, means a damaged archive.
    if (err instanceof HttpError) throw err;
    if ((err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") throw tooLarge();
    throw notAnArchive();
  }
}

/** A file in a zip archive, as its central directory describes it. */
interface ZipEntry {
  /** Its path, relative to the archive's root. */
  path: string;
  /** How its bytes are packed: 0 stored, 8 deflated. */
  method: number;
  packedSize: number;
  /** Where its local header starts. */
  local: number;
}

/** Where a zip archive's end record starts in `tail`, its last bytes; the end record is the last 22 bytes, unless a comment (up to 65,535 bytes) follows it. */
function zipEnd(tail: Buffer): number {
  for (let at = tail.length - 22; at >= Math.max(0, tail.length - 22 - 0xffff); at--) {
    if (signedAt(tail, at, ZIP_END)) return at;
  }
  throw notAnArchive();
}

/**
 * The files `directory`, a zip archive's central directory starting at its first entry, lists: `count` entries, less
 * folders and hidden files. Refuses what Cronk can't read: encrypted entries, the zip64 format (which only archives
 * past 4 GB or 65,535 entries need), packing other than stored or deflated, and entries sharing bytes.
 */
function zipEntries(directory: Buffer, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const localHeaders = new Set<number>();
  let at = 0;
  for (let i = 0; i < count; i++) {
    // A central directory entry: 46 bytes of fields, then the name, extra field and comment.
    if (!signedAt(directory, at, ZIP_CENTRAL)) throw notAnArchive();
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const packedSize = directory.readUInt32LE(at + 20);
    const size = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const local = directory.readUInt32LE(at + 42);
    // Names are UTF-8 when flagged so, and in practice otherwise too; some Windows archivers separate folders with `\`.
    const name = directory.toString("utf8", at + 46, at + 46 + nameLength).replaceAll("\\", "/");
    at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    const path = relativePath(name);
    if (name.endsWith("/") || path === undefined) continue;
    if (flags & 1) throw new HttpError(400, "This zip archive is encrypted; Cronk can't read it");
    if (packedSize === 0xffffffff || size === 0xffffffff) throw new HttpError(400, "This zip archive is in the zip64 format, which Cronk can't read");
    if (method !== 0 && method !== 8) throw new HttpError(400, `This zip archive packs ${name} in a way Cronk can't read; zip it with plain deflate`);
    // Entries sharing a file's bytes make a small archive unpack many times over, as a zip bomb does; no archiver writes them.
    if (localHeaders.has(local)) throw new HttpError(400, "This zip archive's entries overlap, as a zip bomb's do; Cronk won't unpack it");
    localHeaders.add(local);
    entries.push({ path, method, packedSize, local });
  }
  return entries;
}

/** Where an entry's packed bytes start, from its local header (`header`, at least 30 bytes): its fields, then its name and extra field. */
function zipDataStart(entry: ZipEntry, header: Buffer): number {
  if (!signedAt(header, 0, ZIP_LOCAL)) throw notAnArchive();
  return entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

/** The files of a zip archive; throws a RangeError (or a zlib error) on bytes that don't add up. */
function readZip(archive: Buffer): Folder {
  const end = zipEnd(archive);
  const directory = archive.subarray(archive.readUInt32LE(end + 16));
  const folder: Folder = new Map();
  let unpacked = 0;
  for (const entry of zipEntries(directory, archive.readUInt16LE(end + 10))) {
    const start = zipDataStart(entry, archive.subarray(entry.local, entry.local + 30));
    if (start + entry.packedSize > archive.length) throw notAnArchive();
    const packed = archive.subarray(start, start + entry.packedSize);
    const data = entry.method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, MAX_UNPACKED_BYTES - unpacked) });
    unpacked += data.length;
    if (unpacked > MAX_UNPACKED_BYTES) throw tooLarge();
    folder.set(entry.path, Buffer.from(data));
  }
  return folder;
}

/** Whether `raw` starts with a tar header: `ustar` at offset 257, or a checksum that adds up. */
function looksLikeTar(raw: Buffer): boolean {
  if (raw.length < 512) return false;
  if (raw.subarray(257, 262).toString("latin1") === "ustar") return true;
  const stored = parseInt(raw.subarray(148, 156).toString("latin1").replace(/\0.*$/s, "").trim(), 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : raw[i]!;
  return stored === sum;
}

/** `name` relative to the archive's root, or undefined if it is hidden or lies outside the root. */
function relativePath(name: string): string | undefined {
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === ".." || part.startsWith(".") || part === "__MACOSX")) return undefined;
  return parts.join("/");
}

/** `folder` with any single folder holding all of it taken off, as archiving a folder (`tar czf x.tgz folder/`) adds one. */
export function unwrapFolder<F extends Map<string, unknown>>(folder: F): F {
  let current = folder;
  for (;;) {
    const paths = [...current.keys()];
    const tops = new Set(paths.map((p) => p.split("/")[0]));
    if (tops.size !== 1 || paths.some((p) => !p.includes("/"))) return current;
    current = new Map([...current].map(([path, contents]) => [path.slice(path.indexOf("/") + 1), contents])) as F;
  }
}

/**
 * `folder` packed as a gzipped tar archive, written as it is read: files in memory as they are, and files in `store`
 * each read as a stream when its turn comes, so neither a whole stored file nor the whole archive is ever held.
 */
export function packFolderStream(folder: StoredFolder, store: FileStore): Readable {
  const pack = tar.pack();
  const out = createGzip();
  // Its failures show on `out`, which the response reads; a download that stops early closes `out`, which stops the packing.
  pipeline(pack as unknown as Readable, out).catch(() => {});
  const closed = new Promise<void>((resolve) => out.once("close", resolve));
  /** Waits until `written` is, or the download has stopped, after which what it does is no longer anyone's concern. */
  const untilWritten = (written: Promise<void>) => {
    written.catch(() => {});
    return Promise.race([written, closed]);
  };
  void (async () => {
    for (const [name, contents] of folder) {
      if (out.destroyed) return;
      if (!isStored(contents)) {
        const written = new Promise<void>((resolve, reject) => pack.entry({ name, mode: 0o644 }, contents, (err?: Error | null) => (err ? reject(err) : resolve())));
        await untilWritten(written);
        continue;
      }
      const file = store.get(contents.key);
      const written = new Promise<void>((resolve, reject) => {
        const entry = pack.entry({ name, mode: 0o644, size: contents.size }, (err) => (err ? reject(err) : resolve()));
        entry.on("error", reject);
        file.once("error", (err) => {
          entry.destroy(err);
          reject(err);
        });
        file.pipe(entry as unknown as NodeJS.WritableStream);
      });
      try {
        await untilWritten(written);
      } finally {
        file.destroy();
      }
    }
    if (!out.destroyed) pack.finalize();
  })().catch((err: unknown) => out.destroy(err as Error));
  return out;
}

/** How a streamed import keeps the files it unpacks that aren't Markdown. */
export interface Unpacking {
  store: FileStore;
  /** A new key to store the next such file under for now; the caller removes every one it gives, whatever happens. */
  temporaryKey(): string;
  /** The most bytes the file at `path` may take, given the Markdown files unpacked so far. */
  maxBytes(path: string, markdown: StoredFolder): number;
}

/** Whether a file at `path` is held in memory by a streamed import, as Markdown is, rather than streamed into the store. */
const isMarkdown = (path: string) => path.endsWith(".md");

/**
 * The files of the archive `body` streams in, as `unpackFolder` reads them, but held in memory only when they are
 * Markdown: every other file is streamed into the store under a temporary key as it arrives, capped at the size
 * `how.maxBytes` allows, and stands in the folder as a `StoredFile`. The archive limits count only the Markdown files.
 * A gzipped or plain tar archive is read as it streams; a zip archive, whose directory is at its end, is written
 * to a temporary file on local disk first and read from there.
 */
export async function unpackFolderStream(body: Readable, how: Unpacking): Promise<StoredFolder> {
  const [head, rest] = await peek(body, 4);
  if (signedAt(head, 0, ZIP_LOCAL) || signedAt(head, 0, ZIP_END)) {
    const dir = await mkdtemp(join(tmpdir(), "cronk-import-"));
    try {
      const path = join(dir, "upload.zip");
      await pipeline(rest, createWriteStream(path));
      return await unzipFileToStore(path, how);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return untarToStore(rest, head[0] === 0x1f && head[1] === 0x8b, how);
}

/** The first `n` bytes of `body` (fewer if it is shorter), and `body` whole again, those bytes included. */
async function peek(body: Readable, n: number): Promise<[Buffer, Readable]> {
  const reading = body[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let length = 0;
  let ended = false;
  while (length < n) {
    const next = await reading.next();
    if (next.done) {
      ended = true;
      break;
    }
    const chunk = Buffer.from(next.value as Uint8Array);
    chunks.push(chunk);
    length += chunk.length;
  }
  const head = Buffer.concat(chunks);
  async function* replay() {
    if (head.length > 0) yield head;
    if (ended) return;
    for (;;) {
      const next = await reading.next();
      if (next.done) return;
      yield Buffer.from(next.value as Uint8Array);
    }
  }
  return [head, Readable.from(replay(), { objectMode: false })];
}

/** Counts the Markdown files a streamed import holds in memory, refusing it once they grow past the archive limits. */
class MarkdownBudget {
  private packed = 0;
  private unpacked = 0;

  /** Notes that a Markdown file took `packed` bytes in the archive; refuses the import past the limit. */
  addPacked(packed: number): void {
    this.packed += packed;
    if (this.packed > MAX_PACKED_BYTES) {
      throw new HttpError(413, `This archive's Markdown files take more than ${formatBytes(MAX_PACKED_BYTES)} packed, more than an import takes`);
    }
  }

  /** Notes `bytes` more of a Markdown file unpacked; refuses the import past the limit. */
  addUnpacked(bytes: number): void {
    this.unpacked += bytes;
    if (this.unpacked > MAX_UNPACKED_BYTES) {
      throw new HttpError(413, `This archive's Markdown files unpack to more than ${formatBytes(MAX_UNPACKED_BYTES)}, more than an import takes`);
    }
  }

  /** All of `file`, a Markdown file being unpacked, counted as it is read. */
  async read(file: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of file) {
      this.addUnpacked(chunk.length);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

/** Streams the file at `path`, which `file` gives, into the store under a temporary key, refusing it past its cap with a 413 naming it. */
async function storeUnpacked(path: string, file: Readable, how: Unpacking, folder: StoredFolder): Promise<void> {
  const maxBytes = how.maxBytes(path, folder);
  const key = how.temporaryKey();
  try {
    folder.set(path, { key, size: await how.store.put(key, file, { maxBytes }) });
  } catch (err) {
    if (err instanceof FileTooLarge) throw new HttpError(413, `${path} is larger than ${formatBytes(maxBytes)}, the most a file of this import may be in this Workspace`);
    throw err;
  }
}

/** Counts the bytes passing through it. */
function counter(): { stream: Transform; count: () => number } {
  let count = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      count += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, count: () => count };
}

/** The files of a tar archive, gzipped if `gzipped`, as `body` streams them in; see `unpackFolderStream`. */
async function untarToStore(body: Readable, gzipped: boolean, how: Unpacking): Promise<StoredFolder> {
  const folder: StoredFolder = new Map();
  const budget = new MarkdownBudget();
  // The packed bytes read so far, for what the Markdown files take packed, and the first 512 bytes of the tar inside.
  const packed = counter();
  let tarHead = Buffer.alloc(0);
  const raw = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (tarHead.length < 512) tarHead = Buffer.concat([tarHead, chunk.subarray(0, 512 - tarHead.length)]);
      done(null, chunk);
    },
  });
  const extract = tar.extract();
  let unreadable = false;
  let bodyFailed = false;
  body.once("error", () => (bodyFailed = true));
  const stages: NodeJS.ReadWriteStream[] = gzipped ? [createGunzip(), raw] : [raw];
  const feeding = pipeline(body, packed.stream, ...stages, extract as unknown as NodeJS.WritableStream).catch((err: unknown) => {
    if (!bodyFailed) unreadable = true;
    throw err;
  });
  feeding.catch(() => {});
  try {
    for await (const entry of extract) {
      const path = relativePath(entry.header.name);
      const file = entry as unknown as Readable;
      if (entry.header.type !== "file" || path === undefined) {
        file.resume();
        await new Promise((resolve) => file.once("end", resolve));
      } else if (isMarkdown(path)) {
        const start = packed.count();
        folder.set(path, await budget.read(file));
        budget.addPacked(packed.count() - start);
      } else {
        await storeUnpacked(path, file, how, folder);
      }
    }
    await feeding;
  } catch (err) {
    body.destroy();
    if (err instanceof HttpError || bodyFailed) throw err;
    if (unreadable || !(err instanceof Error && "code" in err)) throw notAnArchive();
    throw err;
  }
  // tar-stream reads an archive of anything but tar headers as empty, so an empty result is checked by its first header.
  if (folder.size === 0 && !looksLikeTar(tarHead)) throw notAnArchive();
  return folder;
}

/** The files of the zip archive in the file at `path`, read from its central directory; see `unpackFolderStream`. */
async function unzipFileToStore(path: string, how: Unpacking): Promise<StoredFolder> {
  const file = await open(path);
  try {
    return await readZipFile(file, path, how);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Reading past the end of the file, or inflating what doesn't inflate, means a damaged archive.
    if (err instanceof RangeError || (err as { code?: unknown }).code?.toString().startsWith("Z_")) throw notAnArchive();
    throw err;
  } finally {
    await file.close();
  }
}

/** The bytes of `file` from `at`, `length` of them, or fewer at its end. */
async function readAt(file: FileHandle, at: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, at);
  return bytes.subarray(0, bytesRead);
}

async function readZipFile(file: FileHandle, path: string, how: Unpacking): Promise<StoredFolder> {
  const { size } = await file.stat();
  const tailStart = Math.max(0, size - 22 - 0xffff);
  const tail = await readAt(file, tailStart, size - tailStart);
  const end = zipEnd(tail);
  const directoryAt = tail.readUInt32LE(end + 16);
  const directory = await readAt(file, directoryAt, tail.readUInt32LE(end + 12));
  const folder: StoredFolder = new Map();
  const budget = new MarkdownBudget();
  for (const entry of zipEntries(directory, tail.readUInt16LE(end + 10))) {
    const start = zipDataStart(entry, await readAt(file, entry.local, 30));
    if (start + entry.packedSize > size) throw notAnArchive();
    const packed = entry.packedSize === 0 ? Readable.from([]) : createReadStream(path, { start, end: start + entry.packedSize - 1 });
    const data = entry.method === 0 ? packed : packed.pipe(createInflateRaw());
    if (entry.method !== 0) packed.once("error", (err: Error) => data.destroy(err));
    if (isMarkdown(entry.path)) {
      budget.addPacked(entry.packedSize);
      folder.set(entry.path, await budget.read(data));
    } else {
      await storeUnpacked(entry.path, data, how, folder);
    }
  }
  return folder;
}
