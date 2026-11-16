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
  /** Which section it is, the same across Versions for sections paired by `keyAgainstBase`; "" before the first heading. */
  key: string;
  heading: string | null;
  /** Its heading's level, 1 to 6; 0 for the text before the first heading. */
  level: number;
  text: string;
  /** Whether it ends its Version's body. */
  last: boolean;
}

/** `markdown` cut at every heading, always starting with the (perhaps empty) text before the first one; keys are left to `keyAgainstBase`. */
function chunksOf(markdown: string): Chunk[] {
  const headings = headingsOf(markdown);
  const chunks: Chunk[] = [{ key: "", heading: null, level: 0, text: markdown.slice(0, headings[0]?.start ?? markdown.length), last: headings.length === 0 }];
  headings.forEach((h, i) => {
    const end = headings[i + 1]?.start ?? markdown.length;
    chunks.push({ key: "", heading: headingLine(h), level: h.level, text: markdown.slice(h.start, end), last: i === headings.length - 1 });
  });
  return chunks;
}

/** The lines under a section's heading that say something, ignoring surrounding space. */
const contentLines = (chunk: Chunk) => chunk.text.split("\n").slice(chunk.heading === null ? 0 : 1).map((l) => l.trim()).filter((l) => l !== "");

/** How alike two sections' contents are, from 0 to 1: the share of their lines they have in common; two empty contents are alike. */
const similarity = (a: Chunk, b: Chunk) => linesAlike(contentLines(a), contentLines(b));

/** How alike two lists of lines are, from 0 to 1: the share of their lines they have in common; two empty lists are alike. */
function linesAlike(x: string[], y: string[]): number {
  if (x.length + y.length === 0) return 1;
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

/** How many sections a content line must appear in to count as boilerplate. */
const BOILERPLATE_SECTIONS = 3;

/** The content lines found in many of `chunks`' sections, such as `- [ ] TODO`: they tell no section apart. */
function boilerplateIn(chunks: Chunk[]): Set<string> {
  const sections = new Map<string, number>();
  for (const chunk of chunks.slice(1)) {
    for (const line of new Set(contentLines(chunk))) sections.set(line, (sections.get(line) ?? 0) + 1);
  }
  return new Set([...sections].filter(([, count]) => count >= BOILERPLATE_SECTIONS).map(([line]) => line));
}

/** How alike a renamed section's content must stay to still pair with the base section it came from. */
const RENAME_SIMILARITY = 0.5;

/**
 * How well a side's section pairs with a base section; 0 when they don't pair. A shared heading
 * pairs at least as well as any rename, and its content weighs double, so one section that kept its
 * content outscores two that only kept their headings.
 */
function pairScore(base: Chunk, side: Chunk, boilerplate: Set<string>): number {
  if (base.heading === side.heading) return 1 + 2 * similarity(base, side);
  // A renamed heading still pairs with the section it came from, if it had content that tells it
  // apart from other sections and most of that stayed.
  const distinct = (chunk: Chunk) => contentLines(chunk).filter((line) => !boilerplate.has(line));
  const [x, y] = [distinct(base), distinct(side)];
  const alike = linesAlike(x, y);
  return x.length > 0 && alike >= RENAME_SIMILARITY ? alike : 0;
}

/** One Version's sections while `keyAgainstBase` pairs them, and which of them are paired so far. */
interface PairingSide {
  chunks: Chunk[];
  /** Indexes into `chunks` already paired. The preamble (0) is never paired by a pass, whether or not the set holds it. */
  paired: Set<number>;
}

/** The state `keyAgainstBase` threads through its pairing passes. */
interface Pairing {
  base: PairingSide;
  side: PairingSide;
  /** scores[i][j]: how well `side.chunks[j]` pairs with `base.chunks[i]`, from `pairScore`. */
  scores: number[][];
}

/** Gives `side`'s section `j` the key of `base`'s section `i`, and marks both paired. */
function pair(p: Pairing, i: number, j: number): void {
  p.side.chunks[j]!.key = p.base.chunks[i]!.key;
  p.base.paired.add(i);
  p.side.paired.add(j);
}

/** The indexes of a side's sections not paired yet, in order, never the preamble. */
const unpaired = (s: PairingSide) => s.chunks.map((_, k) => k).filter((k) => k > 0 && !s.paired.has(k));

/** A side keyed against the base by content and heading, with what is left to key once the other side is too. */
interface SidePairing {
  /** The keys of the base sections this side still has. */
  kept: Set<string>;
  /** Keys this side's remaining sections, given the base sections the other side still has. */
  keyRest(keptByOther: Set<string>): void;
}

/**
 * Keys `base` by position, then keys each section of `side` after the base section it came from,
 * pass by pass, each pairing only what earlier passes left: `pairInOrder`, `pairMovedByHeading`,
 * then `pairMovedByRename`. Once the other side is keyed too, `keyRest` runs `pairEmptyBySlot`,
 * which needs to know which base sections the other side still has, then `keyAdded`.
 */
function keyAgainstBase(base: Chunk[], side: Chunk[]): SidePairing {
  base.forEach((c, i) => (c.key = i === 0 ? "" : `base\u0000${i}`));
  side[0]!.key = "";
  const boilerplate = boilerplateIn(base);
  const p: Pairing = {
    base: { chunks: base, paired: new Set() },
    side: { chunks: side, paired: new Set([0]) },
    scores: base.map((b) => side.map((c) => pairScore(b, c, boilerplate))),
  };
  pairInOrder(p);
  pairMovedByHeading(p);
  pairMovedByRename(p);
  const kept = new Set([...p.base.paired].map((i) => base[i]!.key));
  const keyRest = (keptByOther: Set<string>) => {
    pairEmptyBySlot(p, keptByOther);
    keyAdded(p.side);
  };
  return { kept, keyRest };
}

/** Pairs sections by the best-scoring alignment that keeps both sides' orders, preambles excluded. */
function pairInOrder(p: Pairing): void {
  const [n, m] = [p.base.chunks.length, p.side.chunks.length];
  // best[i][j]: the highest total score aligning base[i..] with side[j..], preambles excluded.
  const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 1; i--) {
    for (let j = m - 1; j >= 1; j--) {
      const score = p.scores[i]![j]!;
      best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, score > 0 ? score + best[i + 1]![j + 1]! : 0);
    }
  }
  for (let i = 1, j = 1; i < n && j < m; ) {
    const score = p.scores[i]![j]!;
    if (score > 0 && best[i]![j] === score + best[i + 1]![j + 1]!) {
      pair(p, i, j);
      i++;
      j++;
    } else if (best[i]![j] === best[i + 1]![j]) i++;
    else j++;
  }
}

/** Pairs a section moved elsewhere with the first unpaired base section of the same heading. */
function pairMovedByHeading(p: Pairing): void {
  for (const j of unpaired(p.side)) {
    const moved = unpaired(p.base).find((i) => p.base.chunks[i]!.heading === p.side.chunks[j]!.heading);
    if (moved !== undefined) pair(p, moved, j);
  }
}

/** Pairs a section both moved and renamed by its content, best-scoring pairs first. */
function pairMovedByRename(p: Pairing): void {
  const renames = unpaired(p.base)
    .flatMap((i) => unpaired(p.side).map((j) => ({ i, j, score: p.scores[i]![j]! })))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const { i, j } of renames) if (!p.base.paired.has(i) && !p.side.paired.has(j)) pair(p, i, j);
}

/**
 * Pairs a renamed empty section, which has no content to pair on, when it is the only empty section
 * of its level, on each side, between the same two paired sections. When the other side no longer
 * has that base section, it was removed (or replaced) there: the empty section is left to read as
 * added, not renamed.
 */
function pairEmptyBySlot(p: Pairing, keptByOther: Set<string>): void {
  const [emptyBase, emptySide] = [emptySlots(p.base), emptySlots(p.side)];
  for (const s of emptySide) {
    const [bases, sides] = [emptyBase.filter((b) => b.slot === s.slot), emptySide.filter((o) => o.slot === s.slot)];
    if (bases.length === 1 && sides.length === 1 && keptByOther.has(p.base.chunks[bases[0]!.k]!.key)) pair(p, bases[0]!.k, s.k);
  }
}

/** A side's unpaired empty sections, each with its slot: its level and the keys of the paired sections around it. */
function emptySlots(s: PairingSide): { k: number; slot: string }[] {
  const slot = (k: number) => {
    const before = [...s.paired].filter((q) => q < k).reduce((a, b) => Math.max(a, b), 0);
    const after = [...s.paired].filter((q) => q > k).reduce((a, b) => Math.min(a, b), Infinity);
    return `${s.chunks[k]!.level}\u0000${s.chunks[before]!.key}\u0000${s.chunks[after]?.key ?? "end"}`;
  };
  return unpaired(s)
    .filter((k) => contentLines(s.chunks[k]!).length === 0)
    .map((k) => ({ k, slot: slot(k) }));
}

/** Keys each section still unpaired as added, by its heading and how often it was added, so both sides adding the same section pair too. */
function keyAdded(s: PairingSide): void {
  const added = new Map<string, number>();
  s.chunks.forEach((chunk, j) => {
    if (s.paired.has(j)) return;
    const count = (added.get(chunk.heading!) ?? 0) + 1;
    added.set(chunk.heading!, count);
    chunk.key = `added\u0000${chunk.heading}\u0000${count}`;
  });
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

/** A section cut into its heading line (with its line break) and what follows it. */
function headAndRest(chunk: Chunk): { head: Chunk; rest: Chunk } {
  const cut = chunk.heading === null ? 0 : chunk.text.indexOf("\n") + 1 || chunk.text.length;
  return { head: { ...chunk, text: chunk.text.slice(0, cut) }, rest: { ...chunk, text: chunk.text.slice(cut) } };
}

/**
 * The three-way merge of one section: as `mergePart`, but when both sides changed it, its heading
 * line and its content merge apart, so a rename on one side and a content edit on the other combine.
 */
function mergeSection(base: Chunk | undefined, mine: Chunk | undefined, theirs: Chunk | undefined): { merged: Chunk | undefined } | "conflict" {
  const whole = mergePart(base, mine, theirs);
  if (whole !== "conflict" || !base || !mine || !theirs) return whole;
  const [b, m, t] = [base, mine, theirs].map(headAndRest) as [ReturnType<typeof headAndRest>, ReturnType<typeof headAndRest>, ReturnType<typeof headAndRest>];
  const head = mergePart(b.head, m.head, t.head);
  const rest = mergePart(b.rest, m.rest, t.rest);
  if (head === "conflict" || rest === "conflict") return "conflict";
  const [h, r] = [head.merged!, rest.merged!];
  return { merged: { key: base.key, heading: h.heading, level: h.level, text: h.text + r.text, last: r.last } };
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
  const { markdown: body, sections, conflicts } = mergeMarkdown(base.body, mine.body, theirs.body);
  return { title: title === "conflict" ? null : title.merged!.text, titleConflict, body, sections, conflicts: conflicts + (titleConflict ? 1 : 0) };
}

/** A merge of Markdown alone, such as Guidance. */
export interface MarkdownMerge {
  /** The merged Markdown; null while any section conflicts. */
  markdown: string | null;
  /** Its sections, in order; joined, the texts (with the chosen side of each conflict) make the Markdown. */
  sections: MergedSection[];
  /** How many sections conflict. */
  conflicts: number;
}

/** Three-way merges two edits of Markdown made from `base`, section by section, as `mergeEdits` merges a body. */
export function mergeMarkdown(base: string, mine: string, theirs: string): MarkdownMerge {
  const sections = mergeBodies(base, mine, theirs);
  const clean = sections.every((s) => s.text !== null);
  return { markdown: clean ? sections.map((s) => s.text).join("") : null, sections, conflicts: sections.filter((s) => s.conflict).length };
}

/** The sections of a three-way merge of bodies, in their merged order; see `mergeEdits`. */
function mergeBodies(base: string, mine: string, theirs: string): MergedSection[] {
  const [b, m, t] = [base, mine, theirs].map(chunksOf) as [Chunk[], Chunk[], Chunk[]];
  // A side's empty section reads as renamed only if the other side still has the base section it was.
  const [mineKeyed, theirsKeyed] = [keyAgainstBase(b, m), keyAgainstBase(b, t)];
  mineKeyed.keyRest(theirsKeyed.kept);
  theirsKeyed.keyRest(mineKeyed.kept);
  const order = mergedOrder(...([b, m, t].map((chunks) => chunks.map((c) => c.key)) as [string[], string[], string[]]));
  if (!order) return [{ heading: null, text: null, conflict: sectionConflict(base, mine, theirs) }];
  const find = (chunks: Chunk[], key: string) => chunks.find((c) => c.key === key);
  const merged: { heading: string | null; chunk?: Chunk; conflict?: { base?: Chunk; mine?: Chunk; theirs?: Chunk } }[] = [];
  for (const key of order) {
    const sides = { base: find(b, key), mine: find(m, key), theirs: find(t, key) };
    const heading = (sides.mine ?? sides.theirs ?? sides.base)!.heading;
    const part = mergeSection(sides.base, sides.mine, sides.theirs);
    if (part === "conflict") merged.push({ heading, conflict: sides });
    else if (part.merged && !(key === "" && part.merged.text === "")) merged.push({ heading: part.merged.heading, chunk: part.merged });
  }
  // A section that ended its Version's body may now have one after it: keep a blank line between them.
  // One that had a section after it may now end the body: end it with a single line break.
  const spaced = (chunk: Chunk | undefined, last: boolean) => {
    if (!chunk) return null;
    if (last) return chunk.last ? chunk.text : chunk.text.replace(/\n+$/, "\n");
    if (chunk.text.endsWith("\n\n") || (!chunk.last && chunk.text.endsWith("\n"))) return chunk.text;
    return chunk.text.replace(/\n?$/, "\n\n");
  };
  return merged.map((s, i) => {
    const last = i === merged.length - 1;
    if (s.chunk) return { heading: s.heading, text: spaced(s.chunk, last), conflict: null };
    const c = s.conflict!;
    return { heading: s.heading, text: null, conflict: sectionConflict(spaced(c.base, last), spaced(c.mine, last), spaced(c.theirs, last)) };
  });
}

/** Each side's value of a field both sides changed differently. */
export interface FieldConflict<T> {
  base: T;
  mine: T;
  theirs: T;
}

/** A merge of a Decision: its title and body as `mergeEdits` merges a Document's, and its group and superseded Decisions as whole fields. */
export interface DecisionMerge extends Merge {
  /** The merged group, null for none; also null when it conflicts. */
  group: string | null;
  /** Set when both sides changed the group differently. */
  groupConflict: FieldConflict<string | null> | null;
  /** The keys of the Decisions the merge supersedes, in order; null when they conflict. */
  supersedes: string[] | null;
  /** Set when both sides changed the superseded Decisions differently. */
  supersedesConflict: FieldConflict<string[]> | null;
}

/** What a Decision's edit holds that merges; `supersedes` are keys in order. */
export interface DecisionSide {
  title: string;
  body: string;
  group: string | null;
  supersedes: string[];
}

/** The three-way merge of a whole field: the side that changed it, or null and a conflict when both did, differently. */
function mergeField<T>(base: T, mine: T, theirs: T, same: (a: T, b: T) => boolean): { merged: T | null; conflict: FieldConflict<T> | null } {
  if (same(mine, theirs) || same(mine, base)) return { merged: theirs, conflict: null };
  if (same(theirs, base)) return { merged: mine, conflict: null };
  return { merged: null, conflict: { base, mine, theirs } };
}

/**
 * Three-way merges two edits of a Decision made from `base`: the title and body as `mergeEdits`
 * merges them, and the group and the superseded Decisions each as one field, taken from the side
 * that changed it, or a conflict when both did, differently.
 */
export function mergeDecisionEdits(base: DecisionSide, mine: DecisionSide, theirs: DecisionSide): DecisionMerge {
  const merge = mergeEdits(base, mine, theirs);
  const group = mergeField(base.group, mine.group, theirs.group, (a, b) => a === b);
  const supersedes = mergeField(base.supersedes, mine.supersedes, theirs.supersedes, (a, b) => a.join("\n") === b.join("\n"));
  return {
    ...merge,
    group: group.merged,
    groupConflict: group.conflict,
    supersedes: supersedes.merged,
    supersedesConflict: supersedes.conflict,
    conflicts: merge.conflicts + (group.conflict ? 1 : 0) + (supersedes.conflict ? 1 : 0),
  };
}
