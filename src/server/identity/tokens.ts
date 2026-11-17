import { createHash, randomBytes } from "node:crypto";

/**
 * The prefix each kind of secret Cronk issues starts with, so people and secret scanners can tell one at a glance. Secrets
 * issued before prefixes are bare; they still work, as only a secret's hash is stored and looked up.
 */
export const TOKEN_PREFIXES = {
  agentToken: "cronk_at_",
  signIn: "cronk_si_",
  invitation: "cronk_inv_",
  passwordReset: "cronk_pr_",
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

/** A new secret of `kind`: its prefix, then 32 random bytes as base64url. Store only its `hashToken`. */
export const newToken = (kind: TokenKind): string => TOKEN_PREFIXES[kind] + randomBytes(32).toString("base64url");

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
