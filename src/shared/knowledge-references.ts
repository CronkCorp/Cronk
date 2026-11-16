/**
 * How Markdown refers to Decisions and Terms, shared by the web client, which links the references,
 * and the server, which records what mentions each Decision and Term. Plain data only, as it ends up
 * in the web bundle. Like Ticket keys (ticket-references.ts), they count only in text outside code and links.
 */

/**
 * A Decision key such as `CRONK-D7`, or `D7` for a Workspace Decision, as it appears in prose: upper
 * case, as a whole word. The Project key, if any, is group 1 and the number group 2.
 */
export const DECISION_REFERENCE = /\b(?:([A-Z][A-Z0-9]{1,9})-)?D([1-9][0-9]{0,8})\b/g;

/** Letters, digits and `_`: what a whole-word match of a Term's name may not touch on either side. */
const WORD = String.raw`[\p{L}\p{N}_]`;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A Term's name as written, with any run of whitespace in it read as one space, for comparing what text names. */
export const normalName = (name: string) => name.trim().replace(/\s+/g, " ");

/**
 * A pattern matching any of `names` as a whole word with its exact capitalisation, a run of
 * whitespace standing for each space in it; the longest name wins where several start at one place.
 * Undefined when there are no names. Compare a match with `normalName`.
 */
export function termPattern(names: string[]): RegExp | undefined {
  const alternatives = [...new Set(names.map(normalName).filter((n) => n !== ""))]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.split(" ").map(escape).join(String.raw`\s+`));
  if (alternatives.length === 0) return undefined;
  return new RegExp(`(?<!${WORD})(?:${alternatives.join("|")})(?!${WORD})`, "gu");
}
