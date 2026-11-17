/**
 * Scrubbing a Transcript's text on upload (ADR 0013): every known secret pattern is replaced before the text is stored, so the
 * originals never are. Best-effort: it catches the shapes below, not every secret a chat may hold.
 *
 * Scrubbing must be deterministic and leave its own replacements alone (scrubbing scrubbed text changes nothing), since a re-upload
 * is matched against the stored text by whether it continues it. No pattern matches an Agent Session id (a UUID), though the
 * route scans for those in the text as uploaded anyway.
 */

import { TOKEN_PREFIXES, type TokenKind } from "../identity/tokens.js";

/** Characters a token runs on with, so a match next to one is part of a longer word. */
const TOKEN_CHAR = "A-Za-z0-9_-";

/** A token of `body`, not part of a longer one. */
const token = (body: string) => new RegExp(`(?<![${TOKEN_CHAR}])(?:${body})(?![${TOKEN_CHAR}])`, "g");

/** Provider tokens by their published prefixes and shapes, each replaced with what it was. */
const PROVIDER_TOKENS: [RegExp, string][] = [
  [token("gh[pousr]_[A-Za-z0-9]{36,}"), "GitHub token"],
  [token("github_pat_[A-Za-z0-9_]{22,}"), "GitHub token"],
  [token("glpat-[A-Za-z0-9_-]{20,}"), "GitLab token"],
  [token("sk-ant-[A-Za-z0-9_-]{20,}"), "Anthropic key"],
  [token("sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}"), "OpenAI key"],
  [token("(?:AKIA|ASIA)[A-Z0-9]{16}"), "AWS access key"],
  [token("xox[abposr]-[A-Za-z0-9-]{10,}"), "Slack token"],
  [token("(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}"), "Stripe key"],
  [token("AIza[A-Za-z0-9_-]{35}"), "Google API key"],
  [token("npm_[A-Za-z0-9]{36}"), "npm token"],
  [token("eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"), "JWT"],
];

/** A private key block, PEM or PGP, through its end line, or to the end of the text when it has none (yet). */
const PRIVATE_KEY = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY\2-----|$)/g;

/**
 * The credentials of an `Authorization` header, as written in a request, a curl command or JSON, after its scheme if it has one.
 * Shell variables (`$TOKEN`) are left, as they aren't secrets, and so is what scrubbing already replaced and a scheme with no
 * credentials after it on its line. The scheme is matched atomically (`(?=(…))\2`), so a credential left alone can't make the
 * scheme word itself count as one.
 */
const AUTHORIZATION =
  /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?[ \t]*)(?=((?:bearer|basic|token|digest)[ \t]+|))\2(?![[$])(?!(?:bearer|basic|token|digest)\b)[^\s"'\\,;]+/gi;

/** A bearer credential outside an `Authorization` header. */
const BEARER = /\b(bearer[ \t]+)(?![[$])[A-Za-z0-9._~+/-]{16,}=*/gi;

/**
 * A secret of Cronk's own, by the prefix of its kind (`newToken`): the prefix, then 32 random bytes as base64url (43 characters,
 * any of them, digits or not).
 */
const CRONK_TOKEN_NAMES: Record<TokenKind, string> = {
  agentToken: "Cronk Agent Token",
  signIn: "Cronk sign-in",
  invitation: "Cronk invitation",
  passwordReset: "Cronk password reset",
};
const PREFIXED_CRONK_TOKENS = Object.entries(TOKEN_PREFIXES).map(
  ([kind, prefix]): [RegExp, string] => [token(`${prefix}[${TOKEN_CHAR}]{43}`), CRONK_TOKEN_NAMES[kind as TokenKind]],
);

/**
 * A secret of Cronk's own issued before secrets had a prefix: 43 characters of base64url and nothing more. Matched as a
 * 43-character word mixing digits, capitals and small letters, which a word or identifier of that length rarely does. Kept
 * while such secrets are still in use.
 */
const CRONK_TOKEN = token(`[${TOKEN_CHAR}]{43}`);
const looksRandom = (word: string) => /[0-9]/.test(word) && /[A-Z]/.test(word) && /[a-z]/.test(word);

/** `markdown` with every known secret pattern replaced by a note of what it was. */
export function scrubSecrets(markdown: string): string {
  let text = markdown.replace(PRIVATE_KEY, "[scrubbed: private key]");
  text = text.replace(AUTHORIZATION, "$1$2[scrubbed]").replace(BEARER, "$1[scrubbed]");
  for (const [pattern, kind] of [...PROVIDER_TOKENS, ...PREFIXED_CRONK_TOKENS]) text = text.replace(pattern, `[scrubbed: ${kind}]`);
  return text.replace(CRONK_TOKEN, (word) => (looksRandom(word) ? "[scrubbed: token]" : word));
}
