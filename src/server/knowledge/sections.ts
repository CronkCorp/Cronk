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
const headingsOf = (markdown: string): Heading[] => scan(markdown).headings;

/** The ATX headings of `markdown`, skipping fenced code blocks, and whether a code block is still open at its end. */
function scan(markdown: string): { headings: Heading[]; fenceOpen: boolean } {
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
  return { headings, fenceOpen: fence !== undefined };
}

/** A heading as the API shows it, such as `## Setup`. */
const headingLine = (h: { level: number; text: string }) => `${"#".repeat(h.level)} ${h.text}`.trimEnd();

/** The heading lines of `markdown`, such as `## Setup`, in order. */
export const headingsIn = (markdown: string): string[] => headingsOf(markdown).map(headingLine);

/** Why a section can't be replaced: no heading or several match, or the new body would end the section early or leave a code block open. */
export type SectionRefusal =
  | { refused: "no such section" }
  | { refused: "ambiguous"; matches: number }
  | { refused: "ends the section"; heading: string }
  | { refused: "open code block" };

/**
 * Replaces what sits under `heading` in `markdown` (its own subsections included, down to the next
 * heading of the same or a higher level) with `content`, keeping the heading line itself.
 * `heading` is the heading's text, optionally preceded by its `#` marks to pick a level.
 */
export function replaceSection(markdown: string, heading: string, content: string): string | SectionRefusal {
  const headings = headingsOf(markdown);
  // Heading text that itself starts with # (`#1 priority`) matches as it is; otherwise leading # marks pick a level.
  let matches = headings.filter((h) => h.text === heading.trim());
  if (matches.length === 0) {
    const wanted = /^\s*(#{1,6})?\s*(.*?)\s*$/.exec(heading)!;
    const level = wanted[1]?.length;
    matches = headings.filter((h) => h.text === wanted[2] && (level === undefined || h.level === level));
  }
  if (matches.length === 0) return { refused: "no such section" };
  if (matches.length > 1) return { refused: "ambiguous", matches: matches.length };
  const target = matches[0]!;
  const added = scan(content);
  if (added.fenceOpen) return { refused: "open code block" };
  const early = added.headings.find((h) => h.level <= target.level);
  if (early) return { refused: "ends the section", heading: headingLine(early) };
  const lineEnd = markdown.indexOf("\n", target.start);
  const contentStart = lineEnd < 0 ? markdown.length : lineEnd + 1;
  const next = headings.find((h) => h.start > target.start && h.level <= target.level);
  const end = next?.start ?? markdown.length;
  const trimmed = content.replace(/^\s*\n/, "").trimEnd();
  const replacement = (trimmed ? `\n${trimmed}\n` : "") + (next ? "\n" : "");
  const before = markdown.slice(0, contentStart);
  return (lineEnd < 0 ? `${before}\n` : before) + replacement + markdown.slice(end);
}

/** Each side's text of a part both sides changed differently; null where that side has no such part. */
export interface Conflict {
  base: string | null;
  mine: string | null;
  theirs: string | null;
  /** Mine followed by theirs, for a User who wants to keep both; a section heading they share appears once. */
  both: string;
}

/** A section conflict, with both sides kept one after the other under the heading they share. */
function sectionConflict(base: string | null, mine: string | null, theirs: string | null): Conflict {
  if (mine === null || theirs === null) return { base, mine, theirs, both: mine ?? theirs ?? "" };
  const [heading] = mine.split("\n", 1);
  const shared = base !== null && heading !== "" && theirs.startsWith(`${heading}\n`);
  const rest = shared ? theirs.slice(heading!.length + 1) : `\n${theirs}`;
  return { base, mine, theirs, both: mine.replace(/\n*$/, "\n") + rest };
}

/** A section of a merged body: its merged text, or the conflict a User must settle. */
export interface MergedSection {
  /** Its heading line, such as `## Setup`; null for the text before the first heading. */
  heading: string | null;
  /** The merged text, heading line included; null when it conflicts. */
  text: string | null;
  /** Set when both sides changed the section differently. */
  conflict: Conflict | null;
}

/** A section of one Version's body: everything from one heading line up to the next heading, of any level. */
interface Chunk {
  /** Which section it is, the same across Versions for sections paired by `pairedWithBase`; "" before the first heading. */
  key: string;
  heading: string | null;
  text: string;
  /** Whether it ends its Version's body. */
  last: boolean;
}

/** `markdown` cut at every heading, always starting with the (perhaps empty) text before the first one; keys are left to `pairedWithBase`. */
function chunksOf(markdown: string): Chunk[] {
  const headings = headingsOf(markdown);
  const chunks: Chunk[] = [{ key: "", heading: null, text: markdown.slice(0, headings[0]?.start ?? markdown.length), last: headings.length === 0 }];
  headings.forEach((h, i) => {
    const end = headings[i + 1]?.start ?? markdown.length;
    chunks.push({ key: "", heading: headingLine(h), text: markdown.slice(h.start, end), last: i === headings.length - 1 });
  });
  return chunks;
}

/** The lines under a section's heading that say something, ignoring surrounding space. */
const contentLines = (chunk: Chunk) => chunk.text.split("\n").slice(chunk.heading === null ? 0 : 1).map((l) => l.trim()).filter((l) => l !== "");

/** How alike two sections' contents are, from 0 to 1: the share of their lines they have in common. Empty contents are not alike. */
function similarity(a: Chunk, b: Chunk): number {
  const [x, y] = [contentLines(a), contentLines(b)];
  if (x.length + y.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const line of x) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of y) {
    const n = counts.get(line) ?? 0;
    if (n > 0) {
      common++;
      counts.set(line, n - 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

/** How well a side's section pairs with a base section: sharing the heading counts most, then alike content; 0 when they don't pair. */
function pairScore(base: Chunk, side: Chunk): number {
  if (base.heading === side.heading) return 2 + similarity(base, side);
  return 0;
}

/**
 * Keys `base` by position and each section of `side` after the base section it came from: first by
 * a best-scoring alignment that keeps both orders, then by heading among what is left (a section
 * moved elsewhere). Sections `side` added are keyed by their heading and how often it was added, so
 * both sides adding the same section pair too.
 */
function pairedWithBase(base: Chunk[], side: Chunk[]): void {
  base.forEach((c, i) => (c.key = i === 0 ? "" : `base\u0000${i}`));
  side[0]!.key = "";
  const [n, m] = [base.length, side.length];
  // best[i][j]: the highest total score aligning base[i..] with side[j..], preambles excluded.
  const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 1; i--) {
    for (let j = m - 1; j >= 1; j--) {
      const score = pairScore(base[i]!, side[j]!);
      best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, score > 0 ? score + best[i + 1]![j + 1]! : 0);
    }
  }
  const paired = new Set<number>();
  for (let i = 1, j = 1; i < n && j < m; ) {
    const score = pairScore(base[i]!, side[j]!);
    if (score > 0 && best[i]![j] === score + best[i + 1]![j + 1]!) {
      side[j]!.key = base[i]!.key;
      paired.add(i);
      i++;
      j++;
    } else if (best[i]![j] === best[i + 1]![j]) i++;
    else j++;
  }
  const added = new Map<string, number>();
  for (const chunk of side.slice(1)) {
    if (chunk.key !== "") continue;
    const moved = base.findIndex((b, i) => i > 0 && !paired.has(i) && b.heading === chunk.heading);
    if (moved > 0) {
      chunk.key = base[moved]!.key;
      paired.add(moved);
      continue;
    }
    const count = (added.get(chunk.heading!) ?? 0) + 1;
    added.set(chunk.heading!, count);
    chunk.key = `added\u0000${chunk.heading}\u0000${count}`;
  }
}

/** Whether two sides' texts say the same, ignoring trailing blank space; undefined (no such part) only equals undefined. */
const same = (a: string | undefined, b: string | undefined) => (a === undefined || b === undefined ? a === b : a.trimEnd() === b.trimEnd());

/** The three-way merge of one part: the side that changed it, or a conflict when both did, differently. */
function mergePart<T extends { text: string }>(base: T | undefined, mine: T | undefined, theirs: T | undefined): { merged: T | undefined } | "conflict" {
  if (same(mine?.text, theirs?.text)) return { merged: theirs ?? mine };
  if (same(mine?.text, base?.text)) return { merged: theirs };
  if (same(theirs?.text, base?.text)) return { merged: mine };
  return "conflict";
}

/** Whether `a` and `b` put the sections they share in the same order. */
function sameOrder(a: string[], b: string[]): boolean {
  const shared = (x: string[], y: string[]) => x.filter((k) => y.includes(k));
  return shared(a, b).join("\n") === shared(b, a).join("\n");
}

/**
 * The order of the merged sections: that of the side which rearranged them (theirs if neither did),
 * with each section only the other side or the base has put after the section it follows there.
 * Undefined when both sides rearranged them differently.
 */
function mergedOrder(base: string[], mine: string[], theirs: string[]): string[] | undefined {
  const [leader, follower] = sameOrder(mine, base) ? [theirs, mine] : sameOrder(theirs, base) || sameOrder(mine, theirs) ? [mine, theirs] : [];
  if (!leader || !follower) return undefined;
  const order = [...leader];
  for (const other of [follower, base]) {
    other.forEach((key, i) => {
      if (order.includes(key)) return;
      const before = other.slice(0, i).reverse().find((k) => order.includes(k));
      order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, key);
    });
  }
  return order;
}

/** A merge of a Document's title and body. */
export interface Merge {
  /** The merged title; null when it conflicts. */
  title: string | null;
  /** Set when both sides changed the title differently. */
  titleConflict: Conflict | null;
  /** The merged body; null while any section conflicts. */
  body: string | null;
  /** Its sections, in order; joined, the texts (with the chosen side of each conflict) make the body. */
  sections: MergedSection[];
  /** How many parts conflict, the title included. */
  conflicts: number;
}

/**
 * Three-way merges `mine` and `theirs`, both edited from `base`, section by section: a section only
 * one side changed takes that side's text, and a section both changed differently is a conflict.
 * Sections either side added or removed are added or removed; if both sides rearranged the sections
 * differently, the whole body is one conflict.
 */
export function mergeEdits(base: { title: string; body: string }, mine: { title: string; body: string }, theirs: { title: string; body: string }): Merge {
  const title = mergePart({ text: base.title }, { text: mine.title }, { text: theirs.title });
  const titleConflict = title === "conflict" ? { base: base.title, mine: mine.title, theirs: theirs.title, both: `${mine.title} ${theirs.title}` } : null;
  const sections = mergeBodies(base.body, mine.body, theirs.body);
  const conflicts = sections.filter((s) => s.conflict).length + (titleConflict ? 1 : 0);
  const clean = sections.every((s) => s.text !== null);
  return {
    title: title === "conflict" ? null : title.merged!.text,
    titleConflict,
    body: clean ? sections.map((s) => s.text).join("") : null,
    sections,
    conflicts,
  };
}

/** The sections of a three-way merge of bodies, in their merged order; see `mergeEdits`. */
function mergeBodies(base: string, mine: string, theirs: string): MergedSection[] {
  const [b, m, t] = [base, mine, theirs].map(chunksOf) as [Chunk[], Chunk[], Chunk[]];
  pairedWithBase(b, m);
  pairedWithBase(b, t);
  const order = mergedOrder(...([b, m, t].map((chunks) => chunks.map((c) => c.key)) as [string[], string[], string[]]));
  if (!order) return [{ heading: null, text: null, conflict: sectionConflict(base, mine, theirs) }];
  const find = (chunks: Chunk[], key: string) => chunks.find((c) => c.key === key);
  const merged: { heading: string | null; chunk?: Chunk; conflict?: { base?: Chunk; mine?: Chunk; theirs?: Chunk } }[] = [];
  for (const key of order) {
    const sides = { base: find(b, key), mine: find(m, key), theirs: find(t, key) };
    const heading = (sides.mine ?? sides.theirs ?? sides.base)!.heading;
    const part = mergePart(sides.base, sides.mine, sides.theirs);
    if (part === "conflict") merged.push({ heading, conflict: sides });
    else if (part.merged && !(key === "" && part.merged.text === "")) merged.push({ heading, chunk: part.merged });
  }
  // A section that ended its Version's body may now have one after it: keep a blank line between them.
  const spaced = (chunk: Chunk | undefined, last: boolean) => {
    if (!chunk) return null;
    if (last || chunk.text.endsWith("\n\n") || (!chunk.last && chunk.text.endsWith("\n"))) return chunk.text;
    return chunk.text.replace(/\n?$/, "\n\n");
  };
  return merged.map((s, i) => {
    const last = i === merged.length - 1;
    if (s.chunk) return { heading: s.heading, text: spaced(s.chunk, last), conflict: null };
    const c = s.conflict!;
    return { heading: s.heading, text: null, conflict: sectionConflict(spaced(c.base, last), spaced(c.mine, last), spaced(c.theirs, last)) };
  });
}
