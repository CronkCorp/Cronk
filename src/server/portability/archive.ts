import { gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import tar from "tar-stream";
import { HttpError } from "../context.js";

/**
 * Archives: how a folder of files travels over HTTP. Exports are gzipped tar archives; imports
 * take one gzipped or plain, as `tar czf` or `tar cf` makes of a folder, or a zip archive, as a
 * file manager's "Compress" makes of one.
 */

/** A folder's files: path (`/`-separated, relative) to text, in the order they are packed. */
export type Folder = Map<string, string>;

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
  if (archive.subarray(0, 4).equals(ZIP_LOCAL) || archive.subarray(0, 4).equals(ZIP_END)) return unzipFolder(archive);
  let raw = archive;
  if (archive[0] === 0x1f && archive[1] === 0x8b) {
    try {
      raw = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
    } catch {
      throw notAnArchive();
    }
  }
  const folder: Folder = new Map();
  const extract = tar.extract();
  const done = (async () => {
    for await (const entry of extract) {
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(Buffer.from(chunk as Uint8Array));
      const path = relativePath(entry.header.name);
      if (entry.header.type === "file" && path !== undefined) folder.set(path, Buffer.concat(chunks).toString("utf8"));
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

const notAnArchive = () => new HttpError(400, "This isn't a zip or tar archive (.zip, .tar or .tar.gz) of a folder");

/** The signatures a zip archive starts with: a file's local header, or the end record of an empty archive. */
const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_END = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

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
    throw notAnArchive();
  }
}

function readZip(archive: Buffer): Folder {
  // The end record is the last 22 bytes, unless an archive comment (up to 65,535 bytes) follows it.
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at--) {
    if (archive.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw notAnArchive();
  const entries = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const folder: Folder = new Map();
  let unpacked = 0;
  for (let i = 0; i < entries; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw notAnArchive();
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
    if (archive.readUInt32LE(local) !== 0x04034b50) throw notAnArchive();
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    if (start + packedSize > archive.length) throw notAnArchive();
    const packed = archive.subarray(start, start + packedSize);
    const data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, MAX_UNPACKED_BYTES - unpacked) });
    unpacked += data.length;
    folder.set(path, data.toString("utf8"));
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
    current = new Map([...current].map(([path, text]) => [path.slice(path.indexOf("/") + 1), text]));
  }
}
