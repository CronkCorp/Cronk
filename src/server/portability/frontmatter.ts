import { parse, stringify } from "yaml";

/**
 * Markdown with YAML frontmatter: a `---` line, YAML, a `---` line, then the Markdown body.
 */

/** Splits a Markdown file into its frontmatter (empty if it has none) and body. Throws on frontmatter that isn't a YAML mapping. */
export function readFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: unknown = match[1]!.trim() === "" ? {} : parse(match[1]!);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("its frontmatter isn't a YAML mapping");
  return { data: data as Record<string, unknown>, body: text.slice(match[0].length) };
}

/** A Markdown file with `data` as its frontmatter, leaving out fields that are undefined. */
export function writeFrontmatter(data: Record<string, unknown>, body: string): string {
  const defined = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
  return `---\n${stringify(defined, { lineWidth: 0 })}---\n${body}`;
}
