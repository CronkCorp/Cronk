import { resolve } from "node:path";
import type { AppConfig } from "./app.js";
import type { StorageConfig } from "./files/storage.js";

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
 * - `FILES_STORAGE` (default `disk`): where the files of Attachments are stored, `disk` or `s3` (any S3-compatible store).
 * - `FILES_DIR` (default `data/files`): with `disk`, the directory files are stored in, absolute or relative to the working directory.
 *   Keep it on a volume that outlives the server, like the database's.
 * - With `s3`: `S3_BUCKET` (required), `S3_ENDPOINT` (default: AWS S3 itself), `S3_REGION` (default `us-east-1`),
 *   `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (default: the AWS SDK's usual sources), and `S3_FORCE_PATH_STYLE`
 *   (default `true` with an `S3_ENDPOINT`, else `false`).
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
    storage: loadStorage(env),
  };
}

function loadStorage(env: NodeJS.ProcessEnv): StorageConfig {
  const kind = env.FILES_STORAGE || "disk";
  if (kind === "disk") return { kind, dir: resolve(env.FILES_DIR || "data/files") };
  if (kind !== "s3") throw new Error(`FILES_STORAGE must be "disk" or "s3", got "${kind}"`);
  const bucket = env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET is required when FILES_STORAGE is s3");
  const endpoint = env.S3_ENDPOINT || undefined;
  const accessKeyId = env.S3_ACCESS_KEY_ID || undefined;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY || undefined;
  if (!accessKeyId !== !secretAccessKey) {
    throw new Error("Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither to use the AWS SDK's usual credentials");
  }
  // Self-hosted stores such as MinIO answer only at `endpoint/bucket`; AWS S3 prefers `bucket.endpoint`.
  const pathStyle = env.S3_FORCE_PATH_STYLE || (endpoint ? "true" : "false");
  if (pathStyle !== "true" && pathStyle !== "false") throw new Error(`S3_FORCE_PATH_STYLE must be "true" or "false", got "${pathStyle}"`);
  return { kind, bucket, endpoint, region: env.S3_REGION || "us-east-1", accessKeyId, secretAccessKey, forcePathStyle: pathStyle === "true" };
}
