import { gunzipSync, gzipSync } from "node:zlib";
import tar from "tar-stream";
import { HttpError } from "../context.js";

/**
 * Archives: how a folder of files travels over HTTP. Exports are gzipped tar archives; imports
 * take one gzipped or plain, as `tar czf` or `tar cf` makes of a folder.
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
 * The files in a gzipped or plain tar archive, with paths made relative (no leading `./`) and
 * the clutter archivers add left out: hidden files and folders, such as macOS's `._` files and
 * `__MACOSX`. Anything that isn't a readable tar archive answers 400.
 */
export async function unpackFolder(archive: Buffer): Promise<Folder> {
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

const notAnArchive = () => new HttpError(400, "This isn't a tar archive (.tar or .tar.gz) of a folder");

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
