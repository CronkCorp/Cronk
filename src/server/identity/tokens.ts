import { createHash, randomBytes } from "node:crypto";

/** A new secret token for a URL or cookie. Store only its `hashToken`. */
export const newToken = (): string => randomBytes(32).toString("base64url");

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
