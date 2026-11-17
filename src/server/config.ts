import { resolve } from "node:path";
import type { AppConfig } from "./app.js";
import type { StorageConfig } from "./files/storage.js";
import { DEFAULT_IMPORT_MAX_BYTES } from "./portability/archive.js";

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
 * - `FILES_STORAGE` (default `disk`): where the files of Attachments and Artifacts are stored, `disk` or `s3` (any S3-compatible store).
 * - `FILES_DIR` (default `data/files`): with `disk`, the directory files are stored in, absolute or relative to the working directory.
 *   Keep it on a volume that outlives the server, like the database's.
 * - With `s3`: `S3_BUCKET` (required), `S3_ENDPOINT` (default: AWS S3 itself), `S3_REGION` (default `us-east-1`),
 *   `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (default: the AWS SDK's usual sources), and `S3_FORCE_PATH_STYLE`
 *   (default `true` with an `S3_ENDPOINT`, else `false`).
 * - `IMPORT_MAX_BYTES` (default 53687091200, 50 GiB): the most bytes one import of an export may write, to local disk
 *   while unpacking a zip archive and into the file store, before it is refused.
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
    storage: loadStorage(env),
    importMaxBytes: loadImportMaxBytes(env),
    artifactsUrl,
  };
}

function loadImportMaxBytes(env: NodeJS.ProcessEnv): number {
  const value = env.IMPORT_MAX_BYTES || undefined;
  if (value === undefined) return DEFAULT_IMPORT_MAX_BYTES;
  const bytes = /^[0-9]+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`IMPORT_MAX_BYTES must be a positive whole number of bytes, such as ${DEFAULT_IMPORT_MAX_BYTES} for 50 GiB, got "${value}"`);
  }
  return bytes;
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
