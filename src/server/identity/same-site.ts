import type { FastifyInstance, FastifyRequest } from "fastify";
import { bearerToken, HttpError, isReading, SIGN_IN_COOKIE } from "../context.js";

const REFUSED = "This write was sent from another site; make it from Cronk itself";

/**
 * Refuses writes a browser sends from another site, so a site elsewhere (an Artifact on a subdomain
 * included, ADR 0007) can't act with a signed-in User's cookie. The site a write was sent from is its
 * `Origin`, or its `Referer` when a browser sends no `Origin`; it must be Cronk's own: `publicUrl`'s
 * origin when configured, or else the host the request was sent to. A write naming no site at all is
 * a script's, refused only when it carries the sign-in cookie, as a browser always names it. Agents
 * calling with a bearer token and no cookie aren't browsers and are never refused.
 */
export function refuseWritesFromOtherSites(app: FastifyInstance, publicUrl: string | undefined): void {
  const publicOrigin = publicUrl === undefined ? undefined : new URL(publicUrl).origin;
  app.addHook("onRequest", async (request) => {
    if (isReading(request.method)) return;
    const signedIn = request.cookies[SIGN_IN_COOKIE] !== undefined;
    if (!signedIn && bearerToken(request) !== undefined) return;
    const from = sentFrom(request);
    if (from === undefined) {
      if (signedIn) throw new HttpError(403, REFUSED);
      return;
    }
    if (!isCronk(request, from, publicOrigin)) throw new HttpError(403, REFUSED);
  });
}

/** The site a request was sent from, as the browser names it: its `Origin` (`null` for one it hides), else its `Referer`. */
const sentFrom = (request: FastifyRequest): string | undefined => request.headers.origin ?? request.headers.referer;

/** Whether `site` is Cronk's own; one that isn't a URL, as `null` for a site the browser hides, isn't. */
function isCronk(request: FastifyRequest, site: string, publicOrigin: string | undefined): boolean {
  const url = URL.parse(site);
  if (url === null) return false;
  if (publicOrigin !== undefined) return url.origin === publicOrigin;
  // Read the host the request was sent to with the site's scheme, so a default port written out matches one left off,
  // and a proxy that ends HTTPS in front of Cronk still matches.
  const host = request.headers.host;
  return host !== undefined && URL.parse(`${url.protocol}//${host}`)?.host === url.host;
}
