import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { actingUser, type Actor } from "../actor.js";
import type { Queryable } from "../db/database.js";
import { canRead } from "../identity/access.js";
import { listApplicableTerms, listTerms, type StoredTerm } from "./terms.js";

/**
 * Hints for words a Term says to avoid: a save of text succeeds whatever it says, and its answer
 * lists each avoided word found in the prose it wrote, with the Term to use instead. Code spans,
 * code blocks, block quotes and raw HTML aren't prose, so words there don't count.
 */

/** One avoided word in a saved field, where it starts (counting lines and columns from 1), and the Term to use instead. */
export interface AvoidedWord {
  field: string;
  /** The word as written. */
  word: string;
  line: number;
  column: number;
  term: { id: string; name: string };
}

/** One text a save wrote: the request field it came from, and whether it is Markdown or plain text, such as a title. */
export interface SavedText {
  field: string;
  text: string;
  markdown: boolean;
}

/** A letter, mark, digit or `_`, in any script: what a word is made of. */
const WORD = String.raw`[\p{L}\p{M}\p{N}_]`;

/** Markdown nodes whose text is never prose: code, quotes of someone else, and raw HTML. */
const NOT_PROSE = new Set(["code", "inlineCode", "blockquote", "html"]);

/**
 * How a word to avoid is matched: as a whole word or phrase, ignoring case, with any run of white space
 * between its words. A note in parentheses after it, as in "Owner (reserved for Agents)", isn't part of it.
 */
function avoidPattern(avoid: string): RegExp | null {
  const words = avoid
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return null;
  const phrase = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(String.raw`\s+`);
  return new RegExp(String.raw`(?<!${WORD})${phrase}(?!${WORD})`, "giu");
}

/** The source ranges of a Markdown text's prose: its text nodes, outside code, quotes and HTML. */
function proseRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = [];
  const walk = (node: Nodes) => {
    if (NOT_PROSE.has(node.type)) return;
    if (node.type === "text" && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      ranges.push([node.position.start.offset, node.position.end.offset]);
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(fromMarkdown(markdown));
  return ranges;
}

/** Line and column, each from 1, of `offset` in `text`. */
function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart + 1 };
}

/** The avoided words of `terms` in `texts`, field by field in the order given, then by where they start. */
export function findAvoidedWords(terms: StoredTerm[], texts: SavedText[]): AvoidedWord[] {
  const patterns = terms.flatMap((term) =>
    term.avoid.flatMap((avoid) => {
      const pattern = avoidPattern(avoid);
      return pattern ? [{ pattern, term: { id: term.id, name: term.name } }] : [];
    }),
  );
  if (patterns.length === 0) return [];
  return texts.flatMap(({ field, text, markdown }) => {
    const found: (AvoidedWord & { offset: number })[] = [];
    for (const [start, end] of markdown ? proseRanges(text) : [[0, text.length] as [number, number]]) {
      const prose = text.slice(start, end);
      for (const { pattern, term } of patterns) {
        for (const match of prose.matchAll(pattern)) {
          const offset = start + match.index;
          found.push({ field, word: match[0], ...lineAndColumn(text, offset), term, offset });
        }
      }
    }
    return found.sort((a, b) => a.offset - b.offset || a.term.name.localeCompare(b.term.name)).map(({ offset: _, ...word }) => word);
  });
}

/**
 * The avoided words in what `actor` saved in a Project, or the Workspace when `projectId` is null, by
 * the Terms that apply there: a Project's own, and the Workspace's it doesn't replace if the actor can
 * read the Workspace.
 */
export async function avoidedWordsIn(db: Queryable, actor: Actor, projectId: string | null, texts: SavedText[]): Promise<AvoidedWord[]> {
  const written = texts.filter((t) => t.text.trim() !== "");
  if (written.length === 0) return [];
  const workspaceId = actingUser(actor).workspaceId;
  const terms =
    projectId === null
      ? await listTerms(db, { workspaceId, projectId: null })
      : await listApplicableTerms(db, { workspaceId, projectId }, await canRead(db, actor, null));
  return findAvoidedWords(terms, written);
}

/** The texts a save of a title and Markdown body wrote, leaving out those the request didn't send. */
export const titleAndBody = (input: { title?: string | undefined; body?: string | undefined }, bodyField = "body"): SavedText[] => [
  ...(input.title !== undefined ? [{ field: "title", text: input.title, markdown: false }] : []),
  ...(input.body !== undefined ? [{ field: bodyField, text: input.body, markdown: true }] : []),
];
