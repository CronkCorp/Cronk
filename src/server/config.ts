import { resolve } from "node:path";
import type { AppConfig } from "./app.js";

export interface ServerConfig extends AppConfig {
  host: string;
  port: number;
}

/**
 * Reads all configuration from environment variables. Nothing here assumes
 * Docker; the same variables work for a plain process on any host.
 *
 * - `DATABASE_URL` (required): Postgres connection string.
 * - `HOST` (default `0.0.0.0`) and `PORT` (default `3000`): where to listen.
 * - `COOKIE_SECURE` (default `false`): set to `true` when served over HTTPS.
 * - `PUBLIC_URL` (optional): the address Users reach Cronk at, such as `https://cronk.example`. Signed-in
 *   writes are taken only from this site; without it, from the host each request was sent to.
 * - `WEB_ROOT` (default: the built client next to the server, if present), absolute or relative to the working directory.
 * - `FILES_DIR` (default `data/files`): where the files of Attachments are stored, absolute or relative to the working directory.
 *   Keep it on a volume that outlives the server, like the database's.
 * - `ARTIFACTS_URL` (optional, recommended): the address of the hostname Artifacts are served from, such as
 *   `https://artifacts.cronk.example`, pointed at this same server; it needs `PUBLIC_URL` too. Without it, Artifacts are
 *   served from Cronk's own hostname in a stricter sandbox (ADR 0007).
 */
export function loadConfig(env: NodeJS.ProcessEnv, defaultWebRoot?: string): ServerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required, e.g. postgres://cronk:secret@localhost:5432/cronk");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, got "${env.PORT}"`);
  const cookieSecure = env.COOKIE_SECURE ?? "false";
  if (cookieSecure !== "true" && cookieSecure !== "false") throw new Error(`COOKIE_SECURE must be "true" or "false", got "${cookieSecure}"`);
  const publicUrl = env.PUBLIC_URL || undefined;
  if (publicUrl !== undefined && !/^https?:$/.test(URL.parse(publicUrl)?.protocol ?? "")) {
    throw new Error(`PUBLIC_URL must be an http or https address, such as https://cronk.example, got "${publicUrl}"`);
  }
  const artifactsUrl = env.ARTIFACTS_URL || undefined;
  if (artifactsUrl !== undefined) {
    const url = URL.parse(artifactsUrl);
    if (!url || !/^https?:$/.test(url.protocol) || url.pathname !== "/") {
      throw new Error(`ARTIFACTS_URL must be the http or https address of a hostname of its own, such as https://artifacts.cronk.example, got "${artifactsUrl}"`);
    }
    // Cronk's own address is what the Artifact hostname lets frame its pages, and what it must never share.
    if (publicUrl === undefined) throw new Error("Set PUBLIC_URL too when setting ARTIFACTS_URL, so Artifacts can be framed only by Cronk itself");
    if (new URL(publicUrl).hostname === url.hostname) {
      throw new Error("ARTIFACTS_URL must be a different hostname from PUBLIC_URL, not only another port, so Artifacts can't act as the signed-in User");
    }
  }
  return {
    databaseUrl,
    host: env.HOST ?? "0.0.0.0",
    port,
    cookieSecure: cookieSecure === "true",
    publicUrl,
    webRoot: env.WEB_ROOT ? resolve(env.WEB_ROOT) : defaultWebRoot,
    filesDir: resolve(env.FILES_DIR || "data/files"),
    artifactsUrl,
  };
}
