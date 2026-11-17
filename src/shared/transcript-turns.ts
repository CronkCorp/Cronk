/**
 * The turns of a Transcript's text, in the turn convention (ADR 0013): each `## User` or `## Assistant` heading outside a
 * fenced block starts one, numbered from 1 in order. Text before the first heading belongs to no turn.
 */

/** One turn: its number, who spoke, and its text, heading included. */
export interface Turn {
  n: number;
  role: "User" | "Assistant";
  text: string;
}

const HEADING = /^## (User|Assistant)[ \t]*$/;
/** A fence opening or closing a fenced block: three or more backticks or tildes, indented at most three spaces. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The turns of `markdown`, in order. */
export function turnsOf(markdown: string): Turn[] {
  const turns: Turn[] = [];
  let fence: string | undefined;
  let current: { role: Turn["role"]; lines: string[] } | undefined;
  const close = () => current && turns.push({ n: turns.length + 1, role: current.role, text: current.lines.join("\n") });
  for (const line of markdown.split("\n")) {
    const opening = FENCE.exec(line)?.[1];
    if (fence) {
      // A block closes on a fence of its own character, at least as long, with nothing after it.
      if (opening && opening[0] === fence[0] && opening.length >= fence.length && line.trim() === opening) fence = undefined;
    } else if (opening) {
      fence = opening;
    } else {
      const heading = HEADING.exec(line);
      if (heading) {
        close();
        current = { role: heading[1] as Turn["role"], lines: [] };
      }
    }
    current?.lines.push(line);
  }
  close();
  return turns;
}

/** Characters a key or id may run on with, so a match next to one is part of a longer word. */
const WORD_CHAR = /[A-Za-z0-9_-]/;

/** Whether `text` holds one of `words`, in any case, with no word character right before or after it. */
export function namesAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  for (const word of words.map((w) => w.toLowerCase())) {
    if (word === "") continue;
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + 1)) {
      const before = lower[at - 1];
      const after = lower[at + word.length];
      if ((before === undefined || !WORD_CHAR.test(before)) && (after === undefined || !WORD_CHAR.test(after))) return true;
    }
  }
  return false;
}

/** The number of the first of `turns` naming one of `words` (an item's key or id), or null when none does. */
export const firstTurnNaming = (turns: Turn[], words: string[]): number | null => turns.find((t) => namesAny(t.text, words))?.n ?? null;

/**
 * What a Transcript is called: the first line of its first User turn, shortened, or its client chat id when it has no such line.
 */
export function titleOf(turns: Turn[], chatId: string): string {
  const first = turns.find((t) => t.role === "User")?.text.split("\n").slice(1).find((l) => l.trim() !== "");
  if (!first) return chatId;
  const line = first.trim().replace(/^#+\s*/, "");
  return line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line;
}
