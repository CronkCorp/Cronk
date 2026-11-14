/**
 * Sections of a Document's Markdown, as addressed by their headings: a section is a heading
 * line and everything after it up to the next heading. Only ATX headings (`## Setup`) count;
 * lines inside fenced code blocks are never headings.
 */

/** One heading line of a Document. */
interface Heading {
  /** Where its line starts in the Markdown. */
  start: number;
  /** 1 to 6: the number of `#`. */
  level: number;
  /** Its text, without the `#` marks or surrounding spaces. */
  text: string;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The ATX headings of `markdown`, in order, skipping fenced code blocks. */
function headingsOf(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let fence: string | undefined;
  let start = 0;
  for (const line of markdown.split("\n")) {
    const opening = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (opening && opening[0] === fence[0] && opening.length >= fence.length && line.trim() === opening) fence = undefined;
    } else if (opening) {
      fence = opening;
    } else {
      const match = HEADING.exec(line.replace(/\r$/, ""));
      if (match) headings.push({ start, level: match[1]!.length, text: (match[2] ?? "").trim() });
    }
    start += line.length + 1;
  }
  return headings;
}

/** A heading as the API shows it, such as `## Setup`. */
const headingLine = (h: { level: number; text: string }) => `${"#".repeat(h.level)} ${h.text}`.trimEnd();

/** The heading lines of `markdown`, such as `## Setup`, in order. */
export const headingsIn = (markdown: string): string[] => headingsOf(markdown).map(headingLine);

/** Why a section can't be replaced. */
export type SectionRefusal = { refused: "no such section" } | { refused: "ambiguous"; matches: number };

/**
 * Replaces what sits under `heading` in `markdown` (its own subsections included, down to the next
 * heading of the same or a higher level) with `content`, keeping the heading line itself.
 * `heading` is the heading's text, optionally preceded by its `#` marks to pick a level.
 */
export function replaceSection(markdown: string, heading: string, content: string): string | SectionRefusal {
  const wanted = /^\s*(#{1,6})?\s*(.*?)\s*$/.exec(heading)!;
  const level = wanted[1]?.length;
  const text = wanted[2]!;
  const headings = headingsOf(markdown);
  const matches = headings.filter((h) => h.text === text && (level === undefined || h.level === level));
  if (matches.length === 0) return { refused: "no such section" };
  if (matches.length > 1) return { refused: "ambiguous", matches: matches.length };
  const target = matches[0]!;
  const lineEnd = markdown.indexOf("\n", target.start);
  const contentStart = lineEnd < 0 ? markdown.length : lineEnd + 1;
  const next = headings.find((h) => h.start > target.start && h.level <= target.level);
  const end = next?.start ?? markdown.length;
  const trimmed = content.replace(/^\s*\n/, "").trimEnd();
  const replacement = (trimmed ? `\n${trimmed}\n` : "") + (next ? "\n" : "");
  const before = markdown.slice(0, contentStart);
  return (lineEnd < 0 ? `${before}\n` : before) + replacement + markdown.slice(end);
}
