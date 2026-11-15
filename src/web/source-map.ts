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
  let j = from;
  let lineStart = false;
  for (let i = 0; i < value.length; ) {
    const want = value[i]!;
    // The prefix of a continued line: `> ` in a blockquote, indentation in a list item.
    if (lineStart && j < to && source[j] !== want && " \t>".includes(source[j]!)) {
      j++;
      continue;
    }
    // Spaces at the end of a line, which Markdown drops before the line break.
    if (want === "\n" && (source[j] === " " || source[j] === "\t")) {
      j++;
      continue;
    }
    ENTITY.lastIndex = j;
    const entity = source[j] === "&" ? ENTITY.exec(source)?.[0] : undefined;
    // Something that only looks like an entity, as `&foo;`, reads as it is, so it is matched character by character.
    const decoded = entity && j + entity.length <= to ? decodeEntity(entity) : undefined;
    if (entity && decoded && decoded !== entity && value.startsWith(decoded, i)) {
      for (let k = 0; k < decoded.length; k++) {
        starts.push(j);
        ends.push(j + entity.length);
      }
      j += entity.length;
      i += decoded.length;
      lineStart = false;
      continue;
    }
    const escaped = source[j] === "\\" && source[j + 1] === want && ASCII_PUNCTUATION.test(want);
    if (!escaped && source[j] !== want) return undefined;
    const length = escaped ? 2 : 1;
    if (j + length > to) return undefined;
    starts.push(j);
    j += length;
    ends.push(j);
    lineStart = want === "\n";
    i++;
  }
  if (j !== to) return undefined;
  starts.push(j);
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
