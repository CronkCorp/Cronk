/**
 * Ties rendered Markdown text back to the source it was parsed from, character by character. A run of
 * rendered text can differ from its source: Markdown drops the `> ` or indentation that starts each
 * continued line, spaces before a line break, the backslash of an escape, and spells an entity such as
 * `&amp;` as the one character it stands for.
 */

/**
 * Where each rendered character's Markdown sits: `starts[k]` is where the Markdown of character `k`
 * starts (for `k` = length, where the run's Markdown ends), and `ends[k]` is where the Markdown of the
 * characters before `k` ends (for `k` = 0, where the run's Markdown starts). A selection that starts at
 * `k` reads from `starts[k]`; one that ends at `k` reads up to `ends[k]`.
 */
export interface SourceBounds {
  starts: number[];
  ends: number[];
}

const ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/y;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

let decoder: HTMLTextAreaElement | undefined;
/** The text an HTML character reference stands for, as the browser reads it. */
function decodeEntity(entity: string): string {
  decoder ??= document.createElement("textarea");
  decoder.innerHTML = entity;
  return decoder.value;
}

/**
 * How `value`, rendered from the Markdown in `source` from `from` to `to`, lines up with it, or nothing
 * if some character cannot be tied to the source for certain.
 */
export function alignToSource(value: string, source: string, from: number, to: number): SourceBounds | undefined {
  const starts: number[] = [];
  const ends: number[] = [from];
  // Two cursors: `shown` walks the rendered value, `at` the Markdown source.
  let at = from;
  let lineStart = false;
  for (let shown = 0; shown < value.length; ) {
    const want = value[shown]!;
    // The prefix of a continued line: `> ` in a blockquote, indentation in a list item.
    if (lineStart && at < to && source[at] !== want && " \t>".includes(source[at]!)) {
      at++;
      continue;
    }
    // Spaces at the end of a line, which Markdown drops before the line break.
    if (want === "\n" && (source[at] === " " || source[at] === "\t")) {
      at++;
      continue;
    }
    ENTITY.lastIndex = at;
    const entity = source[at] === "&" ? ENTITY.exec(source)?.[0] : undefined;
    // Something that only looks like an entity, as `&foo;`, reads as it is, so it is matched character by character.
    const decoded = entity && at + entity.length <= to ? decodeEntity(entity) : undefined;
    if (entity && decoded && decoded !== entity && value.startsWith(decoded, shown)) {
      for (let k = 0; k < decoded.length; k++) {
        starts.push(at);
        ends.push(at + entity.length);
      }
      at += entity.length;
      shown += decoded.length;
      lineStart = false;
      continue;
    }
    const escaped = source[at] === "\\" && source[at + 1] === want && ASCII_PUNCTUATION.test(want);
    if (!escaped && source[at] !== want) return undefined;
    const length = escaped ? 2 : 1;
    if (at + length > to) return undefined;
    starts.push(at);
    at += length;
    ends.push(at);
    lineStart = want === "\n";
    shown++;
  }
  if (at !== to) return undefined;
  starts.push(at);
  return { starts, ends };
}

/**
 * `bounds` written compactly for a run starting at `base` in the source: each change in how far its
 * characters sit from where they would if the run were its source, as `k:start:end` from character `k`
 * on, separated by spaces. Empty when the run is its source as it is.
 */
export function encodeBounds(bounds: SourceBounds, base: number): string {
  const breaks: string[] = [];
  let last = "0:0";
  for (let k = 0; k < bounds.starts.length; k++) {
    const shift = `${bounds.starts[k]! - base - k}:${bounds.ends[k]! - base - k}`;
    if (shift !== last) breaks.push(`${k}:${shift}`);
    last = shift;
  }
  return breaks.join(" ");
}

/** Where a selection starting (`"start"`) or ending (`"end"`) at character `k` of a run sits in the source. */
export function sourceAt(base: number, encoded: string | undefined, k: number, edge: "start" | "end"): number {
  let shift = 0;
  for (const entry of (encoded ?? "").split(" ").filter(Boolean)) {
    const [at, start, end] = entry.split(":").map(Number);
    if (at! > k) break;
    shift = edge === "start" ? start! : end!;
  }
  return base + k + shift;
}

/** A block that encloses a code block and puts a prefix before each of its lines, where the block starts in the source. */
export interface Container {
  kind: "blockquote" | "listItem";
  start: number;
}

/**
 * What each line inside a container starts with: a blockquote's `>` marker, or a run of spaces of known
 * width. A list item's first line holds its marker instead, which spans the same width (`firstLine` is
 * where that line starts); a fenced code block's lines lose `upTo` as many spaces as its fence is indented.
 */
type LinePrefix = { kind: "marker" } | { kind: "indent"; width: number; firstLine?: number; upTo?: boolean };

/** Whether the line in `source` ends at `at`. */
function lineEndsAt(source: string, at: number): boolean {
  return at === source.length || source[at] === "\n";
}

/**
 * Takes `prefixes` off the line starting at `at` in `source`, returning where the rest of the line starts,
 * or nothing if the line doesn't carry them as expected.
 */
function skipPrefixes(source: string, at: number, prefixes: LinePrefix[]): number | undefined {
  const lineStart = at;
  for (const prefix of prefixes) {
    if (prefix.kind === "indent") {
      if (prefix.firstLine === lineStart) {
        at += prefix.width;
        continue;
      }
      let spaces = 0;
      while (source[at + spaces] === " " && spaces < prefix.width) spaces++;
      // A blank line may be indented less than the rest.
      const blank = lineEndsAt(source, at + spaces);
      if (spaces < prefix.width && !blank && !prefix.upTo) return undefined;
      at += spaces;
      continue;
    }
    // A blockquote's marker: `>`, with up to three spaces before it and one optional space after.
    let spaces = 0;
    while (source[at] === " " && spaces < 3) {
      at++;
      spaces++;
    }
    if (source[at] !== ">") return undefined;
    at++;
    if (source[at] === " ") at++;
  }
  return at;
}

const FENCE = /^(?:```|~~~)$/;
const LIST_MARKER = /(?: {0,3})(?:[-+*]|[0-9]{1,9}[.)])/y;

/**
 * The prefix each line inside `containers`, outermost first, carries, or nothing if some container's
 * width can't be told for certain. A list item's lines are indented to where the content on its first
 * line starts, counted from past the prefixes of the containers around it.
 */
function linePrefixes(source: string, containers: Container[]): LinePrefix[] | undefined {
  const prefixes: LinePrefix[] = [];
  for (const container of containers) {
    if (container.kind === "blockquote") {
      prefixes.push({ kind: "marker" });
      continue;
    }
    const lineStart = source.lastIndexOf("\n", container.start - 1) + 1;
    const at = skipPrefixes(source, lineStart, prefixes);
    if (at === undefined) return undefined;
    LIST_MARKER.lastIndex = at;
    const marker = LIST_MARKER.exec(source);
    if (!marker) return undefined;
    const markerEnd = at + marker[0].length;
    let spaces = 0;
    while (source[markerEnd + spaces] === " ") spaces++;
    // A tab's width depends on its column, which is left to doubt.
    if (source[markerEnd + spaces] === "\t") return undefined;
    const blank = lineEndsAt(source, markerEnd + spaces);
    // Content that starts five or more spaces out, or on a later line, starts one space past the marker.
    const contentAt = blank || spaces >= 5 ? markerEnd + 1 : markerEnd + spaces;
    if (!blank && spaces === 0) return undefined;
    prefixes.push({ kind: "indent", width: contentAt - at, firstLine: lineStart });
  }
  return prefixes;
}

/**
 * How `value`, the text of the code block at `code` in `source`, lines up with its Markdown, or nothing if
 * some character cannot be tied to the source for certain. Each line of the code carries the prefix of
 * each container around it, outermost first, which is taken off by its known width; the rest of the
 * line, leading spaces included, is the code's own.
 */
export function alignCodeToSource(
  value: string,
  source: string,
  code: { start: number; end: number },
  containers: Container[],
): SourceBounds | undefined {
  const containerPrefixes = linePrefixes(source, containers);
  if (!containerPrefixes) return undefined;
  const codeLine = source.lastIndexOf("\n", code.start - 1) + 1;
  const codeAt = skipPrefixes(source, codeLine, containerPrefixes);
  if (codeAt === undefined || codeAt > code.start || source.slice(codeAt, code.start).trim()) return undefined;
  let prefixes: LinePrefix[];
  let at: number | undefined;
  if (FENCE.test(source.slice(code.start, code.start + 3))) {
    // The opening fence's line holds no code.
    const fenceEnd = source.indexOf("\n", code.start);
    if (fenceEnd < 0 || fenceEnd >= code.end) return undefined;
    prefixes = [...containerPrefixes, { kind: "indent", width: code.start - codeAt, upTo: true }];
    at = fenceEnd + 1;
  } else {
    // An indented code block starts at its first line, each line indented four spaces past its containers.
    prefixes = [...containerPrefixes, { kind: "indent", width: 4 }];
    at = codeLine;
  }
  // The rendered code ends in a line break of its own, which the source may not have before the block ends.
  const text = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (!text) return undefined;
  const starts: number[] = [];
  const ends: number[] = [];
  let lineStart = true;
  for (let shown = 0; shown < text.length; shown++) {
    if (lineStart) {
      at = skipPrefixes(source, at, prefixes);
      if (at === undefined) return undefined;
      lineStart = false;
    }
    if (shown === 0) ends.push(at);
    const want = text[shown]!;
    if (source[at] !== want || at >= code.end) return undefined;
    starts.push(at);
    at++;
    ends.push(at);
    lineStart = want === "\n";
  }
  if (text !== value) {
    starts.push(at);
    ends.push(at);
  }
  starts.push(at);
  return { starts, ends };
}
