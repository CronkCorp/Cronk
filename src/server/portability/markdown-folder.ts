import type { Actor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { insertDocument, type Tree, type TreeEntry } from "../knowledge/documents.js";
import { unwrapFolder, type Folder } from "./archive.js";
import { readFrontmatter } from "./frontmatter.js";
import { MARKDOWN_FILE } from "../../shared/values.js";

/**
 * Importing a plain folder of Markdown files as Documents: each file becomes a Document and each
 * folder one too, with what it holds under it, so the page tree mirrors the folders.
 */

/** A Document to create, with those to create under it. */
interface DocumentToCreate {
  title: string;
  body: string;
  children: DocumentToCreate[];
}

/** A folder's own file: its README or index, whose Document the folder becomes. */
const FOLDER_OWN_FILE = /^(readme|index)\.(md|markdown)$/i;

/**
 * Creates the Markdown files of `folder` as Documents at the top of `tree`, after those already
 * there, and returns the new Documents depth first. Files other than Markdown are skipped. A folder
 * holding only one folder is that folder's archive, so its contents go at the top. Run inside a transaction.
 */
export async function importMarkdownFolder(db: Queryable, tree: Tree, folder: Folder, actor: Actor, now: Date): Promise<TreeEntry[]> {
  const markdown = unwrapFolder(new Map([...folder].filter(([path]) => MARKDOWN_FILE.test(path))));
  const toCreate = documentsIn([...markdown.keys()].map((path) => ({ path, relative: path })), markdown);
  const created: TreeEntry[] = [];
  const create = async (planned: DocumentToCreate, parentId: string | null, depth: number) => {
    const document = await insertDocument(db, { tree, parentId, title: planned.title, body: planned.body, actor, now });
    if (document === "no such parent") throw new Error("A Document just created vanished");
    created.push({ id: document.id, parentId, title: document.title, depth });
    for (const child of planned.children) await create(child, document.id, depth + 1);
  };
  for (const planned of toCreate) await create(planned, null, 0);
  return created;
}

/** The Documents to create for one folder's `entries` (paths relative to it), files and folders in natural name order. */
function documentsIn(entries: { path: string; relative: string }[], folder: Folder): DocumentToCreate[] {
  let files = entries.filter((e) => !e.relative.includes("/"));
  const folders = new Map<string, { path: string; relative: string }[]>();
  for (const e of entries.filter((e) => e.relative.includes("/"))) {
    const [name, ...rest] = e.relative.split("/");
    folders.set(name!, [...(folders.get(name!) ?? []), { path: e.path, relative: rest.join("/") }]);
  }
  const named: [name: string, planned: DocumentToCreate][] = [];
  for (const [name, inside] of folders) {
    // A file named like the folder, such as `setup.md` beside `setup/`, is the folder's own file if it has no README or index.
    const beside = files.find((e) => e.relative.replace(MARKDOWN_FILE, "") === name);
    const own = inside.find((e) => FOLDER_OWN_FILE.test(e.relative)) ?? beside;
    if (own && own === beside) files = files.filter((e) => e !== beside);
    const rest = inside.filter((e) => e !== own);
    named.push([name, { ...(own ? documentFrom(own.path, folder, name) : { title: name, body: "" }), children: documentsIn(rest, folder) }]);
  }
  for (const e of files) {
    const name = e.relative.replace(MARKDOWN_FILE, "");
    named.push([name, documentFrom(e.path, folder, name)]);
  }
  return named.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })).map(([, p]) => p);
}

/**
 * The Document to create from the Markdown file at `path`: titled by its frontmatter's `title`, else by a `#`
 * heading on its first line, else `fallback`. Frontmatter is left out of the body.
 */
function documentFrom(path: string, folder: Folder, fallback: string): DocumentToCreate {
  let parsed: ReturnType<typeof readFrontmatter>;
  try {
    parsed = readFrontmatter(folder.get(path)!.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new HttpError(400, `${path} can't be read: ${(err as Error).message}`);
  }
  const fromFrontmatter = typeof parsed.data.title === "string" ? parsed.data.title.trim() : "";
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(parsed.body.split(/\r?\n/, 1)[0] ?? "")?.[1]?.trim() ?? "";
  const title = (fromFrontmatter || heading || fallback).slice(0, 500);
  return { title, body: parsed.body, children: [] };
}
