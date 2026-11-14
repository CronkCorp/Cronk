import type { Actor } from "../actor.js";
import { HttpError } from "../context.js";
import type { Queryable } from "../db/database.js";
import { insertDocument, type Tree, type TreeEntry } from "../knowledge/documents.js";
import { unwrapFolder, type Folder } from "./archive.js";
import { readFrontmatter } from "./frontmatter.js";

/**
 * Importing a plain folder of Markdown files as Documents: each file becomes a Document and each
 * folder one too, with what it holds under it, so the page tree mirrors the folders.
 */

/** A Document to create, with those to create under it. */
interface Page {
  title: string;
  body: string;
  children: Page[];
}

const MARKDOWN = /\.(md|markdown)$/i;
/** A folder's own page: its README or index file, whose Document the folder becomes. */
const FOLDER_PAGE = /^(readme|index)\.(md|markdown)$/i;

/**
 * Creates the Markdown files of `folder` as Documents at the top of `tree`, after those already
 * there, and returns the new Documents depth first. Files other than Markdown are skipped. A folder
 * holding only one folder is that folder's archive, so its contents go at the top. Run inside a transaction.
 */
export async function importMarkdownFolder(db: Queryable, tree: Tree, folder: Folder, actor: Actor, now: Date): Promise<TreeEntry[]> {
  const markdown = unwrapFolder(new Map([...folder].filter(([path]) => MARKDOWN.test(path))));
  const pages = pagesIn([...markdown.keys()].map((path) => ({ path, relative: path })), markdown);
  const created: TreeEntry[] = [];
  const create = async (page: Page, parentId: string | null, depth: number) => {
    const document = await insertDocument(db, { tree, parentId, title: page.title, body: page.body, actor, now });
    if (document === "no such parent") throw new Error("A Document just created vanished");
    created.push({ id: document.id, parentId, title: document.title, depth });
    for (const child of page.children) await create(child, document.id, depth + 1);
  };
  for (const page of pages) await create(page, null, 0);
  return created;
}

/** The pages of one folder's `entries` (paths relative to it), files and folders in natural name order. */
function pagesIn(entries: { path: string; relative: string }[], folder: Folder): Page[] {
  let files = entries.filter((e) => !e.relative.includes("/"));
  const folders = new Map<string, { path: string; relative: string }[]>();
  for (const e of entries.filter((e) => e.relative.includes("/"))) {
    const [name, ...rest] = e.relative.split("/");
    folders.set(name!, [...(folders.get(name!) ?? []), { path: e.path, relative: rest.join("/") }]);
  }
  const named: [name: string, page: Page][] = [];
  for (const [name, inside] of folders) {
    // A file named like the folder, such as `setup.md` beside `setup/`, is the folder's page if it has no README or index.
    const beside = files.find((e) => e.relative.replace(MARKDOWN, "") === name);
    const own = inside.find((e) => FOLDER_PAGE.test(e.relative)) ?? beside;
    if (own && own === beside) files = files.filter((e) => e !== beside);
    const rest = inside.filter((e) => e !== own);
    named.push([name, { ...(own ? page(own.path, folder, name) : { title: name, body: "" }), children: pagesIn(rest, folder) }]);
  }
  for (const e of files) {
    const name = e.relative.replace(MARKDOWN, "");
    named.push([name, page(e.path, folder, name)]);
  }
  return named.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })).map(([, p]) => p);
}

/**
 * The page of the Markdown file at `path`: titled by its frontmatter's `title`, else by a `#`
 * heading on its first line, else `fallback`. Frontmatter is left out of the body.
 */
function page(path: string, folder: Folder, fallback: string): Page {
  let parsed: ReturnType<typeof readFrontmatter>;
  try {
    parsed = readFrontmatter(folder.get(path)!.replace(/^﻿/, ""));
  } catch (err) {
    throw new HttpError(400, `${path} can't be read: ${(err as Error).message}`);
  }
  const fromFrontmatter = typeof parsed.data.title === "string" ? parsed.data.title.trim() : "";
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(parsed.body.split(/\r?\n/, 1)[0] ?? "")?.[1]?.trim() ?? "";
  const title = (fromFrontmatter || heading || fallback).slice(0, 500);
  return { title, body: parsed.body, children: [] };
}
