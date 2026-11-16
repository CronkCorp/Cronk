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
