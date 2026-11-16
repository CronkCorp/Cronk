import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpError, type AppContext } from "../context.js";
import type { Queryable } from "../db/database.js";
import { getWorkspace } from "../workspace/workspaces.js";
import { artifactFileKey, artifactSigningKey, findArtifactAnywhere, findArtifactFile, findArtifactVersion } from "./artifacts.js";
import type { ExtraOrigin, ExtraOriginUse } from "./origins.js";

/**
 * The Artifact hostname (ADR 0007): where Artifacts' files are served, apart from Cronk's own hostname so code in them
 * can't act with a User's sign-in. Nothing there reads the sign-in cookie. A Version is served at an address Cronk hands
 * out to whoever may read the Artifact, signed and valid for a while, so the address alone lets a frame show it:
 * `/a/<artifact id>.<version>.<expiry>.<signature>/<path>`. Every file is served under a strict content policy: scripts,
 * styles and fonts only from the Artifact itself and the Workspace's allow-list, and no network requests, unless the
 * Version's publish declared extra origins and the Workspace allows them.
 */

/** Where Artifacts' files are served, on whichever hostname serves them. */
export const ARTIFACT_PATH = "/a/";

/** How long a frame address Cronk hands out stays valid. */
const FRAME_VALIDITY_MS = 12 * 60 * 60 * 1000;

/** The directive each use of a declared extra origin opens. */
const DIRECTIVE_OF: Record<ExtraOriginUse, string> = {
  scripts: "script-src",
  styles: "style-src",
  fonts: "font-src",
  images: "img-src",
  media: "media-src",
  connect: "connect-src",
};

/**
 * The content policy every Artifact file is served with. `sandbox` gives the page an origin of its own even when opened
 * outside Cronk's frame, so it can read no cookie or storage of any site, and `connect-src 'none'` stops its requests.
 * `own` is the origin serving the file, named beside `'self'`, which a sandboxed page's origin doesn't match in every
 * browser. Scripts, styles and fonts may also come from the Workspace's `allowed` origins, and each of the Version's
 * `extras` opens what it was declared for, requests included; none of them adds anything to the sandbox.
 */
export function artifactContentPolicy(own: string, cronk: string | undefined, allowed: string[], extras: ExtraOrigin[]): string {
  const declared = (directive: string) => extras.filter((e) => e.uses.some((u) => DIRECTIVE_OF[u] === directive)).map((e) => e.origin);
  const from = (directive: string, ...origins: string[]) => [directive, "'self'", own, ...new Set([...origins, ...declared(directive)])].join(" ");
  const requests = declared("connect-src");
  return [
    "default-src 'none'",
    `${from("script-src", ...allowed)} 'unsafe-inline' 'unsafe-eval'`,
    `${from("style-src", ...allowed)} 'unsafe-inline'`,
    `${from("font-src", ...allowed)} data:`,
    `${from("img-src")} data: blob:`,
    `${from("media-src")} data: blob:`,
    `connect-src ${requests.length > 0 ? requests.join(" ") : "'none'"}`,
    "form-action 'none'",
    "base-uri 'none'",
    ...(cronk ? [`frame-ancestors ${cronk}`] : []),
    // No popups either: a window it opened could carry data out to any site, where its own requests can't.
    "sandbox allow-scripts allow-modals allow-downloads",
  ].join("; ");
}

/** Cronk's own origin, as Users reach it: `publicUrl`'s, or else the host this request was sent to. */
export function cronkOrigin(ctx: AppContext, request: FastifyRequest): string {
  if (ctx.publicUrl) return new URL(ctx.publicUrl).origin;
  return new URL(`${request.protocol}://${request.headers.host ?? "localhost"}`).origin;
}

/** The origin Artifacts are served from: the Artifact hostname's, or Cronk's own when there is none. */
export const artifactOrigin = (ctx: AppContext, request: FastifyRequest): string =>
  ctx.artifactsUrl ? new URL(ctx.artifactsUrl).origin : cronkOrigin(ctx, request);

const sign = (key: string, payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

/** The address a frame shows Version `version` of the Artifact `artifactId` at, valid for 12 hours from `now`. */
export async function frameUrl(ctx: AppContext, request: FastifyRequest, db: Queryable, workspaceId: string, artifactId: string, version: number): Promise<string> {
  const expires = Math.floor((ctx.clock.now().getTime() + FRAME_VALIDITY_MS) / 1000);
  const payload = `${artifactId}.${version}.${expires}`;
  return `${artifactOrigin(ctx, request)}${ARTIFACT_PATH}${payload}.${sign(await artifactSigningKey(db, workspaceId), payload)}/`;
}

/**
 * The hostname of an address, without its port: a proxy may name the port it took a request on, and the Artifact
 * hostname never shares Cronk's hostname on another port, since browsers send cookies whatever the port.
 */
const hostnameOf = (address: string) => URL.parse(address)?.hostname.toLowerCase();

/**
 * Keeps the Artifact hostname apart: there, only Artifacts' files answer, and nothing else of Cronk's, its API and web
 * client included; on Cronk's own hostname, Artifacts' files don't, so they never run on Cronk's origin. Without an
 * Artifact hostname, Cronk's own serves them.
 */
export function keepArtifactHostApart(app: FastifyInstance, artifactsUrl: string | undefined): void {
  if (artifactsUrl === undefined) return;
  const artifactHost = hostnameOf(artifactsUrl);
  app.addHook("onRequest", async (request) => {
    const onArtifactHost = hostnameOf(`http://${request.headers.host ?? ""}`) === artifactHost;
    if (onArtifactHost !== request.url.startsWith(ARTIFACT_PATH)) throw new HttpError(404, "Not found");
  });
}

/** Serving Artifacts' files at the addresses `frameUrl` hands out. */
export function artifactHostRoutes(ctx: AppContext) {
  return async (app: FastifyInstance) => {
    app.get<{ Params: { token: string; "*": string } }>(`${ARTIFACT_PATH}:token/*`, { schema: { hide: true } }, async (request, reply) => {
      const served = await versionAt(ctx, request.params.token);
      const workspace = await getWorkspace(ctx.db, served.workspaceId);
      // Declared extras apply only while the Workspace allows them; turned off, every Version is served without its own.
      const extras = workspace.artifactExtraOriginsAllowed ? (await findArtifactVersion(ctx.db, served.artifactId, served.version))!.extraOrigins : [];
      const path = request.params["*"] === "" || request.params["*"].endsWith("/") ? `${request.params["*"]}index.html` : request.params["*"];
      const file = await findArtifactFile(ctx.db, served.artifactId, served.version, path);
      if (!file) throw new HttpError(404, "Not found");
      return reply
        .header("content-type", file.contentType)
        .header("content-length", file.size)
        .header(
          "content-security-policy",
          artifactContentPolicy(artifactOrigin(ctx, request), ctx.publicUrl && new URL(ctx.publicUrl).origin, workspace.artifactAllowedOrigins, extras),
        )
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("cache-control", "private, max-age=3600")
        .send(ctx.files.get(artifactFileKey(file.id)));
    });
    // A Version's own address without its closing slash, so its files' relative addresses resolve inside it.
    app.get<{ Params: { token: string } }>(`${ARTIFACT_PATH}:token`, { schema: { hide: true } }, async (request, reply) => {
      await versionAt(ctx, request.params.token);
      return reply.redirect(`${ARTIFACT_PATH}${request.params.token}/`);
    });
  };
}

/** The Version a frame address names, if Cronk signed it and it is still valid; otherwise a 404, as for any address that isn't one. */
async function versionAt(ctx: AppContext, token: string): Promise<{ artifactId: string; workspaceId: string; version: number }> {
  const notFound = new HttpError(404, "Not found");
  const match = /^([0-9a-f-]{36})\.([1-9][0-9]{0,8})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) throw notFound;
  const [, artifactId, version, expires, signature] = match as unknown as [string, string, string, string, string];
  const artifact = await findArtifactAnywhere(ctx.db, artifactId);
  if (!artifact || Number(version) > artifact.version) throw notFound;
  const expected = Buffer.from(sign(await artifactSigningKey(ctx.db, artifact.workspaceId), `${artifactId}.${version}.${expires}`));
  if (!timingSafeEqual(expected, Buffer.from(signature))) throw notFound;
  if (Number(expires) * 1000 < ctx.clock.now().getTime()) throw notFound;
  return { artifactId, workspaceId: artifact.workspaceId, version: Number(version) };
}
