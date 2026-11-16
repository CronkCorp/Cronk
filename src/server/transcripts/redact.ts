import { createHash } from "node:crypto";

/**
 * Hand redactions of a Transcript (ADR 0013): its Owner names a passage, and every occurrence of it is replaced in the texts the
 * Transcript keeps and in every later upload of the chat. The passage itself is never stored, only enough to find it again: its
 * length, a rolling fingerprint and a SHA-256 digest. A fingerprint match is confirmed by the digest before anything is replaced.
 */

/** What a redacted passage becomes. */
export const REDACTED = "[redacted]";

/** A redaction as it is kept: what finds the passage again, without the passage. */
export interface Redaction {
  /** The passage's length, in UTF-16 code units. */
  length: number;
  /** Its rolling fingerprint (`fingerprintOf`). */
  fingerprint: number;
  /** Its SHA-256 digest, hex. */
  digest: string;
}

const BASE = 257;
const MOD = 1_000_000_007;

/** The rolling fingerprint of `text[from, from + length)`: a polynomial hash small enough to stay exact in a double. */
function fingerprintOf(text: string, from: number, length: number): number {
  let h = 0;
  for (let i = from; i < from + length; i++) h = (h * BASE + text.charCodeAt(i)) % MOD;
  return h;
}

/** The fingerprint `h` of a window moved one character on: `out` leaves it, weighing `lead`, and `incoming` joins it. */
const roll = (h: number, out: number, incoming: number, lead: number) => ((((h - ((out * lead) % MOD) + MOD) % MOD) * BASE) + incoming) % MOD;

const digestOf = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The redaction of `passage`. */
export const redactionOf = (passage: string): Redaction => ({
  length: passage.length,
  fingerprint: fingerprintOf(passage, 0, passage.length),
  digest: digestOf(passage),
});

/** Whether two redactions find the same passage. */
export const sameRedaction = (a: Redaction, b: Redaction): boolean => a.length === b.length && a.digest === b.digest;

/** `text` with every occurrence of the redaction's passage replaced, left to right and never overlapping, and whether there was one. */
export function applyRedaction(text: string, r: Redaction): { text: string; found: boolean } {
  const n = r.length;
  if (n === 0 || text.length < n) return { text, found: false };
  let lead = 1; // BASE^(n-1), the weight of the character leaving the window.
  for (let i = 1; i < n; i++) lead = (lead * BASE) % MOD;
  const parts: string[] = [];
  let kept = 0;
  let h = fingerprintOf(text, 0, n);
  for (let at = 0; ; at++) {
    if (at >= kept && h === r.fingerprint && digestOf(text.slice(at, at + n)) === r.digest) {
      parts.push(text.slice(kept, at), REDACTED);
      kept = at + n;
    }
    if (at + n >= text.length) break;
    h = roll(h, text.charCodeAt(at), text.charCodeAt(at + n), lead);
  }
  if (parts.length === 0) return { text, found: false };
  parts.push(text.slice(kept));
  return { text: parts.join(""), found: true };
}

/** `text` with each redaction applied in turn, in the order they were made, as each was first applied to what came before it. */
export const applyRedactions = (text: string, redactions: Redaction[]): string => redactions.reduce((t, r) => applyRedaction(t, r).text, text);
