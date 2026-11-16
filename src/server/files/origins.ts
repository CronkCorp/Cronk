import { EXTRA_ORIGIN_USES } from "../../shared/values.js";
import { HttpError } from "../context.js";

/**
 * Origins an Artifact may load from: the Workspace's allow-list, which an Admin edits, and the extra origins a publish
 * declares for its Version. Each goes into the Version's content policy as written, so only bare origins are taken.
 */

/** A host name, or an IPv6 address in brackets: nothing a content policy reads as a wildcard, keyword or separator. */
const HOSTNAME = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/;

/** `value` as browsers write an origin (lower case, no trailing slash), if it is a bare http or https one; otherwise undefined. */
export function bareOrigin(value: string): string | undefined {
  if (/[\s;,'"*]/.test(value)) return undefined;
  const url = URL.parse(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || value.includes("?") || value.includes("#")) return undefined;
  if (!HOSTNAME.test(url.hostname)) return undefined;
  return url.origin;
}

/** `values` as bare origins, each once; otherwise a 400 naming `what` and the first that isn't one. */
export function bareOrigins(values: string[], what: string): string[] {
  const origins: string[] = [];
  for (const value of values) {
    const origin = bareOrigin(value);
    if (!origin) throw new HttpError(400, `${what} must be bare http or https origins, such as https://cdn.example, not "${value}"`);
    if (origins.includes(origin)) throw new HttpError(400, `${what} lists ${origin} more than once`);
    origins.push(origin);
  }
  return origins;
}

export type ExtraOriginUse = (typeof EXTRA_ORIGIN_USES)[number];

/** An origin a publish declared for its Version beyond the Workspace's allow-list: what the page loads from there, and why. */
export interface ExtraOrigin {
  origin: string;
  uses: ExtraOriginUse[];
  reason: string;
}

/** The most extra origins one publish may declare, and the longest reason for one. */
const MAX_EXTRA_ORIGINS = 20;
const MAX_REASON_LENGTH = 500;

/**
 * The extra origins a publish's `extraOrigins` parameter declares, a JSON list of `{origin, uses, reason}`; none
 * without it. Otherwise a 400 saying what is wrong.
 */
export function parseExtraOrigins(raw: string | undefined): ExtraOrigin[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  return extraOrigins(parsed, "extraOrigins");
}

/** `value` as a list of declared extra origins, or a 400 naming `where` and saying what is wrong. */
export function extraOrigins(value: unknown, where: string): ExtraOrigin[] {
  const refuse = (why: string): never => {
    throw new HttpError(400, `${where} ${why}`);
  };
  if (!Array.isArray(value)) return refuse('must be a JSON list such as [{"origin": "https://cdn.example", "uses": ["scripts"], "reason": "Draws the chart"}]');
  if (value.length > MAX_EXTRA_ORIGINS) refuse(`may declare at most ${MAX_EXTRA_ORIGINS} origins`);
  const extras: ExtraOrigin[] = [];
  for (const [i, item] of value.entries()) {
    const at = `[${i}]`;
    if (typeof item !== "object" || item === null) return refuse(`${at} must be an object with origin, uses and reason`);
    const { origin, uses, reason } = item as Record<string, unknown>;
    const bare = typeof origin === "string" ? bareOrigin(origin) : undefined;
    if (!bare) return refuse(`${at} origin must be a bare http or https origin, such as https://cdn.example`);
    if (extras.some((e) => e.origin === bare)) refuse(`declares ${bare} more than once`);
    if (!Array.isArray(uses) || uses.length === 0 || !uses.every((u) => (EXTRA_ORIGIN_USES as readonly unknown[]).includes(u))) {
      return refuse(`${at} uses must list what the page loads from ${bare}: ${EXTRA_ORIGIN_USES.join(", ")}`);
    }
    if (typeof reason !== "string" || reason.trim() === "") return refuse(`${at} reason must say why the page needs ${bare}`);
    if (reason.trim().length > MAX_REASON_LENGTH) refuse(`${at} reason must be at most ${MAX_REASON_LENGTH} characters`);
    extras.push({ origin: bare, uses: [...new Set(uses as ExtraOriginUse[])], reason: reason.trim() });
  }
  return extras;
}
