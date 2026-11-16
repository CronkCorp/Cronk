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
  return {
    databaseUrl,
    host: env.HOST ?? "0.0.0.0",
    port,
    cookieSecure: cookieSecure === "true",
    publicUrl,
    webRoot: env.WEB_ROOT ? resolve(env.WEB_ROOT) : defaultWebRoot,
  };
}
