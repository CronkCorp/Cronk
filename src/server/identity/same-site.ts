import type { FastifyInstance, FastifyRequest } from "fastify";
import { bearerToken, HttpError, SIGN_IN_COOKIE } from "../context.js";

/** Methods that only read, which a page of any site may send. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a route with `method` (or methods) changes anything, so another site's pages may not call it. */
export const isWrite = (method: string | string[]): boolean => [method].flat().some((m) => !READS.has(m));

/**
 * Refuses writes a browser sends from a page of another site, so a page elsewhere (an Artifact
 * on a subdomain included, ADR 0007) can't act with a signed-in User's cookie. A write's page is
 * its `Origin`, or its `Referer` when a browser sends no `Origin`; it must be Cronk's own: the
 * origin of `publicUrl` when configured, or else the host the request was sent to. A write naming
 * no page at all is a script's, refused only when it carries the sign-in cookie, as a browser
 * always names the page. Agents calling with a bearer token aren't browsers and are never refused.
 */
export function refuseWritesFromOtherSites(app: FastifyInstance, publicUrl: string | undefined): void {
  const own = publicUrl === undefined ? undefined : new URL(publicUrl).origin;
  app.addHook("onRequest", async (request) => {
    if (!isWrite(request.method) || bearerToken(request) !== undefined) return;
    const page = pageOf(request);
    if (page === undefined ? request.cookies[SIGN_IN_COOKIE] !== undefined : !isOwn(request, page, own)) {
      throw new HttpError(403, "This change was sent from a page on another site; make it from Cronk itself");
    }
  });
}

/** The page a request was sent from, as the browser names it: its `Origin` (`null` for a page it hides), else its `Referer`. */
const pageOf = (request: FastifyRequest): string | undefined => request.headers.origin ?? request.headers.referer;

/** Whether `page` is one of Cronk's own; a page that isn't a URL, as `null` for one the browser hides, isn't. */
function isOwn(request: FastifyRequest, page: string, own: string | undefined): boolean {
  if (!URL.canParse(page)) return false;
  const url = new URL(page);
  if (own !== undefined) return url.origin === own;
  // Read the host the request was sent to with the page's scheme, so a default port written out matches one left off,
  // and a proxy that ends HTTPS in front of Cronk still matches.
  const host = request.headers.host;
  return host !== undefined && URL.canParse(`${url.protocol}//${host}`) && new URL(`${url.protocol}//${host}`).host === url.host;
}
