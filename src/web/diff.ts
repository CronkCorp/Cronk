/** A line-by-line comparison of two texts, for showing what changed between Versions. Display only: no rule lives here. */

export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Beyond this many line pairs, the comparison shows the whole text as replaced rather than spend the time. */
const MAX_WORK = 4_000_000;

/** The lines of `after` against those of `before`: kept, added and removed, in order (a longest common subsequence). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  // Lines shared at the start and end need no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const head = a.slice(0, start).map((text): DiffLine => ({ kind: "same", text }));
  const tail = a.slice(a.length - end).map((text): DiffLine => ({ kind: "same", text }));
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  if (x.length * y.length > MAX_WORK) {
    return [...head, ...x.map((text): DiffLine => ({ kind: "removed", text })), ...y.map((text): DiffLine => ({ kind: "added", text })), ...tail];
  }
  // lcs[i][j]: the longest common subsequence of x[i..] and y[j..].
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      middle.push({ kind: "same", text: x[i]! });
      i++;
      j++;
    } else if (i < x.length && (j === y.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      middle.push({ kind: "removed", text: x[i++]! });
    } else {
      middle.push({ kind: "added", text: y[j++]! });
    }
  }
  return [...head, ...middle, ...tail];
}
