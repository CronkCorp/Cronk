import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import tar from "tar-stream";
import { HttpError } from "../context.js";

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

/** The most an archive may unpack to, so a small upload can't fill the memory. */
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

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

/** The files of a zip archive; throws a RangeError (or a zlib error) on bytes that don't add up. */
function readZip(archive: Buffer): Folder {
  // The end record is the last 22 bytes, unless an archive comment (up to 65,535 bytes) follows it.
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at--) {
    if (signedAt(archive, at, ZIP_END)) {
      end = at;
      break;
    }
  }
  if (end < 0) throw notAnArchive();
  const entries = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const folder: Folder = new Map();
  const localHeaders = new Set<number>();
  let unpacked = 0;
  for (let i = 0; i < entries; i++) {
    // A central directory entry: 46 bytes of fields, then the name, extra field and comment.
    if (!signedAt(archive, at, ZIP_CENTRAL)) throw notAnArchive();
    const flags = archive.readUInt16LE(at + 8);
    const method = archive.readUInt16LE(at + 10);
    const packedSize = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    // Names are UTF-8 when flagged so, and in practice otherwise too; some Windows archivers separate folders with `\`.
    const name = archive.toString("utf8", at + 46, at + 46 + nameLength).replaceAll("\\", "/");
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
    const path = relativePath(name);
    if (name.endsWith("/") || path === undefined) continue;
    if (flags & 1) throw new HttpError(400, "This zip archive is encrypted; Cronk can't read it");
    if (packedSize === 0xffffffff || size === 0xffffffff) throw new HttpError(400, "This zip archive is in the zip64 format, which Cronk can't read");
    if (method !== 0 && method !== 8) throw new HttpError(400, `This zip archive packs ${name} in a way Cronk can't read; zip it with plain deflate`);
    // Entries sharing a file's bytes make a small archive unpack many times over, as a zip bomb does; no archiver writes them.
    if (localHeaders.has(local)) throw new HttpError(400, "This zip archive's entries overlap, as a zip bomb's do; Cronk won't unpack it");
    localHeaders.add(local);
    // A local header: 30 bytes of fields, then the name and extra field, then the packed bytes.
    if (!signedAt(archive, local, ZIP_LOCAL)) throw notAnArchive();
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    if (start + packedSize > archive.length) throw notAnArchive();
    const packed = archive.subarray(start, start + packedSize);
    const data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, MAX_UNPACKED_BYTES - unpacked) });
    unpacked += data.length;
    if (unpacked > MAX_UNPACKED_BYTES) throw tooLarge();
    folder.set(path, Buffer.from(data));
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
export function unwrapFolder(folder: Folder): Folder {
  let current = folder;
  for (;;) {
    const paths = [...current.keys()];
    const tops = new Set(paths.map((p) => p.split("/")[0]));
    if (tops.size !== 1 || paths.some((p) => !p.includes("/"))) return current;
    current = new Map([...current].map(([path, contents]) => [path.slice(path.indexOf("/") + 1), contents]));
  }
}
