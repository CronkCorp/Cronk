/**
 * Packs files picked in the browser into a gzipped tar archive, so a folder picked with
 * `<input webkitdirectory>` uploads as one archive, the way the import API takes it.
 */

import { MARKDOWN_FILE } from "../shared/values.js";

const BLOCK = 512;
const encoder = new TextEncoder();

/** The path a picked file has within the picked folder, starting with the folder's own name. */
const pathOf = (file: File) => file.webkitRelativePath || file.name;

/** A gzipped tar archive of the Markdown files among `files`, each at its path within the picked folder; undefined if there are none. */
export const packMarkdownFolder = (files: Iterable<File>): Promise<Blob | undefined> => packFolder(files, (path) => MARKDOWN_FILE.test(path));

/** A gzipped tar archive of the `files` whose path `keep` keeps (all of them by default), each at its path within the picked folder; undefined if none is kept. */
export async function packFolder(files: Iterable<File>, keep: (path: string) => boolean = () => true): Promise<Blob | undefined> {
  const parts: BlobPart[] = [];
  for (const file of files) {
    const path = pathOf(file);
    if (!keep(path)) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    parts.push(...entry(path, bytes));
  }
  if (parts.length === 0) return undefined;
  parts.push(new Uint8Array(BLOCK * 2));
  const tar = new Blob(parts);
  return new Response(tar.stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

/** A file's header block(s) and its data, padded to whole blocks. A path too long for the header goes in a pax header before it. */
function entry(path: string, bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
  const name = encoder.encode(path);
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  if (name.length > 100) {
    const record = paxRecord("path", path);
    blocks.push(header("PaxHeader", record.length, "x"), padded(record));
  }
  blocks.push(header(name.length > 100 ? path.slice(-100) : path, bytes.length, "0"), padded(bytes));
  return blocks;
}

/** A ustar header block for a file of `size` bytes. */
function header(name: string, size: number, type: string): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, at: number, length: number) => block.set(encoder.encode(text).subarray(0, length), at);
  const octal = (value: number, at: number, length: number) => put(value.toString(8).padStart(length - 1, "0"), at, length - 1);
  put(name, 0, 100);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(Math.floor(Date.now() / 1000), 136, 12);
  put(type, 156, 1);
  put("ustar\u000000", 257, 8);
  // The checksum is the sum of the header's bytes, counting its own field as spaces.
  put("        ", 148, 8);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, 8);
  return block;
}

/** A pax record, `<length> <key>=<value>\n`, where the length counts itself. */
function paxRecord(key: string, value: string): Uint8Array<ArrayBuffer> {
  const rest = encoder.encode(` ${key}=${value}\n`).length;
  let length = rest + 1;
  while (String(length).length + rest !== length) length = String(length).length + rest;
  return encoder.encode(`${length} ${key}=${value}\n`);
}

/** `bytes` followed by zeros up to a whole number of blocks. */
function padded(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
  out.set(bytes);
  return out;
}
